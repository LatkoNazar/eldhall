import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import Settings, get_settings
from app.core.database import Base, get_session
from app.modules.jobs.models import Job  # noqa: F401


@pytest.fixture(autouse=True)
def isolated_unit_settings(request, monkeypatch):
    if request.node.get_closest_marker("integration"):
        yield
        return
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    field_names = {name.upper() for name in Settings.model_fields}
    for name in os.environ:
        if name.upper() in field_names:
            monkeypatch.delenv(name)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as database_session:
        yield database_session
    engine.dispose()


@pytest.fixture
def client(monkeypatch, session):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("API_TOKEN", "test-secret-token")
    monkeypatch.setenv("ALLOWED_HOSTS", '["testserver"]')
    get_settings.cache_clear()
    from app.main import create_app

    application = create_app()
    application.dependency_overrides[get_session] = lambda: session
    with TestClient(application) as test_client:
        yield test_client
    get_settings.cache_clear()


@pytest.fixture
def headers():
    return {"Authorization": "Bearer test-secret-token"}
