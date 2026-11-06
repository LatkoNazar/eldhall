import asyncio
import json
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import uvicorn
from fastmcp import Client

from support_mcp.managed import create_managed_app
from support_mcp.manifest import fingerprint


BUSINESS = "b1000000-0000-4000-8000-000000000001"
OTHER = "b1000000-0000-4000-8000-000000000002"
TOKEN = "synthetic-managed-service-token-0001"
SPEC = {"openapi": "3.0.3", "info": {"title": "Test", "version": "1"}, "paths": {
    "/balance": {"get": {"operationId": "get_balance", "parameters": [{"name": "currency", "in": "query", "schema": {"type": "string"}}],
        "responses": {"200": {"description": "Balance", "content": {"application/json": {"schema": {"type": "object", "properties": {"balance": {"type": "integer"}, "source": {"type": "string"}}}}}}}}}}}
REVIEW = {"effect": "read", "scope": {"customerId": {"in": "header", "name": "X-Customer-Id"}, "businessId": {"in": "header", "name": "X-Business-Id"}}, "outputFields": ["balance", "source"]}


class Upstream(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.seen.append((self.path, dict(self.headers)))
        data = SPEC if self.path == "/openapi.json" else {"balance": 12345, "source": self.path.split("/")[1], "private": "do-not-expose"}
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class HttpService:
    def __init__(self, app):
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.url = f"http://127.0.0.1:{self.socket.getsockname()[1]}"
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False, lifespan="on", proxy_headers=False))
        self.thread = threading.Thread(target=lambda: self.server.run(sockets=[self.socket]), daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started and self.thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not self.server.started:
            raise AssertionError("Owned managed fixture did not start")
        return self

    def __exit__(self, *_args):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        self.socket.close()
        if self.thread.is_alive():
            raise AssertionError("Owned managed fixture did not stop")


class ManagedHttpTests(unittest.TestCase):
    def test_real_http_prepare_compile_install_mcp_scope_namespaces_and_restart(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{upstream.server_port}"
        env = {"MANAGED_MCP_TOKEN": TOKEN, "TEST_UPSTREAM_TOKEN": "synthetic-upstream-key",
               "MANAGED_UPSTREAM_PROFILES": json.dumps({"lab": {"name": "Owned fixture", "principalId": "fixture", "origins": [base], "privateOrigins": [base], "tokenEnv": "TEST_UPSTREAM_TOKEN"}})}
        app = create_managed_app(env)
        paths, installs = [], []

        async def scenario(url):
            async with httpx.AsyncClient(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}, trust_env=False, timeout=20) as control:
                self.assertEqual((await control.get("/control/capabilities", headers={"Authorization": "wrong"})).status_code, 401)
                capabilities = (await control.get("/control/capabilities")).json()
                self.assertNotIn("synthetic-upstream-key", json.dumps(capabilities))
                draft_response = await control.post("/control/prepare", json={"integrationId": "bank-one", "specUrl": base + "/openapi.json", "upstreamBaseUrl": base + "/one", "credentialProfileId": "lab"})
                self.assertEqual(draft_response.status_code, 200, draft_response.text)
                draft = draft_response.json()
                self.assertEqual(draft["specHash"], fingerprint(draft["spec"]))
                self.assertEqual(draft["operations"][0]["proposedEffect"], "unknown")
                self.assertTrue(draft["operations"][0]["supported"])
                for business, integration, prefix in ((BUSINESS, "bank-one", "one"), (OTHER, "bank-two", "two")):
                    compiled_response = await control.post("/control/compile", json={"integrationId": integration, "spec": draft["spec"], "upstreamBaseUrl": base + "/" + prefix, "credentialProfileId": "lab", "review": {"operations": {"GET /balance": REVIEW}}})
                    self.assertEqual(compiled_response.status_code, 200, compiled_response.text)
                    compiled = compiled_response.json()
                    install = {"businessId": business, "integrationId": integration, "connectionRevision": "1", "manifest": compiled["manifest"], "manifestHash": compiled["manifest"]["manifestHash"], "upstreamBaseUrl": base + "/" + prefix, "credentialProfileId": "lab", "upstreamTargetFingerprint": compiled["upstreamTargetFingerprint"]}
                    installed = await control.post("/control/install", json=install)
                    self.assertEqual(installed.status_code, 200, installed.text)
                    path = installed.json()["mcpPath"]
                    paths.append(path)
                    installs.append(install)
                    self.assertEqual((await control.post("/control/install", json=install)).json(), installed.json())
                    bad = await control.post("/control/install", json={**install, "upstreamTargetFingerprint": "f" * 64})
                    self.assertEqual(bad.status_code, 422)
                    async with Client(url + path, auth=TOKEN) as client:
                        tools = await client.list_tools()
                        self.assertEqual({tool.name for tool in tools}, {"get_balance", "get_connector_manifest"})
                        manifest = (await client.call_tool("get_connector_manifest", {})).structured_content
                        self.assertEqual(manifest["manifestHash"], compiled["manifest"]["manifestHash"])
                        self.assertEqual(manifest["upstreamTargetFingerprint"], compiled["upstreamTargetFingerprint"])
                        args = {"currency": "UAH", "eldhall": {"customerId": "synthetic-customer", "businessId": business}}
                        result = await client.call_tool("get_balance", args)
                        self.assertEqual(result.structured_content, {"balance": 12345, "source": prefix})
                        before = len(Upstream.seen)
                        rejected = await client.call_tool("get_balance", {**args, "eldhall": {"customerId": "synthetic-customer", "businessId": OTHER if business == BUSINESS else BUSINESS}}, raise_on_error=False)
                        self.assertTrue(rejected.is_error)
                        self.assertIn("business_scope_mismatch", str(rejected.content))
                        self.assertEqual(len(Upstream.seen), before)
                self.assertNotEqual(paths[0], paths[1])
                # An installation request can disappear while its owned lifespan
                # is still starting. Neither status nor retry may claim ready.
                manager = app.app.state.managed
                pending_runtime = next(iter(manager.items.values()))
                pending_runtime.ready.clear()
                try:
                    self.assertEqual((await control.post("/control/status", json=installs[0])).status_code, 404)
                    pending = await control.post("/control/install", json=installs[0])
                    self.assertEqual((pending.status_code, pending.json()["code"]), (503, "runtime_starting"))
                finally:
                    pending_runtime.ready.set()
                invalid = await control.post("/control/compile", json={"integrationId": "bank", "spec": draft["spec"], "upstreamBaseUrl": base, "credentialProfileId": "lab", "review": {"operations": {"GET /balance": {**REVIEW, "effect": "unknown"}}}})
                self.assertEqual(invalid.status_code, 422)
                deep = await control.post("/control/prepare", content='[' * 2000 + ']' * 2000, headers={"Content-Type": "application/json"})
                self.assertEqual(deep.status_code, 422)
                duplicate = await control.post("/control/prepare", content='{"integrationId":"a","integrationId":"b"}', headers={"Content-Type": "application/json"})
                self.assertEqual(duplicate.status_code, 422)

        async def after_restart(url):
            async with httpx.AsyncClient(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}, trust_env=False) as client:
                self.assertEqual((await client.post("/control/status", json=installs[0])).status_code, 404)
                restored = await client.post("/control/install", json=installs[0])
                self.assertEqual(restored.status_code, 200, restored.text)
                self.assertEqual(restored.json()["mcpPath"], paths[0])
            async with Client(url + paths[0], auth=TOKEN) as client:
                self.assertEqual(len(await client.list_tools()), 2)

        try:
            with HttpService(app) as service:
                asyncio.run(scenario(service.url))
                owned = list(app.app.state.managed.items.values())
                self.assertEqual(len(owned), 2)
            self.assertTrue(all(item.client.is_closed and item.task.done() for item in owned))
            with HttpService(create_managed_app(env)) as restarted:
                asyncio.run(after_restart(restarted.url))
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join()
