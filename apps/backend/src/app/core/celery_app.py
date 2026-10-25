from celery import Celery

from app.core.config import get_settings

settings = get_settings()
celery_app = Celery(
    "app",
    broker=settings.broker_url,
    backend=settings.redis_url(1),
    include=["app.modules.jobs.tasks"],
)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # RabbitMQ 4.3 rejects transient non-exclusive event/control queues.
    event_queue_exclusive=True,
    control_queue_exclusive=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    broker_connection_timeout=3,
    broker_transport_options={"confirm_publish": True},
    task_publish_retry=False,
    result_expires=3600,
    task_soft_time_limit=25,
    task_time_limit=30,
)
