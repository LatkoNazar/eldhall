from app.modules.system.health import dependency_checks


def test_liveness_does_not_require_services(client):
    assert client.get("/health/live").json() == {"status": "ok"}


def test_readiness_reports_a_dependency_failure_without_details(client):
    def fail():
        raise RuntimeError("secret-password-in-error")

    client.app.dependency_overrides[dependency_checks] = lambda: {
        "postgres": lambda: None,
        "redis": fail,
        "rabbitmq": lambda: None,
    }
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["dependencies"] == {
        "postgres": "ok",
        "redis": "unavailable",
        "rabbitmq": "ok",
    }
    assert "secret-password" not in response.text


def test_readiness_when_dependencies_work(client):
    client.app.dependency_overrides[dependency_checks] = lambda: {"postgres": lambda: None}
    assert client.get("/health/ready").status_code == 200


def test_unknown_hosts_are_rejected(client):
    assert client.get("/health/live", headers={"Host": "untrusted.example"}).status_code == 400
