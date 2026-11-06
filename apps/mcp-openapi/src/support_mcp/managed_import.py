"""Reviewed URL onboarding helpers. Candidate suggestions never authorize tools."""
from __future__ import annotations

import json
import re
import asyncio
import threading
from dataclasses import replace
from typing import Any
from urllib.parse import urlsplit

import httpx

from .managed_network import EgressFailure, EgressProfile, normalize_url, origin, safe_client
from .manifest import METHODS, SAFE_KEY, Unsupported, _operation, _resolve, build_manifest, compile_inventory, fingerprint, normalize_spec
from .validation import HEADER, PROTECTED_HEADERS

ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
HTTP_METHODS = (*METHODS, "head", "options", "trace")
_COMPILATIONS = threading.BoundedSemaphore(2)


def compile_limited(function: Any, *args: Any) -> Any:
    if not _COMPILATIONS.acquire(blocking=False):
        raise EgressFailure("compiler_busy")
    try:
        return function(*args)
    finally:
        _COMPILATIONS.release()


def strict_json(raw: bytes | str) -> Any:
    def pairs(values: list[tuple[str, Any]]) -> dict:
        result: dict = {}
        for key, value in values:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def _profile_origin(raw: str) -> str:
    normalized = normalize_url(raw)
    if urlsplit(normalized).path not in ("", "/"):
        raise ValueError("Managed profile origins cannot contain paths")
    return origin(normalized)


class Profiles:
    def __init__(self, env: dict[str, str]):
        self.items = {"none": EgressProfile("none", "Public API without authentication", "public")}
        self.configured = {"none": True}
        self.bases: dict[str, str | None] = {"none": None}
        raw = strict_json(env.get("MANAGED_UPSTREAM_PROFILES", "{}"))
        if not isinstance(raw, dict) or len(raw) > 20:
            raise ValueError("Invalid managed credential profiles")
        for identity, item in raw.items():
            if not isinstance(identity, str) or not ID.fullmatch(identity) or identity == "none" or not isinstance(item, dict):
                raise ValueError("Invalid managed credential profile")
            if set(item) - {"name", "principalId", "origins", "privateOrigins", "tokenEnv", "upstreamBaseUrl"}:
                raise ValueError("Unexpected managed profile setting")
            name, principal = item.get("name", identity), item.get("principalId", identity)
            if not isinstance(name, str) or not 0 < len(name) <= 100 or not isinstance(principal, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", principal):
                raise ValueError("Invalid managed profile label")
            origins, private = item.get("origins", []), item.get("privateOrigins", [])
            if not isinstance(origins, list) or not 1 <= len(origins) <= 20 or not isinstance(private, list) or len(private) > 20:
                raise ValueError("Managed profiles need explicit origins")
            allowed = tuple(_profile_origin(value) for value in origins)
            exceptions = tuple(_profile_origin(value) for value in private)
            if set(exceptions) - set(allowed):
                raise ValueError("Private origins must be explicitly allowed")
            for value in exceptions:
                # permits_address requires a literal host and refuses metadata,
                # multicast and unspecified addresses even under an exception.
                import ipaddress
                address = ipaddress.ip_address(urlsplit(value).hostname or "")
                if address.is_global or address.is_link_local or address.is_multicast or address.is_unspecified:
                    raise ValueError("Private origin must name a private literal address")
            reference = item.get("tokenEnv")
            if reference is not None and (not isinstance(reference, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", reference)):
                raise ValueError("Invalid profile credential reference")
            token = env.get(reference) if reference else None
            if token is not None and (not token or len(token) > 4096 or any(ord(char) < 33 or ord(char) == 127 for char in token)):
                raise ValueError("Invalid profile credential")
            profile = EgressProfile(identity, name, principal, token, allowed, exceptions)
            base = item.get("upstreamBaseUrl")
            if base is not None:
                base = profile.check(base, base=True)
            self.items[identity] = profile
            self.configured[identity] = reference is None or token is not None
            self.bases[identity] = base

    def get(self, identity: str) -> EgressProfile:
        if identity not in self.items or not self.configured.get(identity):
            raise EgressFailure("credential_profile_unavailable")
        return self.items[identity]

    def base(self, identity: str, raw: str | None) -> str:
        """Deployment-owned fixed bases are authority, not an editable UI hint."""
        profile = self.get(identity)
        fixed = self.bases[identity]
        if raw is None and fixed is not None:
            return fixed
        target = profile.check(raw, base=True)
        if fixed is not None and target != fixed:
            raise EgressFailure("profile_target_mismatch")
        return target

    def capabilities(self) -> dict:
        return {"credentialProfiles": [{"id": key, "name": value.name, "configured": self.configured[key],
                                        "upstreamBaseUrl": self.bases[key]} for key, value in self.items.items()],
                "guardDefinitions": [{"id": "orders.cancel_before_shipment", "name": "Cancel before shipment"}]}


def connection_fingerprint(base: str, profile: EgressProfile) -> str:
    return fingerprint({"baseUrl": str(httpx.URL(base)).rstrip("/"), "principalId": profile.principal_id})


def _outputs(spec: dict, operation: dict) -> list[str]:
    responses = operation.get("responses", {})
    if not isinstance(responses, dict):
        return []
    for status, raw in sorted(responses.items()):
        if not str(status).startswith("2"):
            continue
        response = _resolve(spec, raw)
        if not isinstance(response, dict):
            raise ValueError("Invalid response definition")
        content = response.get("content", {})
        if not isinstance(content, dict):
            raise ValueError("Invalid response content")
        media = content.get("application/json", {})
        if not isinstance(media, dict):
            raise ValueError("Invalid JSON response content")
        schema = _resolve(spec, media.get("schema", {}))
        if isinstance(schema, dict) and schema.get("type") == "array":
            schema = _resolve(spec, schema.get("items", {}))
        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        if isinstance(properties, dict):
            return [name for name in properties if isinstance(name, str) and SAFE_KEY.fullmatch(name)][:100]
    return []


def _scope_suggestion(parameters: list[dict], idempotency_headers: list[str]) -> dict:
    """Unconfirmed bindings make shape inspection possible, never authorize scope.

    Required custom identity headers must be reviewable rather than rejected
    solely because they differ from the example adapter's header names. At most
    two can be represented by the existing customer/business scope contract.
    """
    ignored = {name.lower() for name in idempotency_headers}
    required = {}
    for parameter in parameters:
        if parameter.get("in") != "header" or not parameter.get("required"):
            continue
        name = parameter.get("name")
        if isinstance(name, str) and name.lower() in ignored:
            continue
        if not isinstance(name, str) or not HEADER.fullmatch(name) or name.lower() in PROTECTED_HEADERS:
            raise Unsupported("Required header is outside the reviewed scope profile")
        required[name.lower()] = name
    if len(required) > 2:
        raise Unsupported("Required headers exceed the two trusted scope bindings")
    scope = {"customerId": {"in": "header", "name": "X-Customer-Id"},
             "businessId": {"in": "header", "name": "X-Business-Id"}}
    assigned = set()
    for role, default in (("customerId", "x-customer-id"), ("businessId", "x-business-id")):
        if default in required:
            scope[role]["name"] = required.pop(default)
            assigned.add(role)
    for name in required.values():
        role = next(role for role in ("customerId", "businessId") if role not in assigned)
        scope[role] = {"in": "header", "name": name}
        assigned.add(role)
    return scope


def candidates(spec: dict) -> list[dict]:
    result = []
    for path, raw_item in sorted(spec.get("paths", {}).items()):
        if not isinstance(path, str) or len(path) > 500:
            raise ValueError("Invalid operation path")
        item = _resolve(spec, raw_item)
        if not isinstance(item, dict):
            raise ValueError("Invalid operation definition")
        for method in HTTP_METHODS:
            if method not in item:
                continue
            operation = item[method]
            if not isinstance(operation, dict):
                raise ValueError("Invalid operation definition")
            key = f"{method.upper()} {path}"
            outputs = _outputs(spec, operation)
            suggested_scope = {"customerId": {"in": "header", "name": "X-Customer-Id"},
                               "businessId": {"in": "header", "name": "X-Business-Id"}}
            candidate = {"operationKey": key, "method": method.upper(), "path": path,
                         "title": str(operation.get("summary") or operation.get("operationId") or key)[:200],
                         "description": str(operation.get("description") or "")[:2000],
                         "tags": [value[:100] for value in operation.get("tags", []) if isinstance(value, str)][:20],
                         "supported": False, "reasonCode": "unsupported_method", "inputSchema": None, "parameters": {},
                         "scope": suggested_scope, "outputFields": outputs[:30], "outputCandidates": outputs,
                         "proposedEffect": "unknown", "idempotencyHeaderCandidates": []}
            if method in METHODS:
                try:
                    parameters = [_resolve(spec, raw) for raw in [*item.get("parameters", []), *operation.get("parameters", [])]]
                    if not all(isinstance(parameter, dict) for parameter in parameters):
                        raise Unsupported("Invalid parameter definition")
                    # Operation parameters override a path-level declaration.
                    parameters = list({(parameter.get("in"), parameter.get("name")): parameter for parameter in parameters}.values())
                    headers = [parameter.get("name") for parameter in parameters if parameter.get("in") == "header"
                               and isinstance(parameter.get("name"), str) and parameter["name"].lower() in ("idempotency-key", "x-idempotency-key")]
                    candidate["idempotencyHeaderCandidates"] = headers
                    suggested_scope = _scope_suggestion(parameters, headers)
                    candidate["scope"] = suggested_scope
                    # This temporary object extracts supported input shape only.
                    # The validator permits idempotency only for write shapes;
                    # that internal probe result is never published or installed.
                    # Exposed proposedEffect remains unknown until explicit review.
                    review = {"effect": "write" if headers else "unknown", "scope": suggested_scope, "outputFields": outputs[:30] or ["_preview"]}
                    if headers:
                        review["idempotency"] = {"header": headers[0]}
                    probe = _operation(spec, method, path, item, operation, review)
                    candidate.update(supported=True, reasonCode=None, inputSchema=probe["inputSchema"], parameters=probe["parameters"])
                except (Unsupported, TypeError, KeyError, AttributeError, ValueError):
                    candidate["reasonCode"] = "unsupported_schema_or_mapping"
            result.append(candidate)
            if len(result) > 1000:
                raise ValueError("Too many operations")
    return result


async def prepare(payload: dict, profiles: Profiles) -> dict:
    if set(payload) - {"integrationId", "specUrl", "upstreamBaseUrl", "credentialProfileId"} or not ID.fullmatch(str(payload.get("integrationId", ""))):
        raise ValueError("Invalid prepare request")
    profile = profiles.get(payload.get("credentialProfileId", "none"))
    source = profile.check(payload.get("specUrl"))
    requested_base = payload.get("upstreamBaseUrl")
    if requested_base is None and profiles.bases[profile.id] is None:
        requested_base = origin(source)
    base = profiles.base(profile.id, requested_base)
    # Allowed egress origins are not permission to disclose the upstream bearer
    # to a different documentation service. Cross-origin specs must be public.
    source_profile = profile if origin(source) == origin(base) else replace(profile, token=None)
    async with safe_client(origin(source), source_profile, timeout=8.0, max_bytes=5_000_000) as client:
        response = await client.get(source)
    if 300 <= response.status_code < 400:
        raise EgressFailure("redirect_refused")
    if response.status_code in (401, 403):
        raise EgressFailure("spec_unauthorized")
    if response.status_code != 200:
        raise EgressFailure("spec_unavailable")
    media = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media != "application/json" and not (media.startswith("application/") and media.endswith("+json")):
        raise EgressFailure("openapi_json_required")
    spec = strict_json(response.content)
    if not isinstance(spec, dict) or not re.fullmatch(r"3\.[01]\.\d+", str(spec.get("openapi", ""))) or not isinstance(spec.get("paths"), dict) or spec.get("webhooks"):
        raise ValueError("Unsupported OpenAPI document")
    return await asyncio.to_thread(compile_limited, _preview, spec, base, profile)


def _preview(spec: dict, base: str, profile: EgressProfile) -> dict:
    normalized = normalize_spec(spec)
    return {"spec": normalized, "specHash": fingerprint(normalized), "upstreamBaseUrl": normalize_url(base, base=True),
            "upstreamTargetFingerprint": connection_fingerprint(base, profile), "credentialProfileId": profile.id,
            "principalId": profile.principal_id, "operations": candidates(normalized)}


def compile_review(payload: dict, profiles: Profiles) -> dict:
    if set(payload) - {"spec", "integrationId", "upstreamBaseUrl", "credentialProfileId", "review"} or not ID.fullmatch(str(payload.get("integrationId", ""))):
        raise ValueError("Invalid compile request")
    profile = profiles.get(payload.get("credentialProfileId", "none"))
    base = profiles.base(profile.id, payload.get("upstreamBaseUrl"))
    spec = normalize_spec(payload["spec"])
    review = payload["review"]
    if not isinstance(review, dict) or not isinstance(review.get("operations"), dict) or len(review["operations"]) > 1000:
        raise ValueError("Explicit operation review required")
    manifest, report = build_manifest(spec, {"integrationId": payload["integrationId"], "operations": review["operations"]})
    included = {row["operationKey"] for row in report["operations"] if row["status"] == "included"}
    if included != set(review["operations"]) or not manifest["operations"] or any(op["effect"] == "unknown" for op in manifest["operations"]):
        raise ValueError("Selected operations need supported explicit definitions")
    report["mechanicalTools"] = compile_inventory(spec, manifest)
    return {"manifest": manifest, "report": report, "upstreamTargetFingerprint": connection_fingerprint(base, profile), "principalId": profile.principal_id}
