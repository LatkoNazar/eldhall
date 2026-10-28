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
    services = ["postgres", "redis", "rabbitmq", "api", "worker", "migrate"]
    if re.search(r"^  frontend:", composition.read_text(), re.MULTILINE):
        services.append("frontend")
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
if command == "config":
    if fail == "config":
        sys.exit(1)
    if "--services" in args:
        print("\n".join(services))
    else:
        print(json.dumps({"name": project, "services": {"secret": "never-print-resolved-secrets"}}))
elif command == "up" and "frontend" in args and fail == "frontend":
    sys.exit(1)
elif command == "run" and fail == "migrate":
    sys.exit(1)
elif command == "exec" and "api" in args:
    sys.stdin.read()
    if fail == "smoke":
        sys.exit(1)
elif command == "exec" and "postgres" in args:
    print("database-dump")
