import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "deploy-diagnostics.py"
SPEC = importlib.util.spec_from_file_location("deploy_diagnostics", SCRIPT)
diagnostics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnostics)


class DeploymentDiagnosticsTests(unittest.TestCase):
    def docker(self, containers=None, labelled=(), named=(), failure=False):
        calls = []

        def run(arguments):
            calls.append(arguments)
            if failure:
                return subprocess.CompletedProcess(arguments, 1, "", "private-daemon-secret")
            if arguments[1] == "ps":
                value = "\n".join(json.dumps(row) for row in containers or [])
            elif "label=com.docker.compose.volume=umami_postgres_data" in arguments:
                value = "\n".join(labelled)
            else:
                value = "\n".join(named)
            return subprocess.CompletedProcess(arguments, 0, value, "")

        return run, calls

    def test_reports_missing_analytics_configuration_without_values_or_shell_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("PROJECT_NAME=starter\nPOSTGRES_PASSWORD=private-db-secret\nAPI_TOKEN=$(touch NEVER_EXECUTE_THIS)\nUMAMI_APP_SECRET=\"\" # empty\n", encoding="utf-8")
            (root / ".use-caddy").touch()
            before = sorted(path.name for path in root.iterdir())
            run, calls = self.docker(containers=[{"name": "starter-api-1", "state": "running", "status": "Up 3 hours (healthy)"}], named=["starter_umami_postgres_data"])
            result = diagnostics.collect(root, "starter", run)
            self.assertEqual(result["environment"]["status"], "ok")
            keys = result["environment"]["keys"]
            self.assertTrue(keys["POSTGRES_PASSWORD"]["present"])
            self.assertTrue(keys["POSTGRES_PASSWORD"]["nonempty_literal"])
            self.assertFalse(keys["UMAMI_POSTGRES_PASSWORD"]["present"])
            self.assertFalse(keys["UMAMI_APP_SECRET"]["nonempty_literal"])
            self.assertTrue(keys["DOMAIN"]["required"])
            self.assertTrue(keys["ACME_EMAIL"]["required"])
            self.assertTrue(result["analytics_volume"]["exists"])
            self.assertEqual(result["docker"]["containers"], [{"name": "starter-api-1", "state": "running", "health": "healthy"}])
            serialized = json.dumps(result)
            for forbidden in ("private-db-secret", "touch", "NEVER_EXECUTE_THIS", str(root)):
                self.assertNotIn(forbidden, serialized)
            self.assertEqual(sorted(path.name for path in root.iterdir()), before)
            self.assertTrue(all(call[0] == "docker" and (call[1] == "ps" or call[1:3] == ["volume", "ls"]) for call in calls))
            self.assertTrue(all("label=com.docker.compose.project=starter" in call or "name=^starter_umami_postgres_data$" in call for call in calls))

    def test_preserves_missing_and_unavailable_distinction_without_printing_daemon_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, _ = self.docker(failure=True)
            failed = diagnostics.collect(root, "starter", run)
            self.assertEqual(failed["environment"]["status"], "missing")
            self.assertEqual(failed["docker"]["status"], "unavailable")
            self.assertIsNone(failed["analytics_volume"]["exists"])
            self.assertNotIn("private-daemon-secret", json.dumps(failed))
            available, _ = self.docker()
            empty = diagnostics.collect(root, "starter", available)
            self.assertFalse(empty["analytics_volume"]["exists"])
            self.assertEqual(empty["docker"], {"status": "ok", "containers": []})

    def test_literal_presence_handles_empty_quotes_comments_and_last_assignment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("API_TOKEN=secret-first\nexport API_TOKEN='' # last wins\nREDIS_PASSWORD= # absent\nUMAMI_APP_SECRET='private#token'\nGEMINI_API_KEY=${NOT_EXPANDED}\n", encoding="utf-8")
            result = diagnostics.environment_presence(path, set(diagnostics.REQUIRED_KEYS))
            self.assertFalse(result["keys"]["API_TOKEN"]["nonempty_literal"])
            self.assertFalse(result["keys"]["REDIS_PASSWORD"]["nonempty_literal"])
            self.assertTrue(result["keys"]["UMAMI_APP_SECRET"]["nonempty_literal"])
            self.assertTrue(result["keys"]["GEMINI_API_KEY"]["nonempty_literal"])
            self.assertNotIn("private#token", json.dumps(result))
            self.assertNotIn("NOT_EXPANDED", json.dumps(result))

    def test_release_sha_and_public_site_markers_are_reported_without_image_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sha = "a" * 40
            release = root / "releases" / sha
            release.mkdir(parents=True)
            (release / "compose.yaml").write_text("services: {}", encoding="utf-8")
            (release / "image.ref").write_text(f"starter:{sha}\n", encoding="utf-8")
            current = root / "current"
            current.mkdir()
            (root / ".use-public-sites").touch()
            run, _ = self.docker(labelled=["custom-analytics-volume"])
            # Mock only the symlink-resolution boundary: Windows test runners may
            # lack symlink privilege. Release files and reads remain real.
            resolve = Path.resolve

            def resolved(path, *args, **kwargs):
                return release if path == current else resolve(path, *args, **kwargs)

            with patch.object(Path, "resolve", resolved):
                result = diagnostics.collect(root, "starter", run)
                self.assertEqual(result["current_release"]["sha"], sha)
                self.assertTrue(result["current_release"]["image_reference_matches"])
                self.assertTrue(result["environment"]["keys"]["UMAMI_DOMAIN"]["required"])
                self.assertTrue(result["environment"]["keys"]["LANDING_DOMAIN"]["required"])
                self.assertTrue(result["analytics_volume"]["exists"])
                (release / "image.ref").write_text("private-credential-must-not-leak", encoding="utf-8")
                changed = diagnostics.collect(root, "starter", run)
                self.assertFalse(changed["current_release"]["image_reference_matches"])
                self.assertNotIn("private-credential", json.dumps(changed))

    def test_malformed_docker_metadata_is_not_echoed_and_invalid_arguments_do_not_run(self):
        run, _ = self.docker(containers=[{"name": "bad\nprivate-secret", "state": "private-state", "status": "private-status"}])
        result = diagnostics.container_status("starter", run)
        self.assertEqual(result["containers"], [{"name": "redacted-name", "state": "unknown", "health": "none"}])
        output, error = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            code = diagnostics.main(["/tmp/unsafe;private-secret", "starter"])
        self.assertEqual(code, 2)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("private-secret", error.getvalue())

    def test_metadata_permission_failure_produces_only_sanitized_status(self):
        output, error = io.StringIO(), io.StringIO()
        with patch.object(Path, "is_file", side_effect=PermissionError("/private/path/private-metadata-secret")):
            with redirect_stdout(output), redirect_stderr(error):
                code = diagnostics.main(["/opt/apps/starter", "starter"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"report": "deploy-diagnostics-v1", "status": "unavailable", "filesystem_metadata": "unavailable"})
        self.assertEqual(error.getvalue(), "")
        self.assertNotIn("private", output.getvalue())


if __name__ == "__main__":
    unittest.main()
