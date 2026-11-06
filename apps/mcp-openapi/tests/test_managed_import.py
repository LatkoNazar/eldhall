"""Pure managed-import review checks; no URLs, credentials or stores are opened."""
import copy
import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from support_mcp.managed_import import Profiles, candidates, compile_review, prepare
from support_mcp.managed_network import EgressFailure


def specification(path="/accounts/{account_id}", *, headers=(), method="get"):
    parameters = [{"in": "path", "name": name, "required": True, "schema": {"type": "string"}}
                  for name in ("customer_id",) if "{" + name + "}" in path]
    if "{account_id}" in path:
        parameters.append({"in": "path", "name": "account_id", "required": True, "schema": {"type": "string"}})
    parameters += [{"in": "header", "name": name, "required": True, "schema": {"type": "string"}} for name in headers]
    operation = {"operationId": "account_action", "parameters": parameters,
                 "responses": {"200": {"description": "Synthetic result", "content": {"application/json": {
                     "schema": {"type": "object", "properties": {"status": {"type": "string"}}, "additionalProperties": False}}}}}}
    return {"openapi": "3.1.0", "info": {"title": "Synthetic API", "version": "1"}, "paths": {path: {method: operation}}}


def compile_payload(spec, review, *, base="https://api.example.invalid/v1", profile="none"):
    operation_key = candidates(spec)[0]["operationKey"]
    return {"spec": spec, "integrationId": "synthetic", "upstreamBaseUrl": base, "credentialProfileId": profile,
            "review": {"operations": {operation_key: review}}}


def fixed_profiles():
    return Profiles({"MANAGED_UPSTREAM_PROFILES": json.dumps({"fixed": {
        "origins": ["https://api.example.invalid"], "upstreamBaseUrl": "https://api.example.invalid/v1/",
        "name": "Synthetic fixed target", "principalId": "synthetic-principal"}})})


class ManagedImportTests(unittest.TestCase):
    def test_custom_required_customer_header_is_reviewable_and_not_model_controlled(self):
        spec = specification(headers=["X-Client-Id"])
        before = copy.deepcopy(spec)
        row = candidates(spec)[0]
        self.assertTrue(row["supported"])
        self.assertEqual(row["proposedEffect"], "unknown")
        self.assertEqual(row["scope"]["customerId"], {"in": "header", "name": "X-Client-Id"})
        self.assertNotIn("X-Client-Id", row["inputSchema"]["properties"])
        self.assertEqual(spec, before)
        review = {"effect": "read", "scope": row["scope"], "outputFields": ["status"]}
        compiled = compile_review(compile_payload(spec, review), Profiles({}))
        actual = compiled["manifest"]["operations"][0]
        self.assertEqual(actual["scope"], review["scope"])
        self.assertEqual(actual["effect"], "read")
        self.assertEqual(actual["inputSchema"]["required"], ["account_id"])

    def test_scope_suggestion_can_be_replaced_by_explicit_customer_path_review(self):
        spec = specification("/customers/{customer_id}/account")
        row = candidates(spec)[0]
        self.assertTrue(row["supported"])
        self.assertEqual(row["proposedEffect"], "unknown")
        review = {"effect": "read", "scope": {"customerId": {"in": "path", "name": "customer_id"}}, "outputFields": ["status"]}
        compiled = compile_review(compile_payload(spec, review), Profiles({}))["manifest"]["operations"][0]
        self.assertEqual(compiled["scope"], review["scope"])
        self.assertEqual(compiled["inputSchema"]["properties"], {})
        self.assertEqual(compiled["parameters"], {})

    def test_idempotent_write_shape_stays_unknown_and_needs_explicit_semantic_review(self):
        spec = specification(headers=["X-Client-Id", "X-Tenant-Id", "Idempotency-Key"], method="post")
        row = candidates(spec)[0]
        self.assertTrue(row["supported"])
        self.assertEqual(row["proposedEffect"], "unknown")
        self.assertEqual(row["idempotencyHeaderCandidates"], ["Idempotency-Key"])
        review = {"effect": "write", "scope": row["scope"], "outputFields": ["status"], "idempotency": {"header": "Idempotency-Key"}}
        actual = compile_review(compile_payload(spec, review), Profiles({}))["manifest"]["operations"][0]
        self.assertEqual(actual["effect"], "write")
        self.assertEqual(actual["idempotency"], {"header": "Idempotency-Key"})
        for invalid in ({**review, "effect": "unknown"}, {key: value for key, value in review.items() if key != "effect"}):
            with self.subTest(reviewed_effect=invalid.get("effect")):
                with self.assertRaises(ValueError):
                    compile_review(compile_payload(spec, invalid), Profiles({}))

    def test_unmappable_or_authentication_headers_are_not_silently_enabled_as_scope(self):
        for headers in (["X-One", "X-Two", "X-Three"], ["Authorization"]):
            with self.subTest(headers=headers):
                row = candidates(specification(headers=headers))[0]
                self.assertFalse(row["supported"])
                self.assertEqual(row["proposedEffect"], "unknown")
                self.assertEqual(row["reasonCode"], "unsupported_schema_or_mapping")

    def test_malformed_response_content_is_a_safe_validation_failure(self):
        for content in (None, [], {"application/json": None}, {"application/json": "invalid"}):
            with self.subTest(content=content):
                spec = specification()
                spec["paths"]["/accounts/{account_id}"]["get"]["responses"]["200"]["content"] = content
                with self.assertRaisesRegex(ValueError, "response content"):
                    candidates(spec)

    def test_fixed_deployment_base_is_enforced_before_prepare_network_and_compile(self):
        profiles = fixed_profiles()
        self.assertEqual(profiles.base("fixed", None), "https://api.example.invalid/v1")
        self.assertEqual(profiles.base("fixed", "https://api.example.invalid/v1/"), "https://api.example.invalid/v1")
        for base in ("https://api.example.invalid/admin", "https://foreign.example.invalid/v1"):
            with self.subTest(base=base), self.assertRaises(EgressFailure):
                profiles.base("fixed", base)
        spec = specification()
        review = {"effect": "read", "scope": {"customerId": {"in": "header", "name": "X-Client-Id"}}, "outputFields": ["status"]}
        with self.assertRaisesRegex(EgressFailure, "profile_target_mismatch"):
            compile_review(compile_payload(spec, review, base="https://api.example.invalid/admin", profile="fixed"), profiles)
        with patch("support_mcp.managed_import.safe_client", side_effect=AssertionError("Network must not be opened")):
            with self.assertRaisesRegex(EgressFailure, "profile_target_mismatch"):
                asyncio.run(prepare({"integrationId": "synthetic", "specUrl": "https://api.example.invalid/openapi.json",
                                     "upstreamBaseUrl": "https://api.example.invalid/admin", "credentialProfileId": "fixed"}, profiles))

    def test_prepare_with_omitted_base_keeps_the_fixed_deployment_path(self):
        class SyntheticClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, url):
                if url != "https://api.example.invalid/openapi.json":
                    raise AssertionError("Only the selected synthetic source is permitted")
                return httpx.Response(200, json=specification())

        with patch("support_mcp.managed_import.safe_client", return_value=SyntheticClient()):
            result = asyncio.run(prepare({"integrationId": "synthetic", "specUrl": "https://api.example.invalid/openapi.json",
                                          "credentialProfileId": "fixed"}, fixed_profiles()))
        self.assertEqual(result["upstreamBaseUrl"], "https://api.example.invalid/v1")
        self.assertEqual(result["operations"][0]["proposedEffect"], "unknown")

    def test_profile_origin_configuration_rejects_paths_queries_and_fragments(self):
        for field in ("origins", "privateOrigins"):
            for invalid in ("https://api.example.invalid/private", "https://api.example.invalid/?key=secret", "https://api.example.invalid/#fragment"):
                with self.subTest(field=field, value=invalid):
                    value = {"origins": ["https://api.example.invalid"], field: [invalid]}
                    with self.assertRaises(ValueError):
                        Profiles({"MANAGED_UPSTREAM_PROFILES": json.dumps({"invalid": value})})

    def test_cross_origin_public_spec_never_receives_the_upstream_bearer(self):
        token = "synthetic-bearer-only-for-reviewed-upstream"
        profiles = Profiles({"SYNTHETIC_TOKEN": token, "MANAGED_UPSTREAM_PROFILES": json.dumps({"fixed": {
            "origins": ["https://api.example.invalid", "https://docs.example.invalid"],
            "upstreamBaseUrl": "https://api.example.invalid/v1", "tokenEnv": "SYNTHETIC_TOKEN"}})})

        class SyntheticClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, _url):
                return httpx.Response(200, json=specification())

        for url, expected_token in (("https://docs.example.invalid/openapi.json", None),
                                    ("https://api.example.invalid/openapi.json", token)):
            with self.subTest(url=url), patch("support_mcp.managed_import.safe_client", return_value=SyntheticClient()) as factory:
                result = asyncio.run(prepare({"integrationId": "synthetic", "specUrl": url, "credentialProfileId": "fixed"}, profiles))
                source_profile = factory.call_args.args[1]
                self.assertEqual(source_profile.token, expected_token)
                self.assertEqual(source_profile.allowed_origins, profiles.get("fixed").allowed_origins)
                self.assertEqual(result["upstreamBaseUrl"], "https://api.example.invalid/v1")
        self.assertEqual(profiles.get("fixed").token, token)

    def test_protected_cross_origin_spec_is_refused_without_sending_bearer(self):
        profiles = Profiles({"SYNTHETIC_TOKEN": "synthetic-bearer-only-for-reviewed-upstream",
                             "MANAGED_UPSTREAM_PROFILES": json.dumps({"fixed": {
                                 "origins": ["https://api.example.invalid", "https://docs.example.invalid"],
                                 "upstreamBaseUrl": "https://api.example.invalid/v1", "tokenEnv": "SYNTHETIC_TOKEN"}})})

        class ProtectedClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, _url):
                return httpx.Response(401)

        with patch("support_mcp.managed_import.safe_client", return_value=ProtectedClient()) as factory:
            with self.assertRaisesRegex(EgressFailure, "spec_unauthorized"):
                asyncio.run(prepare({"integrationId": "synthetic", "specUrl": "https://docs.example.invalid/openapi.json",
                                     "credentialProfileId": "fixed"}, profiles))
            self.assertIsNone(factory.call_args.args[1].token)


if __name__ == "__main__":
    unittest.main()
