"""Create a production .env without displaying generated secrets."""

import argparse
import json
import os
import re
import secrets
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--domain")
    parser.add_argument("--email")
    parser.add_argument("--output", type=Path, default=Path(".env"))
    args = parser.parse_args()
    if len(args.project_name) > 63 or not re.fullmatch(
        r"[a-z0-9]+(?:-[a-z0-9]+)*", args.project_name
    ):
        parser.error("--project-name must be a lowercase slug of 1 to 63 characters")
    if (args.domain is None) != (args.email is None):
        parser.error("--domain and --email must be supplied together, or both omitted")
    if args.domain is not None and not re.fullmatch(
        r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", args.domain
    ):
        parser.error("--domain must be a hostname without protocol or path")
    if args.email is not None and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", args.email):
        parser.error("--email must be an email address")
    values = {
        "PROJECT_NAME": args.project_name,
        "ENVIRONMENT": "production",
        "APP_PORT": "18000",
        "FRONTEND_PORT": "18001",
        "LANDING_PORT": "18002",
        "UMAMI_PORT": "18003",
        "POSTGRES_DB": "app",
        "POSTGRES_USER": "app",
        "POSTGRES_PASSWORD": secrets.token_hex(32),
        "REDIS_PASSWORD": secrets.token_hex(32),
        "WORKER_CONCURRENCY": "2",
        "BULLMQ_DB": "2",
        "BULLMQ_PREFIX": "node-bullmq",
        "BULLMQ_QUEUE": "jobs-transform-v1",
        "BULLMQ_ATTEMPTS": "4",
        "BULLMQ_BACKOFF_MS": "1000",
        "BULLMQ_RETENTION_COUNT": "1000",
        "BULLMQ_COMPLETED_RETENTION_SECONDS": "3600",
        "BULLMQ_FAILED_RETENTION_SECONDS": "86400",
        "API_TOKEN": secrets.token_hex(32),
        "OPERATOR_TOKEN": secrets.token_hex(32),
        "UMAMI_POSTGRES_DB": "umami",
        "UMAMI_POSTGRES_USER": "umami",
        "UMAMI_POSTGRES_PASSWORD": secrets.token_hex(32),
        "UMAMI_APP_SECRET": secrets.token_hex(32),
        "PUBLIC_APP_URL": "http://localhost:18001",
        "PUBLIC_UMAMI_SCRIPT_URL": "",
        "PUBLIC_UMAMI_WEBSITE_ID": "",
        "PUBLIC_UMAMI_DOMAINS": "",
        "ALLOWED_HOSTS": json.dumps(["localhost", "127.0.0.1"]),
        "CORS_ORIGINS": json.dumps([]),
    }
    if args.domain is not None:
        values.update(
            DOMAIN=args.domain.lower(),
            ACME_EMAIL=args.email,
            ALLOWED_HOSTS=json.dumps([args.domain.lower(), "localhost", "127.0.0.1"]),
            CORS_ORIGINS=json.dumps([f"https://{args.domain.lower()}"]),
            PUBLIC_APP_URL=f"https://{args.domain.lower()}",
        )
    fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")
    print(f"Created {args.output}. Keep it private; existing files are never overwritten.")


if __name__ == "__main__":
    main()
