"""Append only missing deployment admin/analytics secrets after proving analytics is unused.

Standalone Linux script for SSH stdin. Never prints secret values or filesystem paths.
Does not start services, create Docker volumes, or change application/database credentials.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


TARGETS = ("UMAMI_APP_SECRET", "UMAMI_POSTGRES_PASSWORD", "OPERATOR_TOKEN")
ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
TARGET_DECLARATION = re.compile(r"^\s*(?:export\s+)?(?:" + "|".join(TARGETS) + r")(?=$|[\s=:])")


class Refused(Exception):
    """Only constant reason codes are used; exception values never contain secrets."""


@contextmanager
def deployment_lock(root: Path):
    import fcntl

    descriptor = os.open(root / ".deploy.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refused("deployment_busy") from None
                time.sleep(0.1)
        yield
    finally:
        os.close(descriptor)


def readonly_command(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(arguments, capture_output=True, text=True, timeout=12, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(arguments, 1, "", "")


def require_clean_analytics(root: Path, project: str, run) -> None:
    marker = root / ".use-public-sites"
    if marker.exists() or marker.is_symlink():
        raise Refused("public_sites_configured")
    commands = [
        ["docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--filter", "label=com.docker.compose.service=umami", "--format", "{{.ID}}"],
        ["docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--filter", "label=com.docker.compose.service=umami-db", "--format", "{{.ID}}"],
        ["docker", "ps", "--all", "--filter", f"name=^{project}[-_]umami([-_]|$)", "--format", "{{.ID}}"],
        ["docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--filter", "label=com.docker.compose.volume=umami_postgres_data", "--format", "{{.Name}}"],
        ["docker", "volume", "ls", "--filter", f"name=^{project}_umami_postgres_data$", "--format", "{{.Name}}"],
    ]
    for arguments in commands:
        result = run(arguments)
        if result.returncode:
            raise Refused("analytics_state_unavailable")
        if result.stdout.strip():
            raise Refused("analytics_storage_or_container_exists")


def missing_targets(original: bytes) -> list[str]:
    counts = {name: 0 for name in TARGETS}
    for line in original.decode("utf-8-sig").splitlines():
        matched = ASSIGNMENT.match(line)
        if not matched:
            if TARGET_DECLARATION.match(line):
                raise Refused("ambiguous_target_declaration")
            continue
        name, value = matched.groups()
        if name not in counts:
            continue
        counts[name] += 1
        if counts[name] > 1:
            raise Refused("duplicate_target_declaration")
        value = value.strip()
        if not value or value.startswith("#") or re.fullmatch(r"(['\"])\1\s*(?:#.*)?", value):
            raise Refused("empty_target_declaration")
        if value[0] in ("'", '"'):
            if value[0] not in value[1:]:
                raise Refused("ambiguous_target_declaration")
            if not value[1:].split(value[0], 1)[0].strip():
                raise Refused("empty_target_declaration")
    return [name for name in TARGETS if not counts[name]]


def require_matching_project(root: Path, project: str, original: bytes) -> None:
    identities = {name: [] for name in ("PROJECT_NAME", "COMPOSE_PROJECT_NAME")}
    for line in original.decode("utf-8-sig").splitlines():
        matched = ASSIGNMENT.match(line)
        if not matched:
            if re.match(r"^\s*(?:export\s+)?(?:PROJECT_NAME|COMPOSE_PROJECT_NAME)(?=$|[\s=:])", line):
                raise Refused("ambiguous_project_identity")
            continue
        if matched[1] not in identities:
            continue
        value = matched[2].strip()
        if value[:1] in ("'", '"'):
            closing = value.find(value[0], 1)
            if closing < 0 or (value[closing + 1:].strip() and not value[closing + 1:].strip().startswith("#")):
                raise Refused("ambiguous_project_identity")
            value = value[1:closing]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        identities[matched[1]].append(value)
    if identities["PROJECT_NAME"] != [project] or (identities["COMPOSE_PROJECT_NAME"] and identities["COMPOSE_PROJECT_NAME"] != [project]):
        raise Refused("deployment_project_mismatch")
    current = root / "current"
    if current.exists() or current.is_symlink():
        reference = current / "image.ref"
        if not current.is_dir() or not (current / "compose.yaml").is_file() or reference.is_symlink() or not reference.is_file() or reference.stat().st_size > 256:
            raise Refused("current_release_ambiguous")
        if not re.fullmatch(re.escape(project) + r":[a-f0-9]{40}", reference.read_text(encoding="utf-8").strip()):
            raise Refused("current_release_project_mismatch")


def private_file(root: Path, prefix: str, contents: bytes, metadata) -> Path:
    descriptor, name = tempfile.mkstemp(dir=root, prefix=prefix)
    path = Path(name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        if hasattr(os, "fchown"):
            os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        return path
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise


def initialize(root: Path, project: str, *, run=None, generate=None, locked=None) -> dict:
    run = readonly_command if run is None else run
    generate = secrets.token_hex if generate is None else generate
    locked = deployment_lock if locked is None else locked
    if not root.is_dir() or root.is_symlink():
        raise Refused("deployment_root_unavailable")
    with locked(root):
        env_path = root / ".env"
        if env_path.is_symlink():
            raise Refused("environment_symlink")
        with os.fdopen(os.open(env_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > 1_048_576:
                raise Refused("environment_not_regular")
            if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
                raise Refused("environment_owner_mismatch")
            original = handle.read(1_048_577)
            if len(original) > 1_048_576:
                raise Refused("environment_too_large")
        require_matching_project(root, project, original)
        missing = missing_targets(original)
        require_clean_analytics(root, project, run)
        if not missing:
            return {"status": "already_configured", "keys_added": [], "backup_created": False}
        values = {name: generate(32) for name in missing}
        if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in values.values()):
            raise Refused("secret_generation_failed")
        newline = b"\r\n" if b"\r\n" in original else b"\n"
        updated = original + (newline if original and not original.endswith(b"\n") else b"")
        updated += b"".join(name.encode("ascii") + b"=" + values[name].encode("ascii") + newline for name in missing)
        backup = private_file(root, ".env.before-initialize-deploy-config-", original, metadata)
        temporary = None
        try:
            temporary = private_file(root, ".env.initialize-deploy-config-", updated, metadata)
            current = env_path.lstat()
            if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns):
                raise Refused("environment_changed")
            os.replace(temporary, env_path)
            temporary = None
            if hasattr(os, "O_DIRECTORY"):
                directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return {"status": "initialized", "keys_added": missing, "backup_created": backup.is_file()}


def main(arguments: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if arguments is None else arguments
    if len(arguments) != 2 or not re.fullmatch(r"/[A-Za-z0-9/_-]+", arguments[0]) or arguments[0] == "/" or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", arguments[1]) or len(arguments[1]) > 63:
        print(json.dumps({"status": "refused", "reason": "invalid_deployment_identity"}))
        return 2
    try:
        report = initialize(Path(arguments[0]), arguments[1])
    except Refused as error:
        print(json.dumps({"status": "refused", "reason": str(error)}))
        return 1
    except (OSError, RuntimeError, UnicodeError, ImportError):
        print(json.dumps({"status": "unavailable", "reason": "configuration_initialization_unavailable"}))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
