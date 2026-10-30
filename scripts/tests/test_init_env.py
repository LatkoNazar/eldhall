import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "init-env.py"


class EnvironmentGenerationTests(unittest.TestCase):
    def invoke(
        self,
        output: Path,
        name: str | None,
        *,
        domain: str | None = "api.example.com",
        email: str | None = "ops@example.com",
    ) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(SCRIPT), "--output", str(output)]
        if domain is not None:
            command += ["--domain", domain]
        if email is not None:
            command += ["--email", email]
        if name is not None:
            command += ["--project-name", name]
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def test_two_projects_have_distinct_identity_and_random_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            generated = []
            for name in ("alpha-app", "beta-app"):
                output = Path(directory) / f"{name}.env"
                result = self.invoke(output, name)
                self.assertEqual(result.returncode, 0, result.stderr)
                values = dict(line.split("=", 1) for line in output.read_text().splitlines())
                self.assertEqual(values["PROJECT_NAME"], name)
                self.assertNotIn("COMPOSE_PROJECT_NAME", values)
                self.assertEqual(values["ENVIRONMENT"], "production")
                self.assertEqual(json.loads(values["ALLOWED_HOSTS"])[0], "api.example.com")
                for key in (
                    "POSTGRES_PASSWORD",
                    "REDIS_PASSWORD",
                    "RABBITMQ_PASSWORD",
                    "API_TOKEN",
                    "UMAMI_POSTGRES_PASSWORD",
                    "UMAMI_APP_SECRET",
                ):
                    self.assertRegex(values[key], re.compile("^[a-f0-9]{64}$"))
                    self.assertNotIn(values[key], result.stdout + result.stderr)
                generated.append(values)
            self.assertNotEqual(generated[0]["API_TOKEN"], generated[1]["API_TOKEN"])

    def test_invalid_or_missing_names_never_create_an_env_file(self):
        invalid = (None, "", "UPPER", "with_space", "-leading", "trailing-", "two--parts", "a" * 64)
        with tempfile.TemporaryDirectory() as directory:
            for name in invalid:
                with self.subTest(name=name):
                    output = Path(directory) / "private.env"
                    self.assertNotEqual(self.invoke(output, name).returncode, 0)
                    self.assertFalse(output.exists())

    def test_existing_environment_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private.env"
            self.assertEqual(self.invoke(output, "alpha").returncode, 0)
            original = output.read_bytes()
            self.assertNotEqual(self.invoke(output, "beta").returncode, 0)
            self.assertEqual(output.read_bytes(), original)

    def test_name_at_length_limit_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.invoke(Path(directory) / "private.env", "a" * 63)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_without_domain_generates_private_production_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private.env"
            result = self.invoke(output, "starter", domain=None, email=None)
            self.assertEqual(result.returncode, 0, result.stderr)
            values = dict(line.split("=", 1) for line in output.read_text().splitlines())
            self.assertEqual(values["ENVIRONMENT"], "production")
            self.assertEqual(json.loads(values["ALLOWED_HOSTS"]), ["localhost", "127.0.0.1"])
            self.assertEqual(json.loads(values["CORS_ORIGINS"]), [])
            self.assertEqual(values["APP_PORT"], "18000")
            self.assertEqual(values["FRONTEND_PORT"], "18001")
            self.assertEqual(values["LANDING_PORT"], "18002")
            self.assertEqual(values["UMAMI_PORT"], "18003")
            self.assertEqual(values["PUBLIC_APP_URL"], "http://localhost:18001")
            self.assertEqual(values["PUBLIC_UMAMI_WEBSITE_ID"], "")
            self.assertNotIn("DOMAIN", values)
            self.assertNotIn("ACME_EMAIL", values)
            for key in (
                "POSTGRES_PASSWORD",
                "REDIS_PASSWORD",
                "RABBITMQ_PASSWORD",
                "API_TOKEN",
                "UMAMI_POSTGRES_PASSWORD",
                "UMAMI_APP_SECRET",
            ):
                self.assertRegex(values[key], re.compile("^[a-f0-9]{64}$"))
                self.assertNotIn(values[key], result.stdout + result.stderr)

    def test_domain_and_email_must_be_paired_before_creating_any_file(self):
        with tempfile.TemporaryDirectory() as directory:
            for domain, email in (("api.example.com", None), (None, "ops@example.com")):
                with self.subTest(domain=domain, email=email):
                    output = Path(directory) / "private.env"
                    result = self.invoke(output, "starter", domain=domain, email=email)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("must be supplied together", result.stderr)
                    self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
