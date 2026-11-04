import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("initialize_deploy_config", Path(__file__).resolve().parents[1] / "initialize-deploy-config.py")
initializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(initializer)


class InitializeDeploymentConfigTests(unittest.TestCase):
    def setup_state(self, root, *, occupied=False, unavailable=False):
        state = {"locked": False, "calls": [], "generated": []}

        @contextmanager
        def locked(selected):
            self.assertEqual(selected, root)
            self.assertFalse(state["locked"])
            state["locked"] = True
            try:
                yield
            finally:
                state["locked"] = False

        def run(arguments):
            self.assertTrue(state["locked"], "Docker must be rechecked inside the deployment lock")
            self.assertFalse(state["generated"], "Do not generate secrets before checking storage")
            state["calls"].append(arguments)
            self.assertTrue(arguments[:2] == ["docker", "ps"] or arguments[:3] == ["docker", "volume", "ls"])
            return subprocess.CompletedProcess(arguments, 1 if unavailable else 0, "existing-state" if occupied else "", "private-daemon-secret")

        def generate(size):
            self.assertTrue(state["locked"])
            self.assertEqual(len(state["calls"]), 5)
            self.assertEqual(size, 32)
            value = str(len(state["generated"]) + 1) * 64
            state["generated"].append(value)
            return value

        return state, {"run": run, "generate": generate, "locked": locked}

    def test_appends_only_missing_keys_preserves_bytes_and_keeps_private_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = b"# preserve exact bytes\r\nPROJECT_NAME=starter\r\nPOSTGRES_PASSWORD='private db value'\r\nREDIS_PASSWORD=private-redis\r\nAPI_TOKEN=private-api"
            (root / ".env").write_bytes(original)
            (root / ".use-caddy").touch()
            (root / "current").mkdir()
            (root / "current" / "compose.yaml").write_text("services: {}", encoding="utf-8")
            (root / "current" / "image.ref").write_text("starter:" + "a" * 40, encoding="utf-8")
            state, dependencies = self.setup_state(root)
            report = initializer.initialize(root, "starter", **dependencies)
            updated = (root / ".env").read_bytes()
            self.assertTrue(updated.startswith(original + b"\r\n"))
            self.assertEqual(report, {"status": "initialized", "keys_added": list(initializer.TARGETS), "backup_created": True})
            self.assertEqual(len(state["generated"]), 3)
            for name, value in zip(initializer.TARGETS, state["generated"]):
                self.assertIn(f"{name}={value}\r\n".encode(), updated)
                self.assertNotIn(value, json.dumps(report))
            backups = list(root.glob(".env.before-initialize-deploy-config-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(list(root.glob(".env.initialize-deploy-config-*")), [])
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE((root / ".env").stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
            again_state, again = self.setup_state(root)
            self.assertEqual(initializer.initialize(root, "starter", **again)["status"], "already_configured")
            self.assertEqual(again_state["generated"], [])
            self.assertEqual((root / ".env").read_bytes(), updated)

    def test_existing_nonempty_values_are_never_regenerated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = b"PROJECT_NAME=starter\nUMAMI_APP_SECRET=existing-private-value\nAPI_TOKEN=untouched-api\n"
            (root / ".env").write_bytes(original)
            state, dependencies = self.setup_state(root)
            report = initializer.initialize(root, "starter", **dependencies)
            self.assertEqual(report["keys_added"], ["UMAMI_POSTGRES_PASSWORD", "OPERATOR_TOKEN"])
            self.assertEqual(len(state["generated"]), 2)
            self.assertTrue((root / ".env").read_bytes().startswith(original))
            self.assertEqual((root / ".env").read_bytes().count(b"UMAMI_APP_SECRET="), 1)

    def test_refuses_existing_or_unavailable_analytics_and_public_sites_without_env_changes(self):
        for occupied, unavailable, public_sites in ((True, False, False), (False, True, False), (False, False, True)):
            with self.subTest(occupied=occupied, unavailable=unavailable, public_sites=public_sites), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                original = b"PROJECT_NAME=starter\nPOSTGRES_PASSWORD=unchanged\n"
                (root / ".env").write_bytes(original)
                if public_sites:
                    (root / ".use-public-sites").touch()
                state, dependencies = self.setup_state(root, occupied=occupied, unavailable=unavailable)
                with self.assertRaises(initializer.Refused):
                    initializer.initialize(root, "starter", **dependencies)
                self.assertEqual((root / ".env").read_bytes(), original)
                self.assertEqual(state["generated"], [])
                self.assertEqual(list(root.glob(".env.before-*")), [])

    def test_refuses_duplicate_empty_and_ambiguous_target_declarations(self):
        for original in (b"OPERATOR_TOKEN=\n", b"OPERATOR_TOKEN='   '\n", b"UMAMI_APP_SECRET='' # empty\n", b"UMAMI_APP_SECRET=a\nUMAMI_APP_SECRET=b\n", b"UMAMI_POSTGRES_PASSWORD: ambiguous\n"):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                original = b"PROJECT_NAME=starter\n" + original
                (root / ".env").write_bytes(original)
                state, dependencies = self.setup_state(root)
                with self.assertRaises(initializer.Refused):
                    initializer.initialize(root, "starter", **dependencies)
                self.assertEqual((root / ".env").read_bytes(), original)
                self.assertEqual(state["calls"], [])

    def test_refuses_symlink_and_preserves_original_if_atomic_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = b"PROJECT_NAME=starter\nAPI_TOKEN=unchanged\n"
            (root / ".env").write_bytes(original)
            state, dependencies = self.setup_state(root)
            with patch.object(Path, "is_symlink", return_value=True), self.assertRaises(initializer.Refused):
                initializer.initialize(root, "starter", **dependencies)
            self.assertEqual(state["calls"], [])
            with patch.object(os, "replace", side_effect=PermissionError("private-path")), self.assertRaises(PermissionError):
                initializer.initialize(root, "starter", **dependencies)
            self.assertEqual((root / ".env").read_bytes(), original)
            self.assertEqual(list(root.glob(".env.initialize-deploy-config-*")), [])
            self.assertEqual(list(root.glob(".env.before-initialize-deploy-config-*"))[0].read_bytes(), original)

    def test_project_and_current_release_identity_must_match_before_docker_or_writes(self):
        for original, reference in ((b"PROJECT_NAME=another\n", None), (b"PROJECT_NAME=starter\nCOMPOSE_PROJECT_NAME=another\n", None), (b"PROJECT_NAME=starter\nCOMPOSE_PROJECT_NAME: another\n", None), (b"PROJECT_NAME=starter\nPROJECT_NAME=starter\n", None), (b"PROJECT_NAME=starter\n", "another:" + "a" * 40)):
            with self.subTest(original=original, reference=reference), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / ".env").write_bytes(original)
                if reference:
                    (root / "current").mkdir()
                    (root / "current" / "compose.yaml").write_text("services: {}", encoding="utf-8")
                    (root / "current" / "image.ref").write_text(reference, encoding="utf-8")
                state, dependencies = self.setup_state(root)
                with self.assertRaises(initializer.Refused):
                    initializer.initialize(root, "starter", **dependencies)
                self.assertEqual((root / ".env").read_bytes(), original)
                self.assertEqual(state["calls"], [])
                self.assertEqual(state["generated"], [])
                self.assertEqual(list(root.glob(".env.before-*")), [])

    def test_main_sanitizes_failure_and_success_output(self):
        for exception in (PermissionError("private-path-and-value"), initializer.Refused("analytics_state_unavailable")):
            output = io.StringIO()
            with patch.object(initializer, "initialize", side_effect=exception), redirect_stdout(output):
                self.assertEqual(initializer.main(["/opt/apps/starter", "starter"]), 1)
            self.assertNotIn("private", output.getvalue())
            self.assertIn(json.loads(output.getvalue())["status"], ("refused", "unavailable"))


if __name__ == "__main__":
    unittest.main()
