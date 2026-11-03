"""OpenAPI 3.0/3.1 -> reviewed manifest (docs/integrations-manifest.md). Deterministic, no LLM, no network."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

MANIFEST_SCHEMA_VERSION = 1
ADAPTER_CONTRACT_VERSION = 1
GENERATOR_VERSION = "support-mcp-openapi/0.1.0"
METHODS = ("get", "post", "put", "patch", "delete")
SAFE_KEY = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,63}$")
RESERVED_KEYS = {"__proto__", "constructor", "prototype", "eldhall"}
SCHEMA_TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}
# Keywords copied to the bounded model schema; ignorable ones are dropped; anything else makes the operation unsupported.
KEPT = {"type", "description", "enum", "maxLength", "maxItems", "minimum", "maximum", "properties", "required", "items", "additionalProperties"}
IGNORED = {"title", "example", "examples", "default", "format", "minLength", "minItems", "pattern", "readOnly", "writeOnly", "deprecated", "nullable"}


class Unsupported(Exception):
    """The operation cannot be represented faithfully; it is reported, never silently widened."""


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value: Any, omit: str | None = None) -> str:
    if omit and isinstance(value, dict):
        value = {k: v for k, v in value.items() if k != omit}
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _ints(value: Any) -> Any:
    """Integral floats must serialize like JavaScript (1, not 1.0) or the hashes diverge."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_ints(v) for v in value]
    if isinstance(value, dict):
        return {k: _ints(v) for k, v in value.items()}
    return value


def _resolve(spec: dict, node: Any, seen: tuple[str, ...] = ()) -> Any:
    if not isinstance(node, dict) or "$ref" not in node:
        return node
    ref = node["$ref"]
    if not isinstance(ref, str) or not ref.startswith("#/"):
        raise Unsupported(f"non-local $ref {ref!r}")
    if ref in seen or len(seen) > 20:
        raise Unsupported(f"cyclic or too deep $ref {ref}")
    target: Any = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(target, dict) or part not in target:
            raise Unsupported(f"unresolvable $ref {ref}")
        target = target[part]
    return _resolve(spec, target, (*seen, ref))


def _schema(spec: dict, node: Any, depth: int = 0) -> dict:
    node = _resolve(spec, node)
    if not isinstance(node, dict) or depth > 5:
        raise Unsupported("schema missing or nested deeper than 5")
    unknown = set(node) - KEPT - IGNORED
    if unknown:
        raise Unsupported(f"unsupported schema keywords {sorted(unknown)}")
    if node.get("format") in ("binary", "byte"):
        raise Unsupported("binary payloads are not supported")
    kind = node.get("type")
    if not isinstance(kind, str) or kind not in SCHEMA_TYPES:
        raise Unsupported(f"schema type {kind!r} must be one supported type")
    out: dict[str, Any] = {"type": kind}
    if isinstance(node.get("description"), str) and node["description"]:
        out["description"] = node["description"][:500]
    if kind == "object":
        if node.get("additionalProperties") not in (None, False):
            raise Unsupported("open-ended objects are not supported")
        props = node.get("properties", {})
        if not isinstance(props, dict) or len(props) > 30:
            raise Unsupported("object properties missing or more than 30")
        out["properties"] = {}
        for key, sub in props.items():
            if not SAFE_KEY.match(key) or key in RESERVED_KEYS:
                raise Unsupported(f"unsafe property name {key!r}")
            out["properties"][key] = _schema(spec, sub, depth + 1)
        required = [k for k in node.get("required", []) if k in out["properties"]]
        if required:
            out["required"] = required
        out["additionalProperties"] = False
    if kind == "array":
        out["items"] = _schema(spec, node.get("items"), depth + 1)
        out["maxItems"] = min(int(node.get("maxItems", 50)), 50)
    if kind == "string" and "maxLength" in node:
        out["maxLength"] = min(int(node["maxLength"]), 4000)
    if "enum" in node:
        enum = node["enum"]
        if not isinstance(enum, list) or not 0 < len(enum) <= 50 or any(not (v is None or isinstance(v, (str, int, float, bool))) for v in enum):
            raise Unsupported("enum must be 1..50 scalars")
        out["enum"] = enum
    for bound in ("minimum", "maximum"):
        if bound in node and kind in ("number", "integer"):
            out[bound] = node[bound]
    return _ints(out)


def tool_name(operation_id: str | None, method: str, path: str) -> str:
    base = re.sub(r"(?<!^)(?=[A-Z])", "_", operation_id).lower() if operation_id else f"{method}_{path}"
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", base).strip("_")[:128] or "operation"


def _operation(spec: dict, method: str, path: str, path_item: dict, op: dict, review: dict) -> dict:
    key = f"{method.upper()} {path}"
    scope = review.get("scope")
    if not isinstance(scope, dict) or "customerId" not in scope:
        raise Unsupported("review must bind trusted scope.customerId")
    scope_names = {b["name"].lower() if b["in"] == "header" else b["name"] for b in scope.values()}
    idempotency = review.get("idempotency")
    skip_headers = scope_names | ({idempotency["header"].lower()} if idempotency else set())

    properties: dict[str, Any] = {}
    required: list[str] = []
    mapping: dict[str, str] = {}
    params = {}
    for raw in [*path_item.get("parameters", []), *op.get("parameters", [])]:
        p = _resolve(spec, raw)
        params[(p.get("in"), p.get("name"))] = p  # operation-level overrides path-level
    for (where, name), p in params.items():
        if where == "header":
            if name.lower() in skip_headers:
                continue
            if p.get("required"):
                raise Unsupported(f"required header {name!r} is neither scope nor idempotency")
            continue  # optional headers are not exposed to the model
        if where == "cookie":
            if p.get("required"):
                raise Unsupported(f"required cookie {name!r}")
            continue
        if where not in ("path", "query"):
            raise Unsupported(f"parameter location {where!r}")
        if name in scope_names:
            continue
        if not SAFE_KEY.match(name) or name in RESERVED_KEYS:
            raise Unsupported(f"unsafe parameter name {name!r}")
        properties[name] = _schema(spec, p.get("schema"))
        if p.get("description") and "description" not in properties[name]:
            properties[name]["description"] = p["description"][:500]
        mapping[name] = where
        if where == "path" or p.get("required"):
            required.append(name)

    body = _resolve(spec, op.get("requestBody")) if op.get("requestBody") else None
    if body:
        content = body.get("content", {})
        if set(content) != {"application/json"}:
            raise Unsupported(f"request body media types {sorted(content)}")
        schema = _schema(spec, content["application/json"].get("schema"))
        if schema["type"] != "object":
            raise Unsupported("request body must be a JSON object")
        for name, sub in schema["properties"].items():
            if name in properties or name in scope_names:
                raise Unsupported(f"body field {name!r} collides with a parameter or scope")
            properties[name] = sub
            mapping[name] = "body"
            if body.get("required") and name in schema.get("required", []):
                required.append(name)

    input_schema: dict[str, Any] = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        input_schema["required"] = required
    operation_id = op.get("operationId") if isinstance(op.get("operationId"), str) else None
    summary = op.get("summary") if isinstance(op.get("summary"), str) else None
    description = op.get("description") if isinstance(op.get("description"), str) else None
    effect = review.get("effect", "unknown")
    if effect not in ("read", "write", "unknown"):
        raise Unsupported(f"review effect {effect!r}")
    output_fields = review.get("outputFields")
    if not isinstance(output_fields, list) or not output_fields:
        raise Unsupported("review must list approved outputFields")
    result = {
        "operationKey": key,
        "operationId": operation_id,
        "toolName": tool_name(operation_id, method, path),
        "method": method.upper(),
        "path": path,
        "title": (summary or key)[:200],
        "description": (description or summary or key)[:500],
        "tags": [t for t in op.get("tags", []) if isinstance(t, str)],
        "effect": effect,
        "inputSchema": input_schema,
        "parameters": mapping,
        "scope": scope,
        "outputFields": output_fields,
        "guard": review.get("guard"),
        "idempotency": idempotency,
        "reconciliation": review.get("reconciliation"),
    }
    result["operationHash"] = fingerprint(result)
    return result


def build_manifest(spec: dict, review: dict, previous: dict | None = None) -> tuple[dict, dict]:
    """Return (manifest, review report). Only operations with a review entry and a supported shape enter the manifest."""
    version = str(spec.get("openapi", ""))
    if not re.match(r"^3\.[01]\.\d+$", version):
        raise ValueError(f"OpenAPI {version or '?'} is not supported; expected 3.0.x or 3.1.x")
    reviews = review.get("operations", {})
    operations: list[dict] = []
    report: list[dict] = []
    for path, path_item in spec.get("paths", {}).items():
        path_item = _resolve(spec, path_item)
        for method in METHODS:
            if method not in path_item:
                continue
            key = f"{method.upper()} {path}"
            if key not in reviews:
                report.append({"operationKey": key, "status": "unreviewed"})
                continue
            try:
                operation = _operation(spec, method, path, path_item, path_item[method], reviews[key])
            except Unsupported as error:
                report.append({"operationKey": key, "status": "unsupported", "reason": str(error)})
                continue
            operations.append(operation)
            report.append({"operationKey": key, "status": "included", "effect": operation["effect"]})
    for key in reviews:
        if key not in {row["operationKey"] for row in report}:
            raise ValueError(f"review references {key}, which is not in the spec")
    names = [op["toolName"] for op in operations]
    if len(set(names)) != len(names):
        raise ValueError("duplicate toolName; set distinct operationIds")
    manifest: dict[str, Any] = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "adapterContractVersion": ADAPTER_CONTRACT_VERSION,
        "integrationId": review["integrationId"],
        "specHash": fingerprint(spec),
        "operations": operations,
    }
    manifest["manifestHash"] = fingerprint(manifest)
    return manifest, {"integrationId": review["integrationId"], "specHash": manifest["specHash"], "operations": report, "diff": diff(previous, manifest)}


def diff(previous: dict | None, current: dict) -> dict[str, list[str]]:
    before = {op["operationKey"]: op["operationHash"] for op in (previous or {}).get("operations", [])}
    after = {op["operationKey"]: op["operationHash"] for op in current["operations"]}
    return {
        "added": [k for k in after if k not in before],
        "changed": [k for k in after if k in before and before[k] != after[k]],
        "unchanged": [k for k in after if before.get(k) == after[k]],
        "removed": [k for k in before if k not in after],
    }


def verify(manifest: dict) -> None:
    """Refuse to serve a manifest whose content no longer matches its own hashes."""
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION or manifest.get("adapterContractVersion") != ADAPTER_CONTRACT_VERSION:
        raise ValueError("unsupported manifest schema or adapter contract version")
    for op in manifest["operations"]:
        if fingerprint(op, "operationHash") != op["operationHash"]:
            raise ValueError(f"operationHash mismatch for {op['operationKey']}")
    if fingerprint(manifest, "manifestHash") != manifest["manifestHash"]:
        raise ValueError("manifestHash mismatch")
