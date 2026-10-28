#!/usr/bin/env python3
"""Deterministic Docker boundary for release script failure injection."""

import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
project = None
command = None
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
        value for value in args if value in {"config", "up", "run", "exec", "ps", "logs"}
    )
with Path(os.environ["FAKE_DOCKER_LOG"]).open("a") as handle:
    handle.write(
        json.dumps({"args": args, "project": project, "image": os.environ.get("APP_IMAGE")}) + "\n"
    )
if command == "config":
    if os.environ.get("FAKE_FAIL") == "config":
        sys.exit(1)
    print(json.dumps({"name": project, "services": {"secret": "never-print-resolved-secrets"}}))
elif command == "run" and os.environ.get("FAKE_FAIL") == "migrate":
    sys.exit(1)
elif command == "exec" and "api" in args:
    sys.stdin.read()
    if os.environ.get("FAKE_FAIL") == "smoke":
        sys.exit(1)
elif command == "exec" and "postgres" in args:
    print("database-dump")
