import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("license_artifacts", ROOT / "scripts/license-artifacts.py")
legal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(legal)


class LicenseArtifactTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="eldhall-legal-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        paths = ["LICENSE", "NOTICE", "docs/LICENSING.md", "docs/THIRD_PARTY_NOTICES.md", "packages/analytics/package.json", "packages/i18n/package.json",
                 "apps/mcp-openapi/pyproject.toml", "apps/mcp-openapi/uv.lock"]
        for app in ("api", "frontend", "landing"):
            paths.extend(f"apps/{app}/{name}" for name in ("package.json", "package-lock.json"))
        for app, packages in legal.BROWSER_PACKAGES.items():
            for name in packages:
                paths.extend(f"apps/{app}/node_modules/{name}/{filename}" for filename in ("package.json", legal.BROWSER_LICENSE_FILES.get(name, "LICENSE")))
        for relative in paths:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        self.generate(root)
        return root

    def generate(self, root):
        for relative, content in legal.expected_artifacts(root).items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

    def invoke(self, root, app, *arguments):
        python = app == "mcp-openapi"
        command = [sys.executable if python else "node", str(root / f"apps/{app}/scripts/check-licenses.{'py' if python else 'mjs'}"), *arguments]
        return subprocess.run(command, cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=15, check=False)

    def test_committed_artifacts_match_canonical_sources_and_locks(self):
        self.assertEqual(legal.check(ROOT), [])

    def test_canonical_or_notice_changes_cannot_silently_leave_stale_image_copies(self):
        root = self.fixture()
        (root / "NOTICE").write_bytes((root / "NOTICE").read_bytes() + b"\nUpdated attribution\n")
        errors = legal.check(root)
        for directory in legal.CONTEXTS.values():
            self.assertIn(f"{directory}/NOTICE", errors)
        (root / "LICENSE").write_text("private-invalid-license", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "canonical Apache"):
            legal.expected_artifacts(root)

    def test_browser_notices_retain_complete_upstream_text_and_fail_on_version_drift(self):
        root = self.fixture()
        for app, packages in legal.BROWSER_PACKAGES.items():
            output = legal.read(root, f"apps/{app}/public/licenses/BROWSER_NOTICES.txt")
            for name in packages:
                filename = legal.BROWSER_LICENSE_FILES.get(name, "LICENSE")
                upstream = legal.read(root, f"apps/{app}/node_modules/{name}/{filename}").rstrip()
                self.assertIn(upstream, output)
        metadata = root / "apps/frontend/node_modules/react/package.json"
        value = json.loads(metadata.read_text(encoding="utf-8"))
        value["version"] = "0.0.0"
        metadata.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "version/licence"):
            legal.expected_artifacts(root)

    def test_isolated_build_context_validators_reject_removed_or_changed_legal_files(self):
        root = self.fixture()
        for app, directory in legal.CONTEXTS.items():
            with self.subTest(app=app):
                good = self.invoke(root, app)
                self.assertEqual(good.returncode, 0, good.stderr)
                notice = root / directory / "NOTICE"
                original = notice.read_bytes()
                notice.write_bytes(b"private-notice-must-not-be-printed")
                failed = self.invoke(root, app)
                self.assertNotEqual(failed.returncode, 0)
                self.assertNotIn("private-notice", failed.stdout + failed.stderr)
                notice.unlink()
                self.assertNotEqual(self.invoke(root, app).returncode, 0)
                notice.write_bytes(original)

    def test_browser_dist_requires_notices_after_minification_independently_of_source_copies(self):
        root = self.fixture()
        for app in ("frontend", "landing"):
            with self.subTest(app=app):
                self.assertNotEqual(self.invoke(root, app, "--dist").returncode, 0)
                target = root / f"apps/{app}/dist/licenses"
                shutil.copytree(root / f"apps/{app}/public/licenses", target)
                self.assertEqual(self.invoke(root, app, "--dist").returncode, 0)
                (target / "BROWSER_NOTICES.txt").unlink()
                self.assertNotEqual(self.invoke(root, app, "--dist").returncode, 0)

    def test_git_export_excludes_reference_media_without_deleting_source_files(self):
        source = ROOT / "docs/design-system/references/01-ai-actions.png"
        self.assertTrue(source.is_file())
        result = subprocess.run(["git", "archive", "--worktree-attributes", "--format=tar", "HEAD",
                                 "docs/design-system/references", "demos/reference/youtube",
                                 ".agents/skills/eldhall-mvp-demo/assets/cursor"], cwd=ROOT,
                                capture_output=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0)
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            names = archive.getnames()
        self.assertIn("docs/design-system/references/manifest.json", names)
        self.assertFalse(any(name.endswith(".png") or name.startswith("demos/reference/youtube") or "/assets/cursor" in name for name in names))
        self.assertTrue(source.is_file())


if __name__ == "__main__":
    unittest.main()
