from unittest.mock import Mock

import pytest
from sqlalchemy import select

from app.modules.jobs.models import Job
from app.modules.jobs.schemas import JobCreate
from app.modules.jobs.services import QueueUnavailable, create_job, execute_job, transform


@pytest.mark.parametrize(
    ("operation", "expected"), [("uppercase", "ПРИВІТ"), ("reverse", "тівирп")]
)
def test_transform(operation, expected):
    assert transform("привіт", operation) == expected


def test_job_lifecycle_and_redelivery(session):
    dispatch = Mock()
    job = create_job(session, JobCreate(text="hello", operation="uppercase"), dispatch)
    dispatch.assert_called_once_with(str(job.id))
    assert job.status == "queued"
    assert execute_job(session, job.id) == "HELLO"
    assert job.status == "succeeded"
    assert execute_job(session, job.id) == "HELLO"


def test_queue_failure_persists_a_failed_job(session):
    with pytest.raises(QueueUnavailable):
        create_job(session, JobCreate(text="hello"), Mock(side_effect=OSError("broker down")))
    job = session.scalar(select(Job))
    assert job.status == "failed"
    assert job.error.startswith("Queue unavailable")


def test_api_rejects_missing_and_wrong_token(client):
    assert client.post("/api/v1/jobs", json={"text": "hello"}).status_code == 401
    response = client.post(
        "/api/v1/jobs",
        json={"text": "hello"},
        headers={"Authorization": "Bearer incorrect"},
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        {"text": ""},
        {"text": "x" * 10001},
        {"text": "hi", "operation": "delete"},
        {"text": "hi", "unknown": True},
    ],
)
def test_api_validates_bounded_payload(client, headers, payload):
    assert client.post("/api/v1/jobs", json=payload, headers=headers).status_code == 422


def test_api_create_read_and_missing_job(client, headers, monkeypatch):
    monkeypatch.setattr("app.modules.jobs.router.dispatch_job", lambda job_id: None)
    response = client.post("/api/v1/jobs", json={"text": "hello"}, headers=headers)
    assert response.status_code == 202
    job_id = response.json()["id"]
    assert client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()["status"] == "queued"
    assert (
        client.get(
            "/api/v1/jobs/00000000-0000-0000-0000-000000000000",
            headers=headers,
        ).status_code
        == 404
    )


def test_api_returns_unavailable_when_publish_fails(client, headers, monkeypatch):
    def fail(job_id):
        raise OSError("no broker")

    monkeypatch.setattr("app.modules.jobs.router.dispatch_job", fail)
    assert client.post("/api/v1/jobs", json={"text": "hello"}, headers=headers).status_code == 503
