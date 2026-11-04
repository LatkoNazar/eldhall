"""Read deployment status without evaluating .env or changing files, containers or volumes.

Run over SSH with ``python3 - /absolute/deploy/root project-name < this-file``.
Only selected key-presence flags, container names/status and a release SHA are emitted.
Docker stderr, environment values, image references and filesystem paths stay private.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable


REQUIRED_KEYS = (
    "PROJECT_NAME", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "API_TOKEN", "OPERATOR_TOKEN",
    "UMAMI_POSTGRES_PASSWORD", "UMAMI_APP_SECRET", "ALLOWED_HOSTS",
)
OPTIONAL_KEYS = (
    "POSTGRES_DB", "POSTGRES_USER", "UMAMI_POSTGRES_DB", "UMAMI_POSTGRES_USER",
    "DATABASE_URL", "SUPPORT_STORE", "DEMO_RESET_ENABLED", "AGENT_RUNTIME", "LLM_PROVIDER",
    "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "SUPPORT_CONFIG_FILE", "COMPOSE_PROJECT_NAME",
    "PUBLIC_APP_URL", "DOMAIN", "ACME_EMAIL", "LANDING_DOMAIN", "UMAMI_DOMAIN",
)
ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
PS_FORMAT = '{"name":{{json .Names}},"state":{{json .State}},"status":{{json .Status}}}'
Runner = Callable[[list[str]], subprocess.CompletedProcess[str]]


def literal_has_value(value: str) -> bool:
    """A lexical presence check only: never expand shell or Compose expressions."""
    value = value.strip()
    if not value or value.startswith("#"):
        return False
    if value[0] in ("'", '"'):
        quote = value[0]
        # The first quoted segment is enough to distinguish empty declarations.
        # Escapes/interpolation are deliberately not evaluated.
        return bool(value[1:].split(quote, 1)[0].strip())
    return bool(re.split(r"\s+#", value, maxsplit=1)[0].strip())


def environment_presence(path: Path, required: set[str]) -> dict:
    keys = {name: {"required": name in required, "present": False, "nonempty_literal": False}
            for name in sorted(set(REQUIRED_KEYS) | set(OPTIONAL_KEYS))}
    result = {"exists": path.is_file(), "readable": False, "status": "missing", "keys": keys}
    try:
        if path.stat().st_size > 1_048_576:
            result["status"] = "too_large"
            return result
        with path.open(encoding="utf-8-sig") as handle:
            for line in handle:
                matched = ASSIGNMENT.match(line)
                if matched and matched[1] in keys:
                    keys[matched[1]]["present"] = True
                    keys[matched[1]]["nonempty_literal"] = literal_has_value(matched[2])
        result.update(readable=True, status="ok")
    except (OSError, UnicodeError):
        result["status"] = "unavailable" if result["exists"] else "missing"
    return result


def readonly_command(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(arguments, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=12, check=False)
    except (OSError, subprocess.TimeoutExpired):
        # Exception messages/stderr can contain private daemon details. Never print them.
        return subprocess.CompletedProcess(arguments, 1, "", "")


def container_status(project: str, run: Runner) -> dict:
    result = run(["docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", PS_FORMAT])
    if result.returncode:
        return {"status": "unavailable", "containers": []}
    containers = []
    try:
        if len(result.stdout) > 1_048_576:
            raise ValueError("bounded response")
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            name = item.get("name")
            state = item.get("state")
            status = item.get("status", "")
            if not isinstance(status, str):
                raise ValueError("invalid response")
            health = "unhealthy" if "(unhealthy)" in status else "healthy" if "(healthy)" in status else "starting" if "(health: starting)" in status else "none"
            containers.append({"name": name if isinstance(name, str) and SAFE_NAME.fullmatch(name) else "redacted-name",
                               "state": state if state in ("created", "running", "paused", "restarting", "removing", "exited", "dead") else "unknown",
                               "health": health})
    except (ValueError, TypeError, AttributeError):
        return {"status": "invalid_response", "containers": []}
    return {"status": "ok", "containers": sorted(containers, key=lambda item: item["name"])}


def analytics_volume_status(project: str, run: Runner) -> dict:
    expected = f"{project}_umami_postgres_data"
    labelled = run(["docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}",
                    "--filter", "label=com.docker.compose.volume=umami_postgres_data", "--format", "{{.Name}}"])
    named = run(["docker", "volume", "ls", "--filter", f"name=^{expected}$", "--format", "{{.Name}}"])
    has_labelled = not labelled.returncode and any(SAFE_NAME.fullmatch(name) for name in labelled.stdout.splitlines())
    has_expected = not named.returncode and expected in named.stdout.splitlines()
    queried = not labelled.returncode and not named.returncode
    return {"status": "ok" if queried else "partial" if has_labelled or has_expected else "unavailable",
            "exists": True if has_labelled or has_expected else False if queried else None,
            "labelled_volume_present": bool(has_labelled), "expected_name_present": bool(has_expected)}


def current_release_status(root: Path, project: str) -> dict:
    current = root / "current"
    result = {"present": current.exists() or current.is_symlink(), "symlink": current.is_symlink(),
              "directory_present": current.is_dir(), "inside_releases": False, "sha": None,
              "compose_present": False, "image_reference_present": False, "image_reference_matches": None}
    try:
        resolved = current.resolve()
        inside = resolved.parent == (root.resolve() / "releases")
        result["inside_releases"] = inside
        if not inside or not result["directory_present"]:
            return result
        if SHA.fullmatch(resolved.name):
            result["sha"] = resolved.name
        result["compose_present"] = (resolved / "compose.yaml").is_file()
        reference = resolved / "image.ref"
        result["image_reference_present"] = reference.is_file()
        if reference.is_file() and reference.stat().st_size <= 256:
            value = reference.read_text(encoding="utf-8").strip()
            result["image_reference_matches"] = value == f"{project}:{result['sha']}"
    except (OSError, RuntimeError, UnicodeError):
        pass
    return result


def collect(root: Path, project: str, run: Runner = readonly_command) -> dict:
    markers = {name: (root / f".{name}").is_file() for name in ("use-caddy", "use-public-sites")}
    required = set(REQUIRED_KEYS)
    if markers["use-caddy"] or markers["use-public-sites"]:
        required.update(("DOMAIN", "ACME_EMAIL"))
    if markers["use-public-sites"]:
        required.update(("LANDING_DOMAIN", "UMAMI_DOMAIN"))
    return {"report": "deploy-diagnostics-v1", "project": project, "root_exists": root.is_dir(),
            "environment": environment_presence(root / ".env", required), "markers": markers,
            "docker": container_status(project, run), "analytics_volume": analytics_volume_status(project, run),
            "current_release": current_release_status(root, project)}


def main(arguments: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if arguments is None else arguments
    if len(arguments) != 2 or not re.fullmatch(r"/[A-Za-z0-9/_-]+", arguments[0]) or arguments[0] == "/" or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", arguments[1]) or len(arguments[1]) > 63:
        print("Diagnostics requires an absolute deployment root and a valid project slug.", file=sys.stderr)
        return 2
    try:
        report = collect(Path(arguments[0]), arguments[1])
    except (OSError, RuntimeError, UnicodeError):
        # Metadata probes can fail before a file is opened (including symlink
        # loops). A traceback would disclose private deployment paths.
        print(json.dumps({"report": "deploy-diagnostics-v1", "status": "unavailable", "filesystem_metadata": "unavailable"}, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
