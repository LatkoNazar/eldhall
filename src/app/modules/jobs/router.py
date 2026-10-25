from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.auth import require_api_token
from app.core.database import get_session
from app.modules.jobs.models import Job
from app.modules.jobs.schemas import JobCreate, JobRead
from app.modules.jobs.services import QueueUnavailable, create_job
from app.modules.jobs.tasks import dispatch_job

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"], dependencies=[Depends(require_api_token)])
DatabaseSession = Annotated[Session, Depends(get_session)]


@router.post("", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def submit_job(payload: JobCreate, session: DatabaseSession) -> Job:
    try:
        return create_job(session, payload, dispatch_job)
    except QueueUnavailable as exc:
        raise HTTPException(503, "Queue unavailable; please retry later") from exc


@router.get("/{job_id}", response_model=JobRead)
def read_job(job_id: UUID, session: DatabaseSession) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job
