"""HTTP-level checks of the app a container runs: service auth, Host validation, startup settings."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import httpx
from starlette.testclient import TestClient

from support_mcp.server import _settings, build_app

ORDERS = Path(__file__).resolve().parents[3] / "examples" / "orders"
MANIFEST = json.loads((ORDERS / "manifest.json").read_text(encoding="utf-8"))
TOKEN = "service-token-for-tests"
INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


class ContainerAppTest(unittest.TestCase):
    def call(self, host: str, token: str | None = TOKEN, path: str = "/mcp"):
        app = build_app(MANIFEST, "http://upstream", None, TOKEN, allowed_hosts=("mcp-openapi",))
        with TestClient(app, base_url=f"http://{host}") as client:
            headers = {**HEADERS, **({"authorization": f"Bearer {token}"} if token else {})}
            return client.post(path, json=INITIALIZE, headers=headers) if path == "/mcp" else client.get(path)

    def test_host_header_is_validated_by_the_real_server(self):
        # Run the actual uvicorn process: FastMCP compares Host with the socket the request arrived on,
        # which an in-process test client would fake.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        env = {"PATH": os.environ.get("PATH", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""), "MANIFEST_PATH": str(ORDERS / "manifest.json"),
               "UPSTREAM_BASE_URL": "http://upstream", "MCP_SERVICE_TOKEN": TOKEN, "MCP_ALLOWED_HOSTS": "mcp-openapi", "PORT": str(port)}
        server = subprocess.Popen([sys.executable, "-m", "support_mcp.server"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            url = f"http://127.0.0.1:{port}"
            for _ in range(150):
                try:
                    if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    time.sleep(0.2)
            else:
                self.fail("sidecar did not start")
            post = lambda host, token=TOKEN: httpx.post(f"{url}/mcp", json=INITIALIZE, headers={**HEADERS, "host": host, "authorization": f"Bearer {token}"}, timeout=10)  # noqa: E731
            for host in (f"mcp-openapi:{port}", f"127.0.0.1:{port}", f"localhost:{port}"):
                self.assertEqual(post(host).status_code, 200, host)
            for host in ("evil.example", f"mcp-openapi.attacker.example:{port}", "10.0.0.5"):
                self.assertEqual(post(host).status_code, 421, host)
        finally:
            server.terminate()
            server.wait(timeout=20)

    def test_service_token_required_but_health_is_open(self):
        self.assertEqual(self.call("mcp-openapi:8000", token=None).status_code, 401)
        self.assertEqual(self.call("mcp-openapi:8000", token="wrong-token-value-xx").status_code, 401)
        health = self.call("127.0.0.1:8000", token=None, path="/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["manifestHash"], MANIFEST["manifestHash"])

    def test_upstream_url_must_be_plain_http_or_https(self):
        for url in ("ftp://upstream.test", "http://user:pass@upstream.test", "http://upstream.test/?token=x", "upstream.test"):
            with self.assertRaises(ValueError):
                build_app(MANIFEST, url, None, TOKEN)
        with self.assertRaises(ValueError):
            build_app(MANIFEST, "http://upstream", None, "short")

    def test_cleartext_upstream_only_on_a_private_name_or_by_explicit_opt_in(self):
        for url in ("http://orders-mock:8090", "http://127.0.0.1:8090", "https://api.customer.example"):
            build_app(MANIFEST, url, "upstream-token", TOKEN)
        for url in ("http://api.customer.example", "http://[2001:db8::1]", "http://134744072", "http://8.8.8.8", "http://10.0.0.5"):
            with self.assertRaisesRegex(ValueError, "must use https", msg=url):
                build_app(MANIFEST, url, "upstream-token", TOKEN)
        build_app(MANIFEST, "http://[::1]:8090", "upstream-token", TOKEN)
        build_app(MANIFEST, "http://api.customer.example", "upstream-token", TOKEN, allow_insecure_upstream=True)
        base = {"MANIFEST_PATH": "m", "UPSTREAM_BASE_URL": "http://u", "MCP_SERVICE_TOKEN": "secret-value-123456"}
        self.assertFalse(_settings(base)["insecure"])
        self.assertTrue(_settings({**base, "UPSTREAM_ALLOW_INSECURE_HTTP": "true"})["insecure"])
        with self.assertRaises(ValueError):
            _settings({**base, "UPSTREAM_ALLOW_INSECURE_HTTP": "yes"})

    def test_settings_name_problems_without_values(self):
        with self.assertRaisesRegex(ValueError, "MANIFEST_PATH, UPSTREAM_BASE_URL, MCP_SERVICE_TOKEN"):
            _settings({})
        base = {"MANIFEST_PATH": "m", "UPSTREAM_BASE_URL": "http://u", "MCP_SERVICE_TOKEN": "secret-value-123456"}
        for bad in ({"UPSTREAM_TIMEOUT_SECONDS": "x"}, {"UPSTREAM_TIMEOUT_SECONDS": "0"}, {"PORT": "70000"}, {"MCP_ALLOWED_HOSTS": "ok,Bad Host"}):
            with self.assertRaises(ValueError) as caught:
                _settings({**base, **bad})
            self.assertNotIn("secret-value-123456", str(caught.exception))
        self.assertEqual(_settings({**base, "MCP_ALLOWED_HOSTS": "mcp-openapi, other"})["hosts"], ("mcp-openapi", "other"))

    def test_process_refuses_bad_configuration_with_reason_and_no_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            tampered = json.loads(json.dumps(MANIFEST))
            tampered["operations"][0]["outputFields"].append("internal_note")
            manifest.write_text(json.dumps(tampered), encoding="utf-8")
            env = {"PATH": os.environ.get("PATH", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                   "MANIFEST_PATH": str(manifest), "UPSTREAM_BASE_URL": "http://upstream", "MCP_SERVICE_TOKEN": "secret-value-123456"}
            result = subprocess.run([sys.executable, "-m", "support_mcp.server"], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 1)
            self.assertIn("MCP sidecar configuration invalid: operationHash mismatch", result.stderr)
            self.assertNotIn("secret-value-123456", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
