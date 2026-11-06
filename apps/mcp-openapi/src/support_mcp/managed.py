"""Authenticated multi-catalog adapter for operator-reviewed OpenAPI URL imports.

PostgreSQL in the TS service owns desired connections and approvals. This process
has a bounded disposable runtime cache, no database credentials and no Docker or
shell control. API/worker re-install exact immutable definitions after restart.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .managed_import import ID, Profiles, compile_limited, compile_review, connection_fingerprint, prepare, strict_json
from .managed_network import EgressFailure, safe_client
from .manifest import RESERVED_KEYS, fingerprint, verify
from .server import create_server

MAX_CONTROL_BYTES = 8_000_000
MAX_RUNTIMES = 64


class ManagedFailure(ValueError):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(ID.fullmatch(value)) and value not in {".", "..", *RESERVED_KEYS}


def identity(payload: dict) -> tuple[str, str, str, str]:
    business = payload.get("businessId")
    try:
        canonical_business = str(uuid.UUID(business)) if isinstance(business, str) else None
    except ValueError:
        canonical_business = None
    if canonical_business != business or canonical_business is None:
        raise ManagedFailure("invalid_business")
    integration, revision, digest = payload.get("integrationId"), payload.get("connectionRevision"), payload.get("manifestHash")
    if not valid_id(integration) or not isinstance(revision, str) or not re.fullmatch(r"[1-9][0-9]{0,14}", revision) or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ManagedFailure("invalid_runtime_identity")
    return business, integration, revision, digest


def runtime_path(key: tuple[str, str, str, str]) -> str:
    return "/managed/" + "/".join(key) + "/mcp"


@dataclass
class Runtime:
    key: tuple[str, str, str, str]
    definition_hash: str
    target_hash: str
    app: Any
    client: httpx.AsyncClient
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    closing: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    error: BaseException | None = None
    inflight: int = 0
    last_used: float = field(default_factory=time.monotonic)

    async def own_lifespan(self) -> None:
        # FastMCP's AnyIO task group must be entered and exited by this SAME
        # long-lived task, never the short-lived installation HTTP request.
        try:
            async with self.client:
                async with self.app.lifespan(self.app):
                    self.ready.set()
                    await self.closing.wait()
        except BaseException as error:
            self.error = error
            self.ready.set()
            if isinstance(error, asyncio.CancelledError):
                raise

    def status(self) -> dict:
        return {"ready": True, "manifestHash": self.key[3], "connectionRevision": self.key[2],
                "upstreamTargetFingerprint": self.target_hash, "mcpPath": runtime_path(self.key)}

    async def close(self) -> None:
        self.closing.set()
        if self.task:
            await self.task


class RuntimeManager:
    def __init__(self, profiles: Profiles, hosts: tuple[str, ...]):
        self.profiles, self.hosts = profiles, hosts
        self.items: dict[tuple[str, str, str, str], Runtime] = {}
        self.lock = asyncio.Lock()
        self.running = False

    @asynccontextmanager
    async def lifespan(self, _app: Starlette):
        self.running = True
        try:
            yield
        finally:
            self.running = False
            await asyncio.gather(*(item.close() for item in self.items.values()), return_exceptions=True)
            self.items.clear()

    async def install(self, payload: dict) -> dict:
        if set(payload) - {"businessId", "integrationId", "connectionRevision", "manifestHash", "manifest", "upstreamBaseUrl", "credentialProfileId", "upstreamTargetFingerprint"}:
            raise ManagedFailure("invalid_install_request")
        manifest = payload.get("manifest")
        if not isinstance(manifest, dict):
            raise ManagedFailure("invalid_manifest")
        verify(manifest)
        payload = {**payload, "manifestHash": payload.get("manifestHash", manifest["manifestHash"])}
        key = identity(payload)
        if manifest["manifestHash"] != key[3] or manifest["integrationId"] != key[1] or any(op["effect"] == "unknown" for op in manifest["operations"]):
            raise ManagedFailure("runtime_manifest_mismatch")
        profile = self.profiles.get(payload.get("credentialProfileId", "none"))
        base = self.profiles.base(profile.id, payload.get("upstreamBaseUrl"))
        target_hash = connection_fingerprint(base, profile)
        if payload.get("upstreamTargetFingerprint") != target_hash:
            raise ManagedFailure("runtime_target_mismatch")
        definition_hash = fingerprint({"manifest": manifest, "profile": profile.id, "target": target_hash})
        async with self.lock:
            if not self.running:
                raise ManagedFailure("runtime_not_started", 503)
            existing = self.items.get(key)
            if existing:
                if existing.definition_hash != definition_hash:
                    raise ManagedFailure("runtime_definition_conflict", 409)
                if existing.error or not existing.task or existing.task.done():
                    raise ManagedFailure("runtime_unavailable", 503)
                if not existing.ready.is_set():
                    raise ManagedFailure("runtime_starting", 503)
                existing.last_used = time.monotonic()
                return existing.status()
            if len(self.items) >= MAX_RUNTIMES:
                unused = [item for item in self.items.values() if item.inflight == 0]
                if not unused:
                    raise ManagedFailure("runtime_capacity", 503)
                oldest = min(unused, key=lambda item: item.last_used)
                self.items.pop(oldest.key)
                await oldest.close()
            client = safe_client(base, profile)
            server = create_server(manifest, client, connection_revision=key[2], principal_id=profile.principal_id,
                                   bound_business_id=key[0])
            app = server.http_app(path="/mcp", json_response=True, stateless_http=True,
                                  host_origin_protection=True, allowed_hosts=list(self.hosts))
            item = Runtime(key, definition_hash, target_hash, app, client)
            item.task = asyncio.create_task(item.own_lifespan())
            self.items[key] = item
            await item.ready.wait()
            if item.error:
                self.items.pop(key)
                await item.close()
                raise ManagedFailure("runtime_start_failed", 503)
            return item.status()


class DynamicMcp:
    def __init__(self, manager: RuntimeManager):
        self.manager = manager

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        try:
            key = identity(scope["path_params"])
            async with self.manager.lock:
                item = self.manager.items.get(key)
                if not item or not item.ready.is_set() or item.error or not item.task or item.task.done():
                    raise ManagedFailure("runtime_missing", 404)
                item.inflight += 1
                item.last_used = time.monotonic()
            try:
                # A fixed /mcp child sees only its own immutable namespace.
                child = {**scope, "path": "/mcp", "raw_path": b"/mcp",
                         "root_path": scope.get("root_path", "") + runtime_path(key).removesuffix("/mcp")}
                await item.app(child, receive, send)
            finally:
                async with self.manager.lock:
                    item.inflight -= 1
        except ManagedFailure as error:
            await JSONResponse({"code": error.code}, status_code=error.status)(scope, receive, send)


class ManagementAuth:
    def __init__(self, app: Any, token: str):
        self.app, self.expected = app, f"Bearer {token}".encode("ascii")

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope.get("path") == "/health":
            await self.app(scope, receive, send)
            return
        supplied = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
        if len(supplied) != 1 or not hmac.compare_digest(supplied[0], self.expected):
            await JSONResponse({"code": "service_auth_required"}, status_code=401)(scope, receive, send)
            return
        await self.app(scope, receive, send)


def create_managed_app(env: dict[str, str]) -> Any:
    token = env.get("MANAGED_MCP_TOKEN", "")
    if not 24 <= len(token) <= 4096 or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise ValueError("MANAGED_MCP_TOKEN needs a private service credential")
    profiles = Profiles(env)
    hosts = tuple(value.strip() for value in env.get("MANAGED_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if value.strip())
    if not hosts or any(not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", host) for host in hosts):
        raise ValueError("Invalid managed MCP allowed hosts")
    manager = RuntimeManager(profiles, hosts)

    async def body(request: Request) -> dict:
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ManagedFailure("json_required", 415)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_CONTROL_BYTES:
                raise ManagedFailure("request_too_large", 413)
        result = strict_json(bytes(data))
        if not isinstance(result, dict):
            raise ManagedFailure("object_required")
        return result

    async def control(request: Request) -> JSONResponse:
        try:
            action = request.path_params["action"]
            if request.method == "GET" and action == "capabilities":
                return JSONResponse(profiles.capabilities())
            if request.method != "POST":
                return JSONResponse({"code": "method_not_allowed"}, status_code=405)
            payload = await body(request)
            if action == "prepare":
                if not valid_id(payload.get("integrationId")):
                    raise ManagedFailure("invalid_integration_id")
                result = await prepare(payload, profiles)
            elif action == "compile":
                if not valid_id(payload.get("integrationId")):
                    raise ManagedFailure("invalid_integration_id")
                result = await asyncio.to_thread(compile_limited, compile_review, payload, profiles)
            elif action == "install":
                result = await manager.install(payload)
            elif action == "status":
                item = manager.items.get(identity(payload))
                if not item or not item.ready.is_set() or item.error or not item.task or item.task.done():
                    raise ManagedFailure("runtime_missing", 404)
                result = item.status()
            else:
                raise ManagedFailure("not_found", 404)
            return JSONResponse(result)
        except ManagedFailure as error:
            return JSONResponse({"code": error.code}, status_code=error.status)
        except EgressFailure as error:
            return JSONResponse({"code": error.code}, status_code=422)
        except httpx.HTTPError:
            return JSONResponse({"code": "upstream_unavailable"}, status_code=502)
        except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
            # Never expose an upstream response, secret reference or submitted
            # specification in transport/parser errors.
            return JSONResponse({"code": "invalid_openapi_or_review"}, status_code=422)

    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "mode": "managed", "runtimes": len(manager.items)})

    app = Starlette(routes=[Route("/health", health), Route("/control/{action}", control, methods=["GET", "POST"]),
                            Route("/managed/{businessId}/{integrationId}/{connectionRevision}/{manifestHash}/mcp", DynamicMcp(manager))],
                    lifespan=manager.lifespan)
    app.state.managed = manager
    return ManagementAuth(app, token)


def main() -> None:
    try:
        app = create_managed_app(dict(os.environ))
        port = int(os.environ.get("PORT", "8000"))
        if not 0 < port < 65536:
            raise ValueError("Invalid port")
    except (ValueError, TypeError, KeyError):
        print("Managed MCP configuration invalid; verify deployment service/profile settings.", file=sys.stderr)
        raise SystemExit(1) from None
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=port, proxy_headers=False, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
