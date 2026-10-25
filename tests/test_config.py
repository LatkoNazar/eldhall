from urllib.parse import unquote, urlsplit

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_credentials_are_encoded_without_changing_database_password():
    password = "a:@/+#%? $password"
    settings = Settings(
        _env_file=None,
        postgres_password=password,
        redis_password=password,
        rabbitmq_password=password,
        rabbitmq_user="user@name",
        rabbitmq_vhost="my/vhost",
    )
    assert settings.database_url.password == password
    redis = urlsplit(settings.redis_url(1))
    assert unquote(redis.password) == password
    broker = urlsplit(settings.broker_url)
    assert unquote(broker.password) == password
    assert unquote(broker.username) == "user@name"
    assert unquote(broker.path[1:]) == "my/vhost"


def test_production_rejects_default_credentials():
    with pytest.raises(ValidationError, match="passwords"):
        Settings(_env_file=None, environment="production")


def test_production_requires_token_and_explicit_hosts():
    values = dict(
        _env_file=None,
        environment="production",
        postgres_password="p" * 32,
        redis_password="r" * 32,
        rabbitmq_password="q" * 32,
    )
    with pytest.raises(ValidationError, match="API_TOKEN"):
        Settings(**values, api_token="")
    with pytest.raises(ValidationError, match="ALLOWED_HOSTS"):
        Settings(**values, api_token="t" * 32, allowed_hosts=["*"])
    assert Settings(**values, api_token="t" * 32, allowed_hosts=["api.example.com"])


def test_celery_operational_queues_are_compatible_with_rabbitmq_43():
    from app.core.celery_app import celery_app

    # Build the actual queues used by worker gossip and inspect ping, without connecting.
    events = celery_app.events.Receiver(None)
    control = celery_app.control.mailbox
    queues = [events.queue, control.get_queue("worker@test"), control.get_reply_queue()]
    for queue in queues:
        assert queue.durable or queue.exclusive, queue.name
