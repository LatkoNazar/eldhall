#!/usr/bin/env python3
"""Deterministic Docker boundary for release script failure injection."""

import json
import os
import re
import sys
from pathlib import Path

args = sys.argv[1:]
project = None
command = None
services = []
composition = None
if args and args[0] == "compose":
    env_file = Path(args[args.index("--env-file") + 1])
    values = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line)
    project = (
        os.environ.get("COMPOSE_PROJECT_NAME")
        or values.get("COMPOSE_PROJECT_NAME")
        or os.environ.get("PROJECT_NAME")
        or values.get("PROJECT_NAME")
        or "starter"
    )
    command = next(
        value
        for value in args
        if value in {"config", "up", "run", "exec", "ps", "logs", "stop", "rm"}
    )
    composition = Path(args[args.index("-f") + 1])
    services = re.findall(r"^  ([a-z][a-z0-9-]*):", composition.read_text(), re.MULTILINE)
    if any(value.endswith("compose.caddy.yaml") for value in args):
        services.append("caddy")
with Path(os.environ["FAKE_DOCKER_LOG"]).open("a") as handle:
    handle.write(
        json.dumps(
            {
                "args": args,
                "project": project,
                "image": os.environ.get("APP_IMAGE"),
                "frontend_image": os.environ.get("FRONTEND_IMAGE"),
                "landing_image": os.environ.get("LANDING_IMAGE"),
                "composition": str(composition),
            }
        )
        + "\n"
    )
fail = (
    os.environ.get("FAKE_FAIL")
    if os.environ.get("FAKE_FAIL_IMAGE", os.environ.get("APP_IMAGE")) == os.environ.get("APP_IMAGE")
    else None
)
if command == "up" and "rabbitmq" in args and "rabbitmq" not in services:
    print("RabbitMQ is absent from this release", file=sys.stderr)
    sys.exit(2)
if command == "config":
    if fail == "config":
        sys.exit(1)
    if "--services" in args:
        print("\n".join(services))
    else:
        umami_image = "ghcr.io/umami-software/umami:3.4.1"
        match = re.search(
            r"^    image: (ghcr.io/umami-software/umami:[^\s]+)",
            composition.read_text(),
            re.MULTILINE,
        )
        if match:
            umami_image = match.group(1)
        configured_services = {"secret": "never-print-resolved-secrets"}
        if "umami" in services:
            configured_services["umami"] = {"image": umami_image}
        if "umami-db" in services:
            database_match = re.search(
                r"^  umami-db:\n    image: ([^\s]+)",
                composition.read_text(),
                re.MULTILINE,
            )
            configured_services["umami-db"] = {
                "image": database_match.group(1) if database_match else "postgres:17.11-bookworm"
            }
        print(json.dumps({"name": project, "services": configured_services}))
elif command == "up" and "frontend" in args and fail == "frontend":
    sys.exit(1)
elif command == "up" and "landing" in args and fail == "landing":
    sys.exit(1)
elif command == "run" and fail == "migrate":
    sys.exit(1)
elif command == "exec" and "api" in args:
    expected_runtime = (
        "node" if (composition.parent / "apps/api/scripts/smoke.mjs").is_file() else "python"
    )
    if args[args.index("api") + 1] != expected_runtime:
        print(f"Wrong API runtime: expected {expected_runtime}", file=sys.stderr)
        sys.exit(2)
    sys.stdin.read()
    if fail == "smoke":
        sys.exit(1)
elif command == "exec" and "postgres" in args:
    print("database-dump")
elif command == "exec" and "umami-db" in args:
    print("analytics-dump")
