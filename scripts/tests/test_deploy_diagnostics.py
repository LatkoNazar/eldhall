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
    def legacy_docker(self, sql=None, broker="0\t0\t1\n", absent=False, invalid_service=None,
                      selection=None, failed_probe=None):
        calls = []
        ids = {"rabbitmq": "a" * 64, "postgres": "b" * 64}
        counts = {"total": 7, "queued": 0, "running": 0, "succeeded": 6, "failed": 1, "other": 0}

        def run(arguments):
            calls.append(arguments)
            if arguments[1] == "ps":
                service = next(arg.rsplit("=", 1)[1] for arg in arguments if arg.startswith("label=com.docker.compose.service="))
                value = ("" if absent and service == "rabbitmq" else selection if selection is not None else ids[service])
            elif arguments[1] == "inspect":
                service = next(key for key, value in ids.items() if value == arguments[-1])
                value = json.dumps({"id": ids[service], "running": True, "project": "foreign" if invalid_service == service else "starter", "service": service})
            elif arguments[1] == "exec":
                service = next(key for key, value in ids.items() if value == arguments[2])
                if service == failed_probe:
                    return subprocess.CompletedProcess(arguments, 1, "private-probe-output", "private-probe-error")
                value = (json.dumps(counts) if sql is None else sql) if service == "postgres" else broker
            else:
                raise AssertionError("Unexpected Docker operation")
            return subprocess.CompletedProcess(arguments, 0, value, "")

        return run, calls

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

    def test_legacy_counts_are_aggregated_without_names_payloads_or_credentials(self):
        counts = {"total": 10, "queued": 2, "running": 1, "succeeded": 6, "failed": 1, "other": 0}
        run, calls = self.legacy_docker(sql=json.dumps(counts), broker="3\t2\t1\n4\t0\t2\n")
        result = diagnostics.legacy_queue_status("starter", run)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["pending_work"])
        self.assertTrue(result["snapshot_only"])
        self.assertEqual(result["postgres"], {"status": "ok", **counts})
        self.assertEqual(result["rabbitmq"], {"status": "ok", "queues": 2, "messages_ready": 7,
                                             "messages_unacknowledged": 2, "consumers": 3})
        executions = [call for call in calls if call[1] == "exec"]
        self.assertEqual(len(executions), 2)
        self.assertEqual(executions[0][2], "b" * 64)
        self.assertEqual(executions[1][2], "a" * 64)
        self.assertEqual(executions[0][3:], ["sh", "-ec", diagnostics.SQL_COUNTS])
        self.assertEqual(executions[1][3:], ["sh", "-ec", diagnostics.RABBIT_COUNTS])
        self.assertIn("default_transaction_read_only=on", executions[0][-1])
        self.assertIn('"${POSTGRES_USER:?}"', executions[0][-1])
        self.assertIn('"${RABBITMQ_DEFAULT_VHOST:?}"', executions[1][-1])
        self.assertNotIn("PASSWORD", " ".join(executions[0]))
        self.assertNotIn("name", executions[1][-1])
        self.assertNotIn("payload", executions[1][-1])
        serialized = json.dumps(result)
        for forbidden in ("a" * 64, "b" * 64, "starter", "POSTGRES", "RABBITMQ"):
            self.assertNotIn(forbidden, serialized)

    def test_zero_legacy_snapshot_is_not_a_cutover_or_absence_claim(self):
        run, _ = self.legacy_docker(broker="")
        result = diagnostics.legacy_queue_status("starter", run)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["legacy_container_present"])
        self.assertFalse(result["pending_work"])
        self.assertTrue(result["snapshot_only"])
        self.assertEqual(result["rabbitmq"]["queues"], 0)
        self.assertNotIn("cutover_safe", result)
        run, calls = self.legacy_docker(absent=True)
        absent = diagnostics.legacy_queue_status("starter", run)
        self.assertEqual(absent["status"], "no_legacy_container")
        self.assertFalse(absent["legacy_container_present"])
        self.assertIsNone(absent["pending_work"])
        self.assertFalse(any(call[1] == "exec" for call in calls))

    def test_legacy_probe_failures_and_corrupt_counts_never_become_zero_work(self):
        invalid_sql = ("private-invalid-json", '{"total":0}',
                       json.dumps({"total": 0, "queued": True, "running": 0, "succeeded": 0, "failed": 0, "other": 0}),
                       json.dumps({"total": 0, "queued": 1, "running": 0, "succeeded": 0, "failed": 0, "other": 0}))
        for value in invalid_sql:
            with self.subTest(sql=value):
                run, _ = self.legacy_docker(sql=value)
                result = diagnostics.legacy_queue_status("starter", run)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["pending_work"])
                self.assertEqual(result["postgres"], {"status": "unavailable"})
                self.assertNotIn("private", json.dumps(result))
        for broker in ("queue-private-name\t0\t0\t1", "0 -1 1", "0 0", "9" * 20 + " 0 0"):
            with self.subTest(broker=broker):
                run, _ = self.legacy_docker(broker=broker)
                result = diagnostics.legacy_queue_status("starter", run)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["pending_work"])
                self.assertNotIn("private", json.dumps(result))
        for service in ("postgres", "rabbitmq"):
            with self.subTest(failed=service):
                run, _ = self.legacy_docker(failed_probe=service)
                result = diagnostics.legacy_queue_status("starter", run)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["pending_work"])
                self.assertNotIn("private", json.dumps(result))

    def test_legacy_exec_requires_one_full_id_and_verified_selected_project_labels(self):
        for selection in ("private-injected-id", "a" * 12, "a" * 64 + "\n" + "b" * 64):
            with self.subTest(selection=selection):
                run, calls = self.legacy_docker(selection=selection)
                result = diagnostics.legacy_queue_status("starter", run)
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(any(call[1] == "exec" for call in calls))
        for service in ("rabbitmq", "postgres"):
            with self.subTest(labels=service):
                run, calls = self.legacy_docker(invalid_service=service)
                result = diagnostics.legacy_queue_status("starter", run)
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(any(call[1] == "exec" and call[2] == ("a" if service == "rabbitmq" else "b") * 64 for call in calls))
                self.assertNotIn("foreign", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
