import asyncio
import json
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

import httpx

from support_mcp.managed_network import EgressFailure, EgressProfile, _Budget, _PinnedConnection, normalize_url, public_address, safe_client


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.seen.append((self.path, dict(self.headers)))
        self.send_response(302 if self.path == "/redirect" else 200)
        if self.path == "/redirect":
            self.send_header("Location", "/target")
        if self.path == "/encoded":
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", "1000000" if self.path == "/huge" else "2")
        self.end_headers()
        if self.path == "/slow":
            time.sleep(0.5)
        try:
            self.wfile.write(b"{}")
        except (OSError, ConnectionError):
            pass


class ManagedNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.profile = EgressProfile("lab", "Lab", "lab", "synthetic-secret", (cls.base,), (cls.base,))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_urls_and_private_exceptions_are_explicit_and_bounded(self):
        public = EgressProfile("none", "Public", "public")
        for value in ("https://169.254.169.254/latest", "https://127.0.0.1", "https://[::1]", "http://example.com", "https://user:pass@example.com", "https://example.com/?key=secret", "https://example.com/#x", "https://example.com/\\x"):
            with self.subTest(value=value), self.assertRaises(EgressFailure):
                public.check(value)
        self.assertEqual(normalize_url("https://EXAMPLE.com:443/api/", base=True), "https://example.com/api")
        self.assertEqual(self.profile.check(self.base), self.base + "/")
        with self.assertRaises(EgressFailure):
            self.profile.check("http://127.0.0.1:1")
        for value in ("169.254.169.254", "127.0.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "224.0.0.1", "0.0.0.0", "192.168.1.1"):
            self.assertFalse(public_address(value), value)
        self.assertTrue(public_address("8.8.8.8"))

    def test_real_requests_preserve_query_host_and_profile_bearer_without_proxies(self):
        async def run():
            with patch.dict("os.environ", {"HTTP_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1"}):
                async with safe_client(self.base, self.profile) as client:
                    self.assertEqual((await client.get("/balance?q=UAH%20test")).json(), {})
        asyncio.run(run())
        path, raw_headers = Handler.seen[-1]
        headers = {key.lower(): value for key, value in raw_headers.items()}
        self.assertEqual(path, "/balance?q=UAH%20test")
        self.assertEqual(headers["host"], self.base.removeprefix("http://"))
        self.assertEqual(headers["authorization"], "Bearer synthetic-secret")
        self.assertEqual(headers["accept-encoding"], "identity")

    def test_redirect_compression_limits_and_total_deadline(self):
        async def run():
            async with safe_client(self.base, self.profile, timeout=0.15, max_bytes=100) as client:
                before = len(Handler.seen)
                response = await client.get("/redirect")
                self.assertEqual(response.status_code, 302)
                self.assertEqual(len(Handler.seen), before + 1)
                for path in ("/encoded", "/huge"):
                    with self.assertRaises(httpx.HTTPError):
                        await client.get(path)
                start = time.monotonic()
                with self.assertRaises(httpx.TimeoutException):
                    await client.get("/slow")
                self.assertLess(time.monotonic() - start, 0.45)
        asyncio.run(run())

    def test_mixed_dns_and_cancelled_resolution_never_connect(self):
        profile = EgressProfile("none", "Public", "public")
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("8.8.8.8", "127.0.0.1")]
        for cancel in (False, True):
            budget = _Budget(2)
            connection = _PinnedConnection("example.com", 443, "https://example.com", profile, budget, True)
            def resolve(*_args, **_kwargs):
                if cancel:
                    budget.cancel()
                return addresses if not cancel else addresses[:1]
            try:
                with patch("support_mcp.managed_network.socket.getaddrinfo", side_effect=resolve), patch("support_mcp.managed_network.socket.socket") as stream:
                    with self.assertRaises((EgressFailure, TimeoutError)):
                        connection.connect()
                    stream.assert_not_called()
            finally:
                budget.finish()

    def test_tls_keeps_original_hostname_after_numeric_socket_connect(self):
        budget = _Budget(2)
        connection = _PinnedConnection("example.com", 443, "https://example.com", EgressProfile("none", "Public", "public"), budget, True)
        raw, secure = Mock(), Mock()
        context = Mock()
        context.wrap_socket.return_value = secure
        try:
            with patch("support_mcp.managed_network.socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]) as lookup, patch("support_mcp.managed_network.socket.socket", return_value=raw), patch("support_mcp.managed_network.ssl.create_default_context", return_value=context):
                connection.connect()
                lookup.assert_called_once()
                raw.connect.assert_called_once_with(("8.8.8.8", 443))
                context.wrap_socket.assert_called_once_with(raw, server_hostname="example.com", do_handshake_on_connect=False)
                secure.do_handshake.assert_called_once()
        finally:
            budget.finish()
