"""Run after compose startup: uv run pytest -m integration.

Override TEST_BASE_URL when the API listens on a different host or port.
"""

import os
import time

import httpx
import pytest

from app.core.config import Settings


@pytest.mark.integration
def test_real_database_broker_and_worker():
    settings = Settings()
    token = settings.api_token.get_secret_value()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.Client(
        base_url=os.getenv("TEST_BASE_URL", "http://localhost:8000"),
        headers=headers,
        timeout=15,
    ) as client:
        response = client.get("/health/ready")
        assert response.status_code == 200, response.text
        assert response.json()["dependencies"] == {
            "postgres": "ok",
            "redis": "ok",
            "rabbitmq": "ok",
        }
        response = client.post("/api/v1/jobs", json={"text": "competition", "operation": "reverse"})
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/jobs/{job_id}")
            assert response.status_code == 200, response.text
            job = response.json()
            if job["status"] in {"succeeded", "failed"}:
                break
            time.sleep(0.25)
        assert job["status"] == "succeeded", job
        assert job["result"] == "noititepmoc"
