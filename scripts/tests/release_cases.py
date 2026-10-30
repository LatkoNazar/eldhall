"""Exercise Bash release scripts with isolated roots and an injected Docker boundary."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parent
SHA1 = "a" * 40
SHA2 = "b" * 40


class ReleaseIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="project-release-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.binary = self.directory / "bin"
        self.binary.mkdir()
        docker = self.binary / "docker"
        shutil.copy(SCRIPTS / "tests/fake-docker.py", docker)
        docker.chmod(0o755)
        self.log = self.directory / "docker.jsonl"
        self.environment = os.environ.copy()
        for key in (
            "PROJECT_NAME",
            "COMPOSE_PROJECT_NAME",
            "APP_IMAGE",
            "FRONTEND_IMAGE",
            "LANDING_IMAGE",
            "FAKE_FAIL",
            "FAKE_FAIL_IMAGE",
        ):
            self.environment.pop(key, None)
        self.environment.update(
            PATH=f"{self.binary}:{self.environment['PATH']}", FAKE_DOCKER_LOG=str(self.log)
        )

    def release(self, root: Path, sha: str, *, legacy=False, landing=False, analytics=False):
        release = root / "releases" / sha
        api_scripts = release / ("apps/backend/scripts" if legacy else "apps/api/scripts")
        api_scripts.mkdir(parents=True)
        services = ["postgres", "redis", "rabbitmq", "api", "worker", "migrate", "frontend"]
        if legacy:
            services = ["api", "worker"]
        if landing:
            services.append("landing")
        if analytics:
            services.extend(["umami-db", "umami"])
        composition = "services:\n" + "".join(f"  {name}: {{}}\n" for name in services)
        (release / "compose.yaml").write_text(composition)
        (release / "compose.prod.yaml").write_text("services: {}\n")
        (release / "scripts").mkdir()
        shutil.copy(SCRIPTS / "frontend-smoke.py", release / "scripts")
        shutil.copy(SCRIPTS / "landing-smoke.py", release / "scripts")
        shutil.copy(REPO / "apps/api/scripts/smoke.py", api_scripts)
        (release / "image.tar.gz").write_bytes(b"test image archive")
        return release

    def project(self, name: str, *, landing=False, analytics=False):
        root = self.directory / name
        root.mkdir()
        (root / ".env").write_text(f"PROJECT_NAME={name}\n")
        self.release(root, SHA1, landing=landing, analytics=analytics)
        self.release(root, SHA2, landing=landing, analytics=analytics)
        return root

    def run_script(self, name: str, *args: str | Path, fail=None, overrides=None):
        environment = self.environment | (overrides or {})
        if fail:
            environment["FAKE_FAIL"] = fail
        result = subprocess.run(
            ["bash", str(SCRIPTS / name), *map(str, args)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotIn("never-print-resolved-secrets", result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def assert_read_only_calls(self):
        for call in self.calls():
            self.assertIn("config", call["args"], call)

    def deploy(self, root, sha, project):
        result = self.run_script("deploy.sh", root, sha, project)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_two_projects_deploy_rollback_and_back_up_without_crossing_namespaces(self):
        for name in ("alpha-app", "beta-app"):
            root = self.project(name)
            self.deploy(root, SHA1, name)
            self.assertEqual((root / "current/image.ref").read_text().strip(), f"{name}:{SHA1}")
            self.assertEqual(
                (root / "current/frontend-image.ref").read_text().strip(), f"{name}-frontend:{SHA1}"
            )
            self.deploy(root, SHA2, name)
            result = self.run_script("rollback.sh", root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "current").resolve().name, SHA1)
            self.assertEqual(
                (root / "current/frontend-image.ref").read_text().strip(), f"{name}-frontend:{SHA1}"
            )
            backup = self.run_script("backup.sh", root)
            self.assertEqual(backup.returncode, 0, backup.stderr)
            self.assertEqual(Path(backup.stdout.strip()).read_text(), "database-dump\n")
        for call in self.calls():
            self.assertNotIn("--project-name", call["args"])
            if call["project"]:
                self.assertIn(call["project"], {"alpha-app", "beta-app"})
                self.assertTrue(call["image"].startswith(call["project"] + ":"), call)
                if call["frontend_image"]:
                    self.assertEqual(
                        call["frontend_image"], call["image"].replace(":", "-frontend:")
                    )

    def test_wrong_env_identity_fails_before_directory_or_docker_mutations(self):
        root = self.project("alpha")
        (root / ".env").write_text("PROJECT_NAME=beta\n")
        result = self.run_script("deploy.sh", root, SHA1, "alpha")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)
        self.assertFalse((root / "backups").exists())
        self.assertFalse((root / ".deploy.lock").exists())
        self.assertTrue((root / "releases" / SHA1 / "image.tar.gz").exists())
        self.assert_read_only_calls()

    def test_existing_root_cannot_be_renamed_even_when_env_and_expected_name_change(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.log.write_text("")
        (root / ".env").write_text("PROJECT_NAME=beta\n")
        result = self.run_script("deploy.sh", root, SHA2, "beta")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("belongs to 'alpha'", result.stderr)
        self.assertEqual((root / "current").resolve().name, SHA1)
        self.assertTrue((root / "releases" / SHA2 / "image.tar.gz").exists())
        self.assert_read_only_calls()

    def test_rollback_and_backup_refuse_changed_env_namespace(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        self.log.write_text("")
        (root / ".env").write_text("PROJECT_NAME=beta\n")
        for script in ("rollback.sh", "backup.sh"):
            self.assertNotEqual(self.run_script(script, root).returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA2)
        self.assert_read_only_calls()

    def test_migration_failure_restores_only_same_project_previous_image(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.log.write_text("")
        result = self.run_script("deploy.sh", root, SHA2, "alpha", fail="migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA1)
        restorations = [
            call for call in self.calls() if "up" in call["args"] and "api" in call["args"]
        ]
        self.assertEqual(len(restorations), 1)
        self.assertEqual(restorations[0]["image"], f"alpha:{SHA1}")
        self.assertEqual(restorations[0]["frontend_image"], f"alpha-frontend:{SHA1}")
        self.assertTrue(all(call["project"] in (None, "alpha") for call in self.calls()))

    def test_failed_first_deploy_has_no_current_or_phantom_rollback(self):
        root = self.project("alpha")
        result = self.run_script("deploy.sh", root, SHA1, "alpha", fail="migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "current").is_symlink())
        self.assertFalse(
            any("up" in call["args"] and "api" in call["args"] for call in self.calls())
        )

    def test_incomplete_existing_release_is_not_silently_replaced(self):
        root = self.project("alpha")
        (root / "current").symlink_to(root / "releases" / SHA1)
        result = self.run_script("deploy.sh", root, SHA2, "alpha")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "backups").exists())
        self.assert_read_only_calls()

    def test_external_compose_override_cannot_redirect_deployment(self):
        root = self.project("alpha")
        result = self.run_script(
            "deploy.sh", root, SHA1, "alpha", overrides={"COMPOSE_PROJECT_NAME": "beta"}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "backups").exists())
        self.assert_read_only_calls()

    def test_compose_configuration_failure_stops_before_mutations(self):
        root = self.project("alpha")
        self.assertNotEqual(
            self.run_script("deploy.sh", root, SHA1, "alpha", fail="config").returncode, 0
        )
        self.assertFalse((root / "backups").exists())
        self.assert_read_only_calls()

    def test_invalid_names_are_rejected_before_docker_or_bootstrap_commands(self):
        root = self.project("alpha")
        for name in ("UPPER", "a_b", "-x", "x-", "a" * 64):
            self.assertNotEqual(self.run_script("deploy.sh", root, SHA1, name).returncode, 0)
            result = self.run_script("bootstrap-ubuntu.sh", "nobody", name)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("lowercase slug", result.stderr)
        self.assertFalse(self.log.exists())

    def make_legacy(self, release):
        (release / "compose.yaml").write_text("services:\n  api: {}\n  worker: {}\n")
        (release / "compose.prod.yaml").write_text("services: {}\n")
        historical = release / "apps/backend/scripts"
        historical.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / "apps/api/scripts/smoke.py", historical)
        (release / "apps/api/scripts/smoke.py").unlink(missing_ok=True)

    def test_legacy_upgrade_and_rollback_restores_proxy_then_removes_only_frontend(self):
        root = self.project("alpha")
        self.make_legacy(root / "releases" / SHA1)
        (root / ".use-caddy").touch()
        self.deploy(root, SHA1, "alpha")
        self.assertFalse((root / "current/frontend-image.ref").exists())
        self.deploy(root, SHA2, "alpha")
        self.log.write_text("")
        result = self.run_script("rollback.sh", root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "current").resolve().name, SHA1)
        calls = self.calls()
        proxy = next(
            i for i, call in enumerate(calls) if "up" in call["args"] and "caddy" in call["args"]
        )
        cleanup = next(i for i, call in enumerate(calls) if "rm" in call["args"])
        self.assertLess(proxy, cleanup)
        self.assertIn(SHA1, calls[proxy]["composition"])
        self.assertIn(SHA2, calls[cleanup]["composition"])
        self.assertEqual(calls[cleanup]["args"][-3:], ["rm", "-f", "frontend"])
        self.assertFalse(any("--volumes" in call["args"] for call in calls))
        # The same current script can also roll forward to the paired frontend release.
        result = self.run_script("rollback.sh", root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (root / "current/frontend-image.ref").read_text().strip(), f"alpha-frontend:{SHA2}"
        )

    def test_failed_frontend_upgrade_restores_legacy_backend_proxy_and_cleans_container(self):
        root = self.project("alpha")
        self.make_legacy(root / "releases" / SHA1)
        (root / ".use-caddy").touch()
        self.deploy(root, SHA1, "alpha")
        self.log.write_text("")
        result = self.run_script("deploy.sh", root, SHA2, "alpha", fail="frontend")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA1)
        calls = self.calls()
        restored = [
            call
            for call in calls
            if "up" in call["args"] and "api" in call["args"] and call["image"] == f"alpha:{SHA1}"
        ]
        self.assertEqual(len(restored), 1)
        self.assertNotIn("frontend", restored[0]["args"])
        self.assertTrue(any("rm" in call["args"] and "frontend" in call["args"] for call in calls))

    def test_failed_frontend_release_restores_both_previous_images(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.log.write_text("")
        result = self.run_script(
            "deploy.sh",
            root,
            SHA2,
            "alpha",
            fail="frontend",
            overrides={"FAKE_FAIL_IMAGE": f"alpha:{SHA2}"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA1)
        restored = [
            call
            for call in self.calls()
            if "up" in call["args"]
            and "frontend" in call["args"]
            and call["image"] == f"alpha:{SHA1}"
        ]
        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0]["frontend_image"], f"alpha-frontend:{SHA1}")
        self.assertFalse(any("rm" in call["args"] for call in self.calls()))

    def test_missing_or_mismatched_frontend_ref_blocks_rollback_before_mutation(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        reference = root / "previous/frontend-image.ref"
        for invalid in (None, f"beta-frontend:{SHA1}", f"alpha-frontend:{SHA2}"):
            if invalid is None:
                reference.unlink()
            else:
                reference.write_text(invalid)
            self.log.write_text("")
            result = self.run_script("rollback.sh", root)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / "current").resolve().name, SHA2)
            self.assert_read_only_calls()

    def test_failed_first_frontend_release_removes_only_its_frontend_container(self):
        root = self.project("alpha")
        result = self.run_script("deploy.sh", root, SHA1, "alpha", fail="frontend")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "current").exists())
        removed = [call for call in self.calls() if "rm" in call["args"]]
        self.assertEqual(len(removed), 1)
        self.assertEqual(removed[0]["project"], "alpha")
        self.assertEqual(removed[0]["args"][-3:], ["rm", "-f", "frontend"])

    def test_failed_manual_rollback_restores_current_backend_and_frontend_pair(self):
        root = self.project("alpha")
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        self.log.write_text("")
        result = self.run_script(
            "rollback.sh", root, fail="frontend", overrides={"FAKE_FAIL_IMAGE": f"alpha:{SHA1}"}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA2)
        restored = [
            call
            for call in self.calls()
            if "up" in call["args"]
            and "frontend" in call["args"]
            and call["image"] == f"alpha:{SHA2}"
        ]
        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0]["frontend_image"], f"alpha-frontend:{SHA2}")

    def test_failed_rollforward_from_legacy_cleans_frontend_and_preserves_legacy_proxy(self):
        root = self.project("alpha")
        self.make_legacy(root / "releases" / SHA1)
        (root / ".use-caddy").touch()
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        self.assertEqual(self.run_script("rollback.sh", root).returncode, 0)
        self.log.write_text("")
        result = self.run_script("rollback.sh", root, fail="frontend")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA1)
        calls = self.calls()
        self.assertTrue(
            any(
                "caddy" in call["args"] and "up" in call["args"] and SHA1 in call["composition"]
                for call in calls
            )
        )
        self.assertTrue(any("rm" in call["args"] and "frontend" in call["args"] for call in calls))

    def test_landing_image_pair_is_saved_and_mismatched_reference_blocks_rollback(self):
        root = self.project("alpha", landing=True)
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        self.assertEqual(
            (root / "current/landing-image.ref").read_text().strip(), f"alpha-landing:{SHA2}"
        )
        reference = root / "previous/landing-image.ref"
        for invalid in (None, f"beta-landing:{SHA1}", f"alpha-landing:{SHA2}"):
            if invalid is None:
                reference.unlink()
            else:
                reference.write_text(invalid)
            self.log.write_text("")
            self.assertNotEqual(self.run_script("rollback.sh", root).returncode, 0)
            self.assertEqual((root / "current").resolve().name, SHA2)
            self.assert_read_only_calls()

    def test_failed_landing_upgrade_restores_the_previous_landing_image(self):
        root = self.project("alpha", landing=True)
        self.deploy(root, SHA1, "alpha")
        self.log.write_text("")
        result = self.run_script(
            "deploy.sh",
            root,
            SHA2,
            "alpha",
            fail="landing",
            overrides={"FAKE_FAIL_IMAGE": f"alpha:{SHA2}"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / "current").resolve().name, SHA1)
        restored = [
            call
            for call in self.calls()
            if "up" in call["args"]
            and "landing" in call["args"]
            and call["image"] == f"alpha:{SHA1}"
        ]
        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0]["landing_image"], f"alpha-landing:{SHA1}")

    def test_rollback_to_pre_landing_release_removes_only_landing_and_keeps_analytics(self):
        root = self.project("alpha")
        modern = root / "releases" / SHA2
        with (modern / "compose.yaml").open("a") as handle:
            handle.write("  landing: {}\n  umami-db: {}\n  umami: {}\n")
        self.deploy(root, SHA1, "alpha")
        self.deploy(root, SHA2, "alpha")
        self.assertEqual((root / "analytics-current").resolve().name, SHA2)
        self.log.write_text("")
        result = self.run_script("rollback.sh", root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "analytics-current").resolve().name, SHA2)
        removed = [call for call in self.calls() if "rm" in call["args"]]
        self.assertEqual([call["args"][-1] for call in removed], ["landing"])
        self.assertFalse(
            any("umami" in call["args"] or "umami-db" in call["args"] for call in self.calls())
        )
        self.assertFalse(any("--volumes" in call["args"] for call in self.calls()))
        backup = self.run_script("backup.sh", root)
        self.assertEqual(backup.returncode, 0, backup.stderr)
        paths = [Path(line) for line in backup.stdout.splitlines()]
        self.assertEqual(
            [path.read_text() for path in paths], ["database-dump\n", "analytics-dump\n"]
        )

    def test_analytics_version_change_is_rejected_before_mutations(self):
        root = self.project("alpha", landing=True, analytics=True)
        self.deploy(root, SHA1, "alpha")
        with (root / "releases" / SHA2 / "compose.yaml").open("a") as handle:
            handle.write("    image: ghcr.io/umami-software/umami:99.0.0\n")
        self.log.write_text("")
        result = self.run_script("deploy.sh", root, SHA2, "alpha")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("separate backed-up analytics upgrade", result.stderr)
        self.assertEqual((root / "current").resolve().name, SHA1)
        self.assert_read_only_calls()

    def test_analytics_registry_images_are_started_without_pull_never(self):
        root = self.project("alpha", analytics=True)
        self.deploy(root, SHA1, "alpha")
        calls = [call for call in self.calls() if "up" in call["args"] and "umami" in call["args"]]
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--pull", calls[0]["args"])
        app_calls = [
            call for call in self.calls() if "up" in call["args"] and "api" in call["args"]
        ]
        self.assertEqual(len(app_calls), 1)
        self.assertIn("never", app_calls[0]["args"])

    def test_analytics_database_downgrade_is_rejected_before_mutations(self):
        root = self.project("alpha", analytics=True)
        self.deploy(root, SHA1, "alpha")
        composition = root / "releases" / SHA2 / "compose.yaml"
        composition.write_text(
            composition.read_text().replace(
                "  umami-db: {}\n", "  umami-db:\n    image: postgres:16.1-bookworm\n"
            )
        )
        self.log.write_text("")
        result = self.run_script("deploy.sh", root, SHA2, "alpha")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("separate backed-up analytics upgrade", result.stderr)
        self.assertEqual((root / "current").resolve().name, SHA1)
        self.assert_read_only_calls()


if __name__ == "__main__":
    unittest.main()
