import logging
from collections.abc import Callable

from kombu import Connection
from sqlalchemy import text

from app.core.cache import get_cache
from app.core.config import get_settings
from app.core.database import get_engine

logger = logging.getLogger(__name__)


def check_postgres() -> None:
    with get_engine().connect() as connection:
        connection.execute(text("SELECT 1"))


def check_redis() -> None:
    get_cache().ping()


def check_rabbitmq() -> None:
    with Connection(get_settings().broker_url, connect_timeout=3) as connection:
        connection.ensure_connection(max_retries=0)


def dependency_checks() -> dict[str, Callable[[], None]]:
    return {"postgres": check_postgres, "redis": check_redis, "rabbitmq": check_rabbitmq}


def readiness(checks: dict[str, Callable[[], None]]) -> dict[str, str]:
    results = {}
    for name, check in checks.items():
        try:
            check()
            results[name] = "ok"
        except Exception:
            logger.warning("Dependency %s is unavailable", name)
            results[name] = "unavailable"
    return results
