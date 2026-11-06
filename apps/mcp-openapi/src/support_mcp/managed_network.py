"""Bounded managed-connector egress. No redirects, proxies or second DNS lookup."""
from __future__ import annotations

import asyncio
import http.client
import ipaddress
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx


class EgressFailure(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def normalize_url(raw: str, *, base: bool = False, allow_query: bool = False) -> str:
    if not isinstance(raw, str) or len(raw) > 2000 or any(ord(c) < 33 or ord(c) == 127 for c in raw):
        raise EgressFailure("invalid_url")
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or (parsed.query and not allow_query) or parsed.fragment:
            raise EgressFailure("invalid_url")
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if "%" in host or "\\" in raw or not host:
            raise EgressFailure("invalid_url")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if parsed.scheme == "https" else 80):
            authority += f":{port}"
        path = parsed.path or "/"
        if base:
            path = path.rstrip("/")
        return urlunsplit((parsed.scheme, authority, path, parsed.query if allow_query else "", ""))
    except (UnicodeError, ValueError) as error:
        if isinstance(error, EgressFailure):
            raise
        raise EgressFailure("invalid_url") from None


def origin(raw: str) -> str:
    parsed = urlsplit(normalize_url(raw, allow_query=True))
    return f"{parsed.scheme}://{parsed.netloc}"


def public_address(raw: str) -> bool:
    try:
        address = ipaddress.ip_address(raw)
        if isinstance(address, ipaddress.IPv6Address) and (address.sixtofour or address.teredo or
                address in ipaddress.ip_network("64:ff9b::/96") or address in ipaddress.ip_network("64:ff9b:1::/48")):
            return False
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_global and not any((address.is_multicast, address.is_reserved, address.is_unspecified,
                                               address.is_loopback, address.is_link_local))
    except ValueError:
        return False


@dataclass(frozen=True)
class EgressProfile:
    id: str
    name: str
    principal_id: str
    token: str | None = None
    allowed_origins: tuple[str, ...] = ()
    private_origins: tuple[str, ...] = ()

    def check(self, raw: str, *, base: bool = False, allow_query: bool = False) -> str:
        url = normalize_url(raw, base=base, allow_query=allow_query)
        destination = origin(url)
        if self.allowed_origins and destination not in self.allowed_origins:
            raise EgressFailure("profile_origin_mismatch")
        if self.token and not self.allowed_origins:
            raise EgressFailure("profile_origin_mismatch")
        if urlsplit(url).scheme != "https" and destination not in self.private_origins:
            raise EgressFailure("https_required")
        try:
            literal = ipaddress.ip_address(urlsplit(url).hostname or "")
        except ValueError:
            literal = None
        if literal is not None and not self.permits_address(url, str(literal)):
            raise EgressFailure("address_blocked")
        return url

    def permits_address(self, url: str, address: str) -> bool:
        if public_address(address):
            return True
        if origin(url) not in self.private_origins:
            return False
        # A private exception is an exact deployment-owned literal address, never
        # a DNS hostname which could rebind into another private service.
        try:
            expected = ipaddress.ip_address(urlsplit(url).hostname or "")
            actual = ipaddress.ip_address(address)
            return expected == actual and not any((actual.is_link_local, actual.is_multicast, actual.is_unspecified))
        except ValueError:
            return False


class _Budget:
    def __init__(self, timeout: float):
        self.deadline = time.monotonic() + timeout
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.sockets: list[socket.socket] = []
        self.timer = threading.Timer(timeout, self.cancel)
        self.timer.daemon = True
        self.timer.start()

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if self.cancelled.is_set() or remaining <= 0:
            raise TimeoutError("Managed connector deadline reached")
        return remaining

    def attach(self, connection: socket.socket) -> None:
        with self.lock:
            if self.cancelled.is_set():
                connection.close()
                raise TimeoutError("Managed connector cancelled")
            self.sockets.append(connection)
            connection.settimeout(self.remaining())

    def cancel(self) -> None:
        self.cancelled.set()
        with self.lock:
            for connection in self.sockets:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()

    def finish(self) -> None:
        self.timer.cancel()
        self.cancel()


class _PinnedConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, url: str, profile: EgressProfile, budget: _Budget, secure: bool):
        super().__init__(host, port, timeout=budget.remaining())
        self.profile, self.target, self.budget, self.secure = profile, url, budget, secure

    def connect(self) -> None:
        self.budget.remaining()
        addresses = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        self.budget.remaining()  # A cancelled DNS thread must never connect later.
        if not addresses or len(addresses) > 32 or any(not self.profile.permits_address(self.target, item[4][0]) for item in addresses):
            raise EgressFailure("address_blocked")
        family, kind, protocol, _, address = addresses[0]
        stream = socket.socket(family, kind, protocol)
        self.budget.attach(stream)
        stream.connect(address)  # Numeric sockaddr; no hostname re-resolution.
        if self.secure:
            stream = ssl.create_default_context().wrap_socket(stream, server_hostname=self.host, do_handshake_on_connect=False)
            self.budget.attach(stream)
            stream.do_handshake()
        self.budget.remaining()
        self.sock = stream


_WORKERS = threading.BoundedSemaphore(4)


class PinnedTransport(httpx.AsyncBaseTransport):
    def __init__(self, profile: EgressProfile, *, timeout: float = 4.0, max_bytes: int = 131_072):
        self.profile, self.timeout, self.max_bytes = profile, timeout, max_bytes

    def _request(self, request: httpx.Request, body: bytes, budget: _Budget) -> tuple[int, list[tuple[str, str]], bytes]:
        if not _WORKERS.acquire(blocking=False):
            budget.finish()
            raise EgressFailure("egress_busy")
        connection: _PinnedConnection | None = None
        response: http.client.HTTPResponse | None = None
        try:
            url = self.profile.check(str(request.url), allow_query=True)
            target = urlsplit(url)
            port = target.port or (443 if target.scheme == "https" else 80)
            connection = _PinnedConnection(target.hostname or "", port, url, self.profile, budget, target.scheme == "https")
            headers = {key: value for key, value in request.headers.items()
                       if key.lower() not in ("host", "connection", "accept-encoding", "proxy-authorization", "proxy-connection", "transfer-encoding", "content-length")}
            headers.update({"Host": target.netloc, "Accept-Encoding": "identity", "Connection": "close"})
            if body:
                headers["Content-Length"] = str(len(body))
            budget.remaining()
            connection.connect()
            budget.remaining()
            path = (target.path or "/") + (f"?{target.query}" if target.query else "")
            connection.request(request.method, path, body=body or None, headers=headers)
            response = connection.getresponse()
            budget.remaining()
            response_headers = response.getheaders()
            if sum(len(key) + len(value) for key, value in response_headers) > 32_768:
                raise EgressFailure("response_headers_too_large")
            if response.getheader("Content-Encoding", "identity").lower() not in ("identity", ""):
                raise EgressFailure("encoded_response_refused")
            length = response.getheader("Content-Length")
            if length and (not length.isdecimal() or int(length) > self.max_bytes):
                raise EgressFailure("response_too_large")
            data = response.read(self.max_bytes + 1)
            budget.remaining()
            if len(data) > self.max_bytes:
                raise EgressFailure("response_too_large")
            return response.status, response_headers, data
        finally:
            if response:
                response.close()
            if connection:
                connection.close()
            budget.finish()
            _WORKERS.release()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.profile.check(str(request.url), allow_query=True)
        body = await request.aread()
        if len(body) > 131_072:
            raise httpx.RequestError("Managed request exceeds its limit", request=request)
        budget = _Budget(self.timeout)
        task = asyncio.create_task(asyncio.to_thread(self._request, request, body, budget))
        try:
            status, headers, content = await asyncio.wait_for(asyncio.shield(task), timeout=self.timeout + 0.1)
            return httpx.Response(status, headers=headers, content=content, request=request)
        except asyncio.CancelledError:
            budget.finish()
            task.add_done_callback(_consume)
            raise
        except (TimeoutError, socket.timeout):
            budget.finish()
            task.add_done_callback(_consume)
            raise httpx.ReadTimeout("Managed connector timed out", request=request) from None
        except (OSError, http.client.HTTPException, EgressFailure) as error:
            budget.finish()
            code = error.code if isinstance(error, EgressFailure) else "connection_unavailable"
            raise httpx.ConnectError(code, request=request) from None


def _consume(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()


def safe_client(base_url: str, profile: EgressProfile, *, timeout: float = 4.0, max_bytes: int = 131_072) -> httpx.AsyncClient:
    base = profile.check(base_url, base=True)
    headers = {"Accept": "application/json"}
    if profile.token:
        headers["Authorization"] = f"Bearer {profile.token}"
    return httpx.AsyncClient(base_url=base, headers=headers, transport=PinnedTransport(profile, timeout=timeout, max_bytes=max_bytes),
                             follow_redirects=False, trust_env=False, timeout=timeout)
