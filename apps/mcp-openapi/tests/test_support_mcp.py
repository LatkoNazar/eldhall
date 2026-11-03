import asyncio
import copy
import json
import unittest
from pathlib import Path

import httpx
from fastmcp import Client

from support_mcp.manifest import build_manifest, fingerprint, verify
from support_mcp.server import Rejected, build_request, create_server, project

ORDERS = Path(__file__).resolve().parents[3] / "examples" / "orders"
load = lambda name: json.loads((ORDERS / name).read_text(encoding="utf-8"))  # noqa: E731


class ImporterTest(unittest.TestCase):
    def test_reproduces_committed_fixture_byte_for_byte(self):
        manifest, report = build_manifest(load("openapi.json"), load("review.json"), load("manifest.json"))
        self.assertEqual(manifest, load("manifest.json"))
        self.assertEqual(report["diff"]["unchanged"], [op["operationKey"] for op in manifest["operations"]])
        self.assertEqual(manifest["operations"][2]["effect"], "unknown")
        verify(manifest)

    def test_hash_matches_typescript_canonical_form(self):
        # Same vector as apps/api/tests/integration-permissions.test.ts: key order/formatting ignored, floats like JS.
        self.assertEqual(fingerprint({"b": 1, "a": {"d": [1, 2], "c": "x"}}), fingerprint(json.loads('{ "a": {"c":"x", "d":[1,2]},\n "b": 1 }')))
        self.assertEqual(fingerprint({"a": 1, "manifestHash": "x"}, "manifestHash"), fingerprint({"a": 1}))

    def test_unreviewed_and_unsupported_operations_are_reported_not_widened(self):
        spec, review = load("openapi.json"), load("review.json")
        del review["operations"]["DELETE /customers/{customer_id}"]
        spec["paths"]["/orders/{order_id}"]["get"]["parameters"].append({"name": "filter", "in": "query", "schema": {"oneOf": [{"type": "string"}, {"type": "integer"}]}})
        manifest, report = build_manifest(spec, review)
        status = {row["operationKey"]: row for row in report["operations"]}
        self.assertEqual(status["DELETE /customers/{customer_id}"]["status"], "unreviewed")
        self.assertEqual(status["GET /orders/{order_id}"]["status"], "unsupported")
        self.assertIn("oneOf", status["GET /orders/{order_id}"]["reason"])
        self.assertEqual([op["toolName"] for op in manifest["operations"]], ["cancel_order"])
        self.assertEqual(report["diff"]["added"], ["POST /orders/{order_id}/cancel"])

    def test_rejects_wrong_versions_remote_refs_and_stale_review(self):
        spec, review = load("openapi.json"), load("review.json")
        with self.assertRaisesRegex(ValueError, "not supported"):
            build_manifest({**spec, "openapi": "2.0"}, review)
        remote = copy.deepcopy(spec)
        remote["paths"]["/orders/{order_id}"]["get"]["parameters"][0] = {"$ref": "https://evil.example/p.json"}
        _, report = build_manifest(remote, review)
        self.assertIn("non-local", report["operations"][0]["reason"])
        with self.assertRaisesRegex(ValueError, "not in the spec"):
            build_manifest(spec, {**review, "operations": {**review["operations"], "GET /gone": {}}})

    def test_verify_refuses_tampered_manifest(self):
        manifest = load("manifest.json")
        manifest["operations"][0]["outputFields"].append("internal_note")
        with self.assertRaisesRegex(ValueError, "operationHash"):
            verify(manifest)


class RequestMappingTest(unittest.TestCase):
    def setUp(self):
        self.read, self.cancel, _ = load("manifest.json")["operations"]

    def test_maps_path_body_scope_and_idempotency(self):
        request = build_request(self.cancel, {"order_id": "A/1", "reason": "x", "eldhall": {"customerId": "c1", "idempotencyKey": "act-1"}})
        self.assertEqual(request, {"method": "POST", "url": "/orders/A%2F1/cancel", "params": {}, "headers": {"X-Customer-Id": "c1", "Idempotency-Key": "act-1"}, "json": {"reason": "x"}})

    def test_scope_and_input_are_strict(self):
        for args, code in [
            ({"order_id": "1"}, "scope_missing"),
            ({"order_id": "1", "eldhall": {"customerId": ""}}, "scope_missing"),
            ({"order_id": "1", "customer_id": "other", "eldhall": {"customerId": "c1"}}, "unexpected_input"),
            ({"eldhall": {"customerId": "c1"}}, "missing_input"),
        ]:
            with self.assertRaises(Rejected) as caught:
                build_request(self.read, args)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(Rejected) as caught:
            build_request(self.cancel, {"order_id": "1", "eldhall": {"customerId": "c1"}})
        self.assertEqual(caught.exception.code, "idempotency_key_missing")

    def test_projection_drops_private_and_nested_fields(self):
        self.assertEqual(project({"order_id": "1", "status": "paid", "internal_note": "x", "tracking_url": {"a": 1}}, self.read["outputFields"]), {"order_id": "1", "status": "paid"})


class ServerTest(unittest.TestCase):
    def test_catalog_excludes_unknown_effect_and_reports_manifest(self):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.headers.get("x-customer-id") != "cust-olena":
                return httpx.Response(404, json={"error": "order_not_found", "secret": "leak"})
            return httpx.Response(200, json={"order_id": "ORD-1001", "status": "paid", "internal_note": "VIP"})

        manifest = load("manifest.json")
        upstream = httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(handler))

        async def scenario():
            async with Client(create_server(manifest, upstream)) as client:
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertEqual(sorted(tools), ["cancel_order", "get_connector_manifest", "get_order_status"])
                self.assertTrue(tools["get_order_status"].annotations.read_only_hint)
                self.assertTrue(tools["cancel_order"].annotations.destructive_hint)
                info = (await client.call_tool("get_connector_manifest", {})).structured_content
                self.assertEqual(info["manifestHash"], manifest["manifestHash"])
                own = await client.call_tool("get_order_status", {"order_id": "ORD-1001", "eldhall": {"customerId": "cust-olena"}})
                self.assertEqual(own.structured_content, {"order_id": "ORD-1001", "status": "paid"})
                foreign = await client.call_tool("get_order_status", {"order_id": "ORD-1001", "eldhall": {"customerId": "cust-taras"}}, raise_on_error=False)
                self.assertTrue(foreign.is_error)
                self.assertEqual(foreign.structured_content, {"error": "not_found", "effect": "none"})

        asyncio.run(scenario())
        self.assertEqual(str(seen[0].url), "http://upstream.test/orders/ORD-1001")

    def test_write_timeout_is_unknown_and_read_timeout_is_not(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow", request=request)

        upstream = httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(handler))

        async def scenario():
            async with Client(create_server(load("manifest.json"), upstream)) as client:
                write = await client.call_tool("cancel_order", {"order_id": "ORD-1001", "eldhall": {"customerId": "c", "idempotencyKey": "a"}}, raise_on_error=False)
                read = await client.call_tool("get_order_status", {"order_id": "ORD-1001", "eldhall": {"customerId": "c"}}, raise_on_error=False)
                self.assertEqual(write.structured_content, {"error": "outcome_unknown", "effect": "unknown"})
                self.assertEqual(read.structured_content, {"error": "timeout", "effect": "none"})

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
