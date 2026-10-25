from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.database import get_engine
from app.modules.jobs.services import execute_job


@celery_app.task(
    name="jobs.transform",
    autoretry_for=(SQLAlchemyError,),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=3,
)
def transform_job(job_id: str) -> str | None:
    with Session(get_engine()) as session:
        return execute_job(session, UUID(job_id))


def dispatch_job(job_id: str) -> None:
    transform_job.apply_async(args=[job_id], task_id=job_id)
