"""Exercise the real API -> RabbitMQ -> Celery -> PostgreSQL path.

Run inside the api container, or set SMOKE_BASE_URL and API_TOKEN on the host.
Only the Python standard library is needed.
"""

import json
import os
import time
from urllib.request import Request, urlopen


def request(path: str, body: dict | None = None) -> dict:
    token = os.environ.get("API_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(
        os.environ.get("SMOKE_BASE_URL", "http://localhost:8000") + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    with urlopen(req, timeout=10) as response:
        return json.load(response)


def main() -> None:
    request("/health/ready")
    job = request("/api/v1/jobs", {"text": "competition-ready", "operation": "uppercase"})
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        result = request(f"/api/v1/jobs/{job['id']}")
        if result["status"] == "succeeded":
            if result["result"] != "COMPETITION-READY":
                raise RuntimeError(f"Unexpected task result: {result!r}")
            print("Smoke OK: API, PostgreSQL, RabbitMQ, Celery and Redis readiness")
            return
        if result["status"] == "failed":
            raise RuntimeError(f"Background job failed: {result!r}")
        time.sleep(1)
    raise TimeoutError("Celery job did not finish within 60 seconds")


if __name__ == "__main__":
    main()
