import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


def load_script(relative_path):
    specification = importlib.util.spec_from_file_location("smoke_under_test", REPO / relative_path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class SmokeHostTests(unittest.TestCase):
    def test_backend_proxy_smoke_sends_explicit_host_and_runtime_authentication(self):
        module = load_script("scripts/tests/fixtures/python-api-smoke.py")
        environment = {
            "SMOKE_BASE_URL": "http://frontend:8080",
            "SMOKE_HOST": "localhost",
            "API_TOKEN": "test-runtime-token",
        }
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(module, "urlopen") as open_,
        ):
            open_.return_value.__enter__.return_value.read.return_value = b'{"status":"ok"}'
            self.assertEqual(module.request("/health/ready"), {"status": "ok"})
            request = open_.call_args.args[0]
            self.assertEqual(request.full_url, "http://frontend:8080/health/ready")
            self.assertEqual(request.get_header("Host"), "localhost")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-runtime-token")

    def test_backend_direct_smoke_preserves_default_url_host(self):
        module = load_script("scripts/tests/fixtures/python-api-smoke.py")
        with patch.dict(os.environ, {}, clear=True), patch.object(module, "urlopen") as open_:
            open_.return_value.__enter__.return_value.read.return_value = b'{"status":"ok"}'
            module.request("/health/ready")
            request = open_.call_args.args[0]
            self.assertEqual(request.full_url, "http://localhost:8000/health/ready")
            self.assertIsNone(request.get_header("Host"))

    def test_frontend_smoke_defaults_to_trusted_local_host_without_bearer_token(self):
        with patch.dict(os.environ, {}, clear=True):
            module = load_script("scripts/frontend-smoke.py")
        with patch.object(module, "urlopen") as open_:
            module.get("/frontend-health")
            request = open_.call_args.args[0]
            self.assertEqual(request.full_url, "http://frontend:8080/frontend-health")
            self.assertEqual(request.get_header("Host"), "localhost")
            self.assertIsNone(request.get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
