import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastmcp import Client

from support_mcp.import_openapi import main
from support_mcp.manifest import build_manifest, canonical, compile_inventory, fingerprint, normalize_spec, verify
from support_mcp.server import MAX_UPSTREAM_BYTES, _settings, build_app, create_server

ORDERS = Path(__file__).resolve().parents[3] / "examples" / "orders"


def load(name):
    return json.loads((ORDERS / name).read_text(encoding="utf-8"))


def rehash(manifest):
    for operation in manifest["operations"]:
        operation["operationHash"] = fingerprint(operation, "operationHash")
    manifest["manifestHash"] = fingerprint(manifest, "manifestHash")
    return manifest


class ArtifactTests(unittest.TestCase):
    def test_target_metadata_binds_url_and_principal_but_not_rotated_tokens(self):
        async def metadata(url, token="old-token", principal="orders-reader", revision="3"):
            async with httpx.AsyncClient(base_url=url, headers={"authorization": f"Bearer {token}"}) as upstream:
                async with Client(create_server(load("manifest.json"), upstream, connection_revision=revision, principal_id=principal)) as client:
                    return (await client.call_tool("get_connector_manifest", {})).structured_content
        first = asyncio.run(metadata("https://upstream.example/api/"))
        rotated = asyncio.run(metadata("https://upstream.example/api", token="new-token"))
        changed_target = asyncio.run(metadata("https://other.example/api"))
        changed_principal = asyncio.run(metadata("https://upstream.example/api", principal="orders-admin"))
        self.assertEqual(first["connectionRevision"], "3")
        self.assertEqual(first["upstreamTargetFingerprint"], fingerprint({"baseUrl": "https://upstream.example/api", "principalId": "orders-reader"}))
        self.assertEqual(first, rotated)
        self.assertNotEqual(first["upstreamTargetFingerprint"], changed_target["upstreamTargetFingerprint"])
        self.assertNotEqual(first["upstreamTargetFingerprint"], changed_principal["upstreamTargetFingerprint"])
        self.assertNotIn("old-token", json.dumps(first))

    def test_connection_environment_is_validated_and_forwarded_to_server(self):
        env = {"MANIFEST_PATH": "manifest", "UPSTREAM_BASE_URL": "http://upstream", "MCP_SERVICE_TOKEN": "service-token-value", "MCP_CONNECTION_REVISION": "12", "UPSTREAM_PRINCIPAL_ID": "orders-reader"}
        settings = _settings(env)
        self.assertEqual((settings["revision"], settings["principal"]), ("12", "orders-reader"))
        for change in ({"MCP_CONNECTION_REVISION": "0"}, {"MCP_CONNECTION_REVISION": "1" * 16}, {"MCP_CONNECTION_REVISION": "\u0661"}, {"UPSTREAM_PRINCIPAL_ID": "bad principal"}):
            with self.assertRaises(ValueError):
                _settings({**env, **change})
        with patch("support_mcp.server.create_server", wraps=create_server) as create:
            build_app(load("manifest.json"), "http://upstream", None, "service-token-value", connection_revision=settings["revision"], principal_id=settings["principal"])
            self.assertEqual(create.call_args.args[3:], ("12", "orders-reader"))

    def test_canonical_numbers_and_utf16_keys_match_javascript(self):
        self.assertEqual(canonical({"n": 0.0000001, "big": 1e20, "neg": -0.0}), '{"big":100000000000000000000,"n":1e-7,"neg":0}')
        self.assertEqual(canonical({"\ue000": 1, "\U00010000": 2}), '{"\U00010000":2,"\ue000":1}')
        for number in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                fingerprint({"number": number})

    def test_spec_key_order_does_not_change_artifact_identity(self):
        spec, review = load("openapi.json"), load("review.json")
        first, _ = build_manifest(spec, review)
        self.assertEqual(first["specHash"], fingerprint(normalize_spec(spec)))
        spec["paths"] = dict(reversed(list(spec["paths"].items())))
        second, _ = build_manifest(spec, review)
        self.assertEqual(first, second)

    def test_meaningful_unsupported_constraints_are_reported(self):
        for keyword, value in (("pattern", "^[A-Z]+$"), ("minLength", 3), ("nullable", True), ("default", "ORD-1"), ("format", "uuid")):
            spec = load("openapi.json")
            spec["components"]["parameters"]["OrderId"]["schema"][keyword] = value
            manifest, report = build_manifest(spec, load("review.json"))
            self.assertNotIn("get_order_status", [op["toolName"] for op in manifest["operations"]])
            self.assertTrue(any(row["status"] == "unsupported" and keyword in row["reason"] for row in report["operations"]))

    def test_self_hashed_malformed_manifest_still_fails(self):
        variants = []
        for edit in (
            lambda op: op.update(guard="unknown.guard"),
            lambda op: op.update(path="/orders/../private", operationKey="GET /orders/../private"),
            lambda op: op.update(toolName="get_connector_manifest"),
            lambda op: op["scope"].update(businessId=copy.deepcopy(op["scope"]["customerId"])),
            lambda op: op["scope"]["customerId"].update(name="Authorization"),
        ):
            manifest = load("manifest.json")
            edit(manifest["operations"][0])
            variants.append(rehash(manifest))
        for manifest in variants:
            with self.assertRaises(ValueError):
                verify(manifest)

    def test_unsupported_serialization_and_optional_body_requirements_are_reported(self):
        for edit in (
            lambda spec: spec["components"]["parameters"]["OrderId"].update(style="simple"),
            lambda spec: spec["components"]["parameters"]["OrderId"].update(explode=False),
            lambda spec: spec["components"]["parameters"]["OrderId"].update(schema={"type": "array", "items": {"type": "string"}}),
        ):
            spec = load("openapi.json")
            edit(spec)
            _, report = build_manifest(spec, load("review.json"))
            row = next(row for row in report["operations"] if row["operationKey"] == "GET /orders/{order_id}")
            self.assertEqual(row["status"], "unsupported")
        spec = load("openapi.json")
        spec["paths"]["/orders/{order_id}/cancel"]["post"]["requestBody"]["content"]["application/json"]["schema"]["required"] = ["reason"]
        _, report = build_manifest(spec, load("review.json"))
        self.assertIn("conditionally required", next(row for row in report["operations"] if row["operationKey"].startswith("POST"))["reason"])

    def test_normalization_expands_local_refs_and_rejects_cycles(self):
        spec = load("openapi.json")
        normalized = normalize_spec(spec)
        self.assertNotIn('"$ref"', json.dumps(normalized))
        self.assertEqual(normalized["paths"]["/orders/{order_id}"]["get"]["parameters"][0]["name"], "order_id")
        with self.assertRaises(ValueError):
            normalize_spec({"components": {"Loop": {"$ref": "#/components/Loop"}}})

    def test_real_fastmcp_compilation_and_cli_emit_artifacts_without_unknown_tools(self):
        spec = normalize_spec(load("openapi.json"))
        self.assertEqual(compile_inventory(spec, load("manifest.json")), ["cancel_order", "get_order_status"])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "manifest.json"
            report = Path(directory) / "report.json"
            self.assertEqual(main([str(ORDERS / "openapi.json"), str(ORDERS / "review.json"), "--out", str(output), "--report", str(report)]), 0)
            self.assertEqual(json.loads(output.read_text()), load("manifest.json"))
            self.assertTrue(output.with_suffix(".normalized.openapi.json").exists())
            self.assertEqual(json.loads(report.read_text())["mechanicalTools"], ["cancel_order", "get_order_status"])


class ExecutionTests(unittest.TestCase):
    def call(self, handler, action_key="action"):
        async def scenario():
            async with httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(handler)) as upstream:
                async with Client(create_server(load("manifest.json"), upstream)) as client:
                    return await client.call_tool("cancel_order", {"order_id": "ORD-1001", "eldhall": {"customerId": "c", "idempotencyKey": action_key}}, raise_on_error=False)
        return asyncio.run(scenario())

    def test_guard_rejects_shipped_and_foreign_order_before_write(self):
        for response in (httpx.Response(200, json={"order_id": "ORD-1001", "status": "shipped"}), httpx.Response(404)):
            methods = []
            def handler(request):
                methods.append(request.method)
                return response
            result = self.call(handler)
            self.assertTrue(result.is_error)
            self.assertEqual(result.structured_content["effect"], "none")
            self.assertEqual(result.structured_content["guard"], {"id": "orders.cancel_before_shipment", "status": "rejected"})
            self.assertEqual(methods, ["GET"])

    def test_stream_is_stopped_at_byte_limit_before_unbounded_buffering(self):
        class LargeStream(httpx.AsyncByteStream):
            chunks = 0
            closed = False
            async def __aiter__(self):
                for _ in range(1000):
                    self.chunks += 1
                    yield b"x" * 16_384
            async def aclose(self):
                self.closed = True
        stream = LargeStream()
        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json={"order_id": "ORD-1001", "status": "paid"})
            return httpx.Response(200, stream=stream)
        result = self.call(handler)
        self.assertEqual(result.structured_content, {"error": "invalid_output", "effect": "unknown"})
        self.assertLessEqual(stream.chunks, MAX_UPSTREAM_BYTES // 16_384 + 1)
        self.assertTrue(stream.closed)

    def test_provider_replay_is_allowed_but_new_key_on_cancelled_order_is_rejected_upstream(self):
        keys = []
        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json={"order_id": "ORD-1001", "status": "cancelled"})
            keys.append(request.headers["idempotency-key"])
            if request.headers["idempotency-key"] == "action":
                return httpx.Response(200, json={"order_id": "ORD-1001", "status": "cancelled"})
            return httpx.Response(409)
        self.assertFalse(self.call(handler).is_error)
        self.assertEqual(self.call(handler, "different").structured_content, {"error": "conflict", "effect": "none"})
        self.assertEqual(keys, ["action", "different"])

    def test_compressed_response_is_refused_before_decompression(self):
        def handler(request):
            self.assertEqual(request.headers["accept-encoding"], "identity")
            if request.method == "GET":
                return httpx.Response(200, json={"order_id": "ORD-1001", "status": "paid"})
            return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"not-a-valid-compressed-body"))
        self.assertEqual(self.call(handler).structured_content, {"error": "invalid_output", "effect": "unknown"})
