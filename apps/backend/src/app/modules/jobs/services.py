from collections.abc import Callable
from uuid import UUID

from sqlalchemy.orm import Session

from app.modules.jobs.models import Job
from app.modules.jobs.schemas import JobCreate


class QueueUnavailable(Exception):
    pass


def transform(text: str, operation: str) -> str:
    if operation == "uppercase":
        return text.upper()
    if operation == "reverse":
        return text[::-1]
    raise ValueError("Unsupported operation")


def create_job(session: Session, payload: JobCreate, dispatch: Callable[[str], None]) -> Job:
    job = Job(text=payload.text, operation=payload.operation)
    session.add(job)
    session.commit()
    session.refresh(job)
    try:
        dispatch(str(job.id))
    except Exception as exc:
        job.status = "failed"
        job.error = "Queue unavailable; submit a new job when service recovers"
        session.commit()
        raise QueueUnavailable from exc
    return job


def execute_job(session: Session, job_id: UUID) -> str | None:
    job = session.get(Job, job_id)
    if job is None:
        raise ValueError("Job does not exist")
    if job.status == "succeeded":
        return job.result
    job.status = "running"
    job.error = None
    session.commit()
    try:
        job.result = transform(job.text, job.operation)
    except ValueError:
        job.status = "failed"
        job.error = "Unsupported operation"
        session.commit()
        raise
    job.status = "succeeded"
    session.commit()
    return job.result
