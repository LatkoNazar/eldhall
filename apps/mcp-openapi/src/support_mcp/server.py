"""Scoped MCP sidecar: serves exactly the reviewed manifest operations and calls the deployment-owned upstream.

The TS backend is the only caller (service bearer). It decides auto/ask/deny and passes trusted scope in the
reserved `eldhall` argument; the model never reaches this service. Upstream still enforces its own authorization.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import sys
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
import uvicorn
from fastmcp import FastMCP
from fastmcp.tools import ToolResult
from fastmcp.tools.base import Tool
from mcp.types import TextContent, ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .manifest import verify

RESERVED = "eldhall"
SCOPE_SCHEMA = {
    "type": "object",
    "properties": {
        "customerId": {"type": "string", "maxLength": 200},
        "businessId": {"type": "string", "maxLength": 200},
        "idempotencyKey": {"type": "string", "maxLength": 200},
    },
    "required": ["customerId"],
    "additionalProperties": False,
}
MAX_UPSTREAM_BYTES = 131_072
Scalar = (str, int, float, bool, type(None))


class Rejected(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def build_request(op: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    """Map model input + trusted scope onto method/path/query/body/headers exactly as the manifest says."""
    arguments = dict(arguments)
    trusted = arguments.pop(RESERVED, None)
    if not isinstance(trusted, dict) or not isinstance(trusted.get("customerId"), str) or not trusted["customerId"]:
        raise Rejected("scope_missing")
    if set(arguments) - set(op["parameters"]):
        raise Rejected("unexpected_input")
    if any(name not in arguments for name in op["inputSchema"].get("required", [])):
        raise Rejected("missing_input")
    path, query, body, headers = op["path"], {}, {}, {}

    def place(where: str, name: str, value: Any) -> None:
        nonlocal path
        if where == "path":
            segment = str(value)
            # quote() keeps "." and "..", and HTTP clients normalize them: /orders/../cancel would become /cancel.
            if segment in ("", ".", ".."):
                raise Rejected("invalid_path_value")
            path = path.replace("{" + name + "}", quote(segment, safe=""))
        elif where == "query":
            query[name] = value
        elif where == "body":
            body[name] = value
        else:
            headers[name] = str(value)

    for name, value in arguments.items():
        place(op["parameters"][name], name, value)
    for key, binding in op["scope"].items():
        value = trusted.get(key)
        if not isinstance(value, str) or not value:
            raise Rejected("scope_missing")
        place(binding["in"], binding["name"], value)
    if op["idempotency"]:
        key = trusted.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise Rejected("idempotency_key_missing")
        headers[op["idempotency"]["header"]] = key
    if "{" in path:
        raise Rejected("path_unresolved")
    return {"method": op["method"], "url": path, "params": query, "headers": headers, **({"json": body} if body else {})}


def project(value: Any, fields: list[str]) -> Any:
    """Approved flat fields only; nested objects cannot smuggle extra data."""
    def row(item: Any) -> dict:
        if not isinstance(item, dict):
            raise Rejected("invalid_output")
        clean = {}
        for field in fields:
            v = item.get(field, ...)
            if isinstance(v, Scalar) and v is not ...:
                clean[field] = v
            elif isinstance(v, list) and len(v) <= 50 and all(isinstance(x, Scalar) for x in v):
                clean[field] = v
        return clean
    if isinstance(value, list):
        if len(value) > 50:
            raise Rejected("invalid_output")
        return [row(item) for item in value]
    return row(value)


def _status_code(status: int) -> str:
    return {401: "upstream_auth", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "rejected"}.get(status, "rejected")


class OperationTool(Tool):
    operation: dict
    upstream: Any  # httpx.AsyncClient; pydantic cannot validate it
    deadline: float = 4.0  # total seconds for the upstream call; httpx timeouts are per phase

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        op = self.operation
        try:
            request = build_request(op, arguments)
        except Rejected as error:
            return _error(error.code, effect=False)
        write = op["effect"] == "write"
        try:
            response = await asyncio.wait_for(self.upstream.request(**request), self.deadline)
        except (httpx.TimeoutException, TimeoutError):
            # A write may have committed upstream; only reconciliation can tell.
            return _error("outcome_unknown" if write else "timeout", effect=None if write else False)
        except httpx.HTTPError:
            return _error("outcome_unknown" if write else "unavailable", effect=None if write else False)
        if response.status_code >= 500:
            return _error("outcome_unknown" if write else "unavailable", effect=None if write else False)
        if write and (300 <= response.status_code < 400 or response.status_code == 408):
            # Redirects are not followed and 408 is ambiguous: a write may already have committed (POST-redirect-GET).
            return _error("outcome_unknown", effect=None)
        if response.status_code >= 300:
            # Confirmed rejection without effect. Raw upstream bodies/headers never leave this process.
            return _error(_status_code(response.status_code), effect=False)
        if len(response.content) > MAX_UPSTREAM_BYTES:
            return _error("invalid_output", effect=None if write else False)
        try:
            data = project(response.json() if response.content else {}, op["outputFields"])
        except (ValueError, Rejected):
            return _error("invalid_output", effect=None if write else False)
        text = json.dumps(data, ensure_ascii=False)
        return ToolResult(content=[TextContent(type="text", text=text)], structured_content=data if isinstance(data, dict) else None)


def _error(code: str, effect: bool | None) -> ToolResult:
    """effect False = confirmed no change; None = unknown (writes only)."""
    payload = {"error": code, "effect": "none" if effect is False else "unknown"}
    return ToolResult(content=[TextContent(type="text", text=json.dumps(payload))], structured_content=payload, is_error=True)


def create_server(manifest: dict, upstream: httpx.AsyncClient, deadline: float = 4.0) -> FastMCP:
    verify(manifest)
    mcp = FastMCP(name=f"eldhall-{manifest['integrationId']}", mask_error_details=True)
    for op in manifest["operations"]:
        if op["effect"] not in ("read", "write"):
            continue  # unknown effect stays out of the catalog until reviewed
        schema = json.loads(json.dumps(op["inputSchema"]))
        schema["properties"][RESERVED] = SCOPE_SCHEMA
        schema["required"] = [*schema.get("required", []), RESERVED]
        read = op["effect"] == "read"
        mcp.add_tool(OperationTool(
            name=op["toolName"], description=op["description"], parameters=schema, operation=op, upstream=upstream, deadline=deadline,
            annotations=ToolAnnotations(read_only_hint=read, destructive_hint=not read, idempotent_hint=read or bool(op["idempotency"]), open_world_hint=True),
        ))
    catalog = {op["toolName"]: op["operationHash"] for op in manifest["operations"] if op["effect"] in ("read", "write")}

    @mcp.tool(name="get_connector_manifest", annotations=ToolAnnotations(read_only_hint=True))
    def get_connector_manifest() -> dict:
        """Backend-only compatibility check: loaded manifest and tool fingerprints."""
        return {"integrationId": manifest["integrationId"], "manifestHash": manifest["manifestHash"], "adapterContractVersion": manifest["adapterContractVersion"], "tools": catalog}

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse({"status": "ok", "manifestHash": manifest["manifestHash"]})

    return mcp


class ServiceAuth:
    """Every MCP request needs the backend's service bearer. /health stays open for container checks."""

    def __init__(self, app: Any, token: str):
        self.app, self.expected = app, f"Bearer {token}".encode()

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and scope["path"] != "/health":
            supplied = dict(scope["headers"]).get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self.expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


# Keep the upstream timeout below the backend's MCP call timeout (catalog.ts, 5 s by default):
# otherwise a slow upstream success arrives after the backend gave up and is recorded as `unknown`.
def build_app(manifest: dict, upstream_url: str, upstream_token: str | None, service_token: str, timeout: float = 4.0,
              allowed_hosts: tuple[str, ...] = (), allow_insecure_upstream: bool = False) -> Any:
    if len(service_token) < 16:
        raise ValueError("MCP_SERVICE_TOKEN must be at least 16 characters")
    upstream = urlsplit(upstream_url)
    if upstream.scheme not in ("http", "https") or not upstream.hostname or upstream.username or upstream.password or upstream.query or upstream.fragment:
        raise ValueError("UPSTREAM_BASE_URL must be an http(s) URL without credentials, query or fragment")
    # The upstream token and customer data must not cross a network in cleartext: plain HTTP is accepted for a
    # private service name (one DNS label) or loopback, or when the operator opts in explicitly.
    private = "." not in upstream.hostname or upstream.hostname in ("127.0.0.1", "::1")
    if upstream.scheme == "http" and not private and not allow_insecure_upstream:
        raise ValueError("UPSTREAM_BASE_URL must use https for a non-private host (set UPSTREAM_ALLOW_INSECURE_HTTP=true only for a trusted private network)")
    headers = {"authorization": f"Bearer {upstream_token}"} if upstream_token else {}
    client = httpx.AsyncClient(base_url=upstream_url, headers=headers, timeout=timeout, follow_redirects=False)
    # Host header validation (DNS rebinding): localhost names plus the service name the backend dials (MCP_ALLOWED_HOSTS).
    app = create_server(manifest, client, timeout).http_app(path="/mcp", json_response=True, stateless_http=True,
                                                          host_origin_protection=True, allowed_hosts=list(allowed_hosts))
    return ServiceAuth(app, service_token)


def _settings(env: os._Environ[str] | dict[str, str]) -> dict[str, Any]:
    """Read and check the environment; messages name settings, never values."""
    missing = [name for name in ("MANIFEST_PATH", "UPSTREAM_BASE_URL", "MCP_SERVICE_TOKEN") if not env.get(name)]
    if missing:
        raise ValueError(f"missing required setting(s): {', '.join(missing)}")
    try:
        timeout = float(env.get("UPSTREAM_TIMEOUT_SECONDS", "4"))
        port = int(env.get("PORT", "8000"))
    except ValueError:
        raise ValueError("UPSTREAM_TIMEOUT_SECONDS and PORT must be numbers") from None
    if not 0 < timeout <= 30 or not 0 < port < 65536:
        raise ValueError("UPSTREAM_TIMEOUT_SECONDS must be in (0, 30] and PORT in 1..65535")
    hosts = tuple(host.strip() for host in env.get("MCP_ALLOWED_HOSTS", "").split(",") if host.strip())
    if any(not re.fullmatch(r"[a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?", host) for host in hosts):
        raise ValueError("MCP_ALLOWED_HOSTS must be a comma-separated list of hostnames")
    insecure = env.get("UPSTREAM_ALLOW_INSECURE_HTTP", "false")
    if insecure not in ("true", "false"):
        raise ValueError("UPSTREAM_ALLOW_INSECURE_HTTP must be true or false")
    return {"timeout": timeout, "port": port, "hosts": hosts, "insecure": insecure == "true"}


def main() -> None:
    env = os.environ
    try:
        settings = _settings(env)
        with open(env["MANIFEST_PATH"], encoding="utf-8") as file:
            manifest = json.load(file)
        app = build_app(manifest, env["UPSTREAM_BASE_URL"], env.get("UPSTREAM_TOKEN"), env["MCP_SERVICE_TOKEN"], settings["timeout"], settings["hosts"], settings["insecure"])
    except (OSError, ValueError) as error:
        # The reason is printed so an operator can act on it; it contains setting names or file errors, no secrets.
        print(f"MCP sidecar configuration invalid: {error}", file=sys.stderr)
        sys.exit(1)
    uvicorn.run(app, host=env.get("HOST", "127.0.0.1"), port=settings["port"], log_level="warning")


if __name__ == "__main__":
    main()
