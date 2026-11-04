"""Semantic checks on reviewed artifacts before serving any tool, independent of fingerprints."""
from __future__ import annotations

import math
import re
from typing import Any

SAFE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
HEADER = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,63}$")
RESERVED = {"__proto__", "constructor", "prototype", "eldhall"}
PROTECTED_HEADERS = {"authorization", "proxy-authorization", "host", "content-length", "transfer-encoding", "connection", "cookie", "set-cookie", "content-type", "accept"}
OP_FIELDS = {"operationKey", "operationId", "toolName", "method", "path", "title", "description", "tags", "effect", "inputSchema", "parameters", "scope", "outputFields", "guard", "idempotency", "reconciliation", "operationHash"}


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def safe(value: Any) -> bool:
    return isinstance(value, str) and bool(SAFE.fullmatch(value)) and value not in RESERVED


def text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def scalar(value: Any) -> bool:
    return value is None or type(value) in (str, bool, int) or type(value) is float and math.isfinite(value)


def validate_schema(schema: Any, depth: int = 0) -> None:
    from .manifest import KEPT, SCHEMA_TYPES
    require(isinstance(schema, dict) and depth <= 5, "invalid or too deep input schema")
    require(not set(schema) - KEPT and schema.get("type") in SCHEMA_TYPES, "unsupported input schema")
    kind = schema["type"]
    if "description" in schema:
        require(isinstance(schema["description"], str) and len(schema["description"]) <= 500, "invalid schema description")
    if kind == "object":
        properties = schema.get("properties")
        require(isinstance(properties, dict) and len(properties) <= 30 and schema.get("additionalProperties") is False, "object schema must be bounded and closed")
        for name, sub in properties.items():
            require(safe(name), "unsafe schema property")
            validate_schema(sub, depth + 1)
        required = schema.get("required", [])
        require(isinstance(required, list) and all(isinstance(v, str) and v in properties for v in required) and len(required) == len(set(required)), "invalid required properties")
    else:
        require(not {"properties", "required", "additionalProperties"} & set(schema), "object keywords on non-object schema")
    if kind == "array":
        validate_schema(schema.get("items"), depth + 1)
    else:
        require("items" not in schema, "items on non-array schema")
    for name, maximum in (("maxLength", 4000), ("maxItems", 50)):
        if name in schema:
            require(type(schema[name]) is int and 0 <= schema[name] <= maximum, "invalid schema bound")
    for name in ("minimum", "maximum"):
        if name in schema:
            require(type(schema[name]) in (int, float) and math.isfinite(schema[name]), "invalid numeric bound")
    if "enum" in schema:
        values = schema["enum"]
        require(isinstance(values, list) and 0 < len(values) <= 50 and all(scalar(v) for v in values), "invalid enum")


def validate_operation(op: Any) -> None:
    from .adapters import GUARDS
    require(isinstance(op, dict) and set(op) == OP_FIELDS, "invalid operation fields")
    require(op["method"] in ("GET", "POST", "PUT", "PATCH", "DELETE"), "unsupported method")
    path = op["path"]
    require(isinstance(path, str) and bool(re.fullmatch(r"/[A-Za-z0-9._~\-/{}]{0,499}", path)) and not path.startswith("//"), "invalid path")
    require(not any(part in (".", "..") for part in path.split("/")), "literal dot path segments are forbidden")
    path_names = re.findall(r"\{([^{}]+)\}", path)
    require("{" not in re.sub(r"\{[^{}]+\}", "", path) and "}" not in re.sub(r"\{[^{}]+\}", "", path) and all(safe(n) for n in path_names), "invalid path placeholders")
    require(len(set(path_names)) == len(path_names), "duplicate path placeholder")
    require(op["operationKey"] == f"{op['method']} {path}", "operationKey must match method and path")
    require(op["operationId"] is None or text(op["operationId"], 128), "invalid operationId")
    require(text(op["toolName"], 128) and bool(re.fullmatch(r"[A-Za-z0-9_.-]+", op["toolName"])) and op["toolName"] != "get_connector_manifest", "invalid or reserved toolName")
    require(text(op["title"], 200) and text(op["description"], 500), "invalid operation text")
    require(isinstance(op["tags"], list) and len(op["tags"]) <= 20 and all(text(t, 100) for t in op["tags"]), "invalid tags")
    require(op["effect"] in ("read", "write", "unknown"), "invalid effect")
    validate_schema(op["inputSchema"])
    require(op["inputSchema"]["type"] == "object", "operation input must be an object")
    properties = op["inputSchema"]["properties"]
    mappings = op["parameters"]
    require(isinstance(mappings, dict) and set(mappings) == set(properties) and all(v in ("path", "query", "body") for v in mappings.values()), "inputs require exact parameter mappings")
    scope = op["scope"]
    require(isinstance(scope, dict) and "customerId" in scope and not set(scope) - {"customerId", "businessId"}, "invalid trusted scope")
    destinations: set[tuple[str, str]] = set()
    for binding in scope.values():
        require(isinstance(binding, dict) and set(binding) == {"in", "name"}, "invalid scope binding")
        location, name = binding["in"], binding["name"]
        require(location in ("path", "query", "body", "header") and (bool(HEADER.fullmatch(name)) if isinstance(name, str) and location == "header" else safe(name)), "invalid scope destination")
        require(name not in properties, "model input cannot supply scope")
        destination = (location, name.lower() if location == "header" else name)
        require(destination not in destinations, "scope destinations must be distinct")
        destinations.add(destination)
        if location == "header":
            require(name.lower() not in PROTECTED_HEADERS, "scope cannot override protected headers")
    sources = [name for name, loc in mappings.items() if loc == "path"] + [b["name"] for b in scope.values() if b["in"] == "path"]
    require(sorted(sources) == sorted(path_names), "path sources must match placeholders")
    require(all(name in op["inputSchema"].get("required", []) for name in path_names if name in properties), "path inputs must be required")
    output = op["outputFields"]
    require(isinstance(output, list) and 0 < len(output) <= 30 and all(safe(n) for n in output) and len(set(output)) == len(output), "invalid output projection")
    require(op["guard"] is None or op["guard"] in GUARDS, "unknown adapter guard")
    if op["idempotency"] is not None:
        key = op["idempotency"]
        require(isinstance(key, dict) and set(key) == {"header"} and isinstance(key["header"], str) and bool(HEADER.fullmatch(key["header"])), "invalid idempotency mapping")
        require(op["effect"] == "write" and key["header"].lower() not in PROTECTED_HEADERS and ("header", key["header"].lower()) not in destinations, "idempotency header collision or non-write")
    reconciliation = op["reconciliation"]
    require(reconciliation is None or isinstance(reconciliation, dict) and set(reconciliation) == {"operationKey"} and text(reconciliation["operationKey"], 600), "invalid reconciliation")
    if op["guard"] == "orders.cancel_before_shipment":
        require(op["effect"] == "write" and op["idempotency"] is not None and reconciliation is not None and "order_id" in properties, "orders cancel guard needs write, order_id, idempotency and reconciliation")


def validate_manifest(manifest: Any) -> None:
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "generatorVersion", "adapterContractVersion", "integrationId", "specHash", "operations", "manifestHash"}, "invalid manifest fields")
    require(text(manifest["generatorVersion"], 100) and isinstance(manifest["integrationId"], str) and bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", manifest["integrationId"])), "invalid manifest identity")
    require(all(isinstance(manifest[k], str) and bool(re.fullmatch(r"[a-f0-9]{64}", manifest[k])) for k in ("specHash", "manifestHash")), "invalid manifest hash")
    operations = manifest["operations"]
    require(isinstance(operations, list) and len(operations) <= 1000, "invalid operation catalog")
    for op in operations:
        validate_operation(op)
        require(isinstance(op["operationHash"], str) and bool(re.fullmatch(r"[a-f0-9]{64}", op["operationHash"])), "invalid operationHash")
    for key in ("operationKey", "toolName", "operationId"):
        values = [op[key] for op in operations if op[key] is not None]
        require(len(values) == len(set(values)), f"duplicate {key}")
    by_key = {op["operationKey"]: op for op in operations}
    for op in operations:
        if op["reconciliation"]:
            target = by_key.get(op["reconciliation"]["operationKey"])
            require(target is not None and target["effect"] == "read" and target["guard"] is None, "reconciliation must name an unguarded read")
            if op["guard"] == "orders.cancel_before_shipment":
                require(target["inputSchema"]["properties"].get("order_id", {}).get("type") == "string" and target["scope"] == op["scope"] and "status" in target["outputFields"] and "order_id" in target["outputFields"], "cancel guard needs a scoped order-status reconciliation read")
