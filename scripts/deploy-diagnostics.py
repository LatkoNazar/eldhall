"""Read deployment status without evaluating .env or changing files, containers or volumes.

Run over SSH with ``python3 - /absolute/deploy/root project-name < this-file``.
Only selected key-presence flags, container names/status, a release SHA and aggregate
legacy work counts are emitted. A zero-work snapshot does not quiesce ingress.
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
CONTAINER_ID = re.compile(r"[a-f0-9]{64}\Z")
IDENTITY_FORMAT = ('{"id":{{json .Id}},"running":{{json .State.Running}},'
                   '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                   '"service":{{json (index .Config.Labels "com.docker.compose.service")}}}')
# Values are expanded only by the selected container's shell. No host .env parsing,
# passwords, queue names or payloads enter argv or the public report.
SQL_COUNTS = '''exec env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000' psql -X -w -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" -A -t -v ON_ERROR_STOP=1 -c "SELECT json_build_object('total',count(*),'queued',count(*) FILTER (WHERE status='queued'),'running',count(*) FILTER (WHERE status='running'),'succeeded',count(*) FILTER (WHERE status='succeeded'),'failed',count(*) FILTER (WHERE status='failed'),'other',count(*) FILTER (WHERE status NOT IN ('queued','running','succeeded','failed') OR status IS NULL)) FROM public.jobs"'''
RABBIT_COUNTS = ('exec rabbitmqctl --silent --timeout 8 list_queues '
                 '-p "${RABBITMQ_DEFAULT_VHOST:?}" messages_ready messages_unacknowledged consumers')
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


def selected_container(project: str, service: str, run: Runner) -> tuple[str, str | None]:
    """Resolve one existing Compose service and recheck labels before any exec."""
    selected = run(["docker", "ps", "--all", "--no-trunc", "--filter",
                    f"label=com.docker.compose.project={project}", "--filter",
                    f"label=com.docker.compose.service={service}", "--format", "{{.ID}}"])
    if selected.returncode or len(selected.stdout) > 4096:
        return "unavailable", None
    ids = selected.stdout.splitlines()
    if not ids:
        return "not_present", None
    if len(ids) != 1 or not CONTAINER_ID.fullmatch(ids[0]):
        return "unavailable", None
    identity = run(["docker", "inspect", "--format", IDENTITY_FORMAT, ids[0]])
    try:
        if identity.returncode or len(identity.stdout) > 4096:
            raise ValueError()
        item = json.loads(identity.stdout)
        if not isinstance(item, dict) or item.get("running") is not True or item != {"id": ids[0], "running": True, "project": project, "service": service}:
            raise ValueError()
    except (ValueError, TypeError):
        return "unavailable", None
    return "ok", ids[0]


def legacy_queue_status(project: str, run: Runner) -> dict:
    """Read old Celery/RabbitMQ work only; never drain, acknowledge or migrate it."""
    result = {"status": "unavailable", "legacy_container_present": None,
              "pending_work": None, "snapshot_only": True,
              "postgres": {"status": "not_queried"}, "rabbitmq": {"status": "not_queried"}}
    rabbit_status, rabbit = selected_container(project, "rabbitmq", run)
    if rabbit_status == "not_present":
        result.update(status="no_legacy_container", legacy_container_present=False)
        result["rabbitmq"] = {"status": "not_present"}
        return result
    if rabbit_status != "ok":
        result["rabbitmq"] = {"status": "unavailable"}
        return result
    result["legacy_container_present"] = True
    postgres_status, postgres = selected_container(project, "postgres", run)
    result["postgres"] = {"status": "unavailable"}
    if postgres_status == "ok":
        sql = run(["docker", "exec", postgres, "sh", "-ec", SQL_COUNTS])
        try:
            if sql.returncode or len(sql.stdout) > 4096:
                raise ValueError()
            counts = json.loads(sql.stdout)
            keys = {"total", "queued", "running", "succeeded", "failed", "other"}
            if not isinstance(counts, dict) or counts.keys() != keys or any(type(value) is not int or value < 0 or value > 2**63 - 1 for value in counts.values()):
                raise ValueError()
            if counts["total"] != sum(counts[key] for key in keys - {"total"}):
                raise ValueError()
            result["postgres"] = {"status": "ok", **counts}
        except (ValueError, TypeError):
            pass
    broker = run(["docker", "exec", rabbit, "sh", "-ec", RABBIT_COUNTS])
    result["rabbitmq"] = {"status": "unavailable"}
    try:
        if broker.returncode or len(broker.stdout) > 1_048_576:
            raise ValueError()
        totals = [0, 0, 0]
        rows = [line.split() for line in broker.stdout.splitlines() if line.strip()]
        for row in rows:
            if len(row) != 3 or any(not re.fullmatch(r"[0-9]{1,19}", field) for field in row):
                raise ValueError()
            for index, field in enumerate(row):
                totals[index] += int(field)
                if totals[index] > 2**63 - 1:
                    raise ValueError()
        result["rabbitmq"] = {"status": "ok", "queues": len(rows),
                              "messages_ready": totals[0], "messages_unacknowledged": totals[1], "consumers": totals[2]}
    except (ValueError, TypeError):
        pass
    if result["postgres"]["status"] == result["rabbitmq"]["status"] == "ok":
        result["status"] = "ok"
        result["pending_work"] = bool(result["postgres"]["queued"] + result["postgres"]["running"]
                                      + result["postgres"]["other"] + totals[0] + totals[1])
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
            "current_release": current_release_status(root, project), "legacy_queue": legacy_queue_status(project, run)}


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
