import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / "candidate-image-evidence.py"
SPEC = importlib.util.spec_from_file_location("candidate_image_evidence", SCRIPT)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


class CandidateEvidenceTests(unittest.TestCase):
    def metadata(self):
        return {"containerimage.config.digest": "sha256:" + "a" * 64,
                "containerimage.digest": "sha256:" + "b" * 64,
                "buildx.build.provenance": {"materials": [{"uri": "pkg:docker/node@24-bookworm?platform=linux%2Farm64", "digest": {"sha256": "c" * 64}}]},
                "private-field": {"token": "never-retain-this"}}

    def test_build_receipt_retains_only_digest_material_allowlist(self):
        record = evidence.build_materials(self.metadata())
        self.assertNotIn("private", json.dumps(record))
        self.assertNotIn("never-retain-this", json.dumps(record))
        self.assertEqual(record["buildMaterials"][0]["digest"], "sha256:" + "c" * 64)
        self.assertEqual(record["configDigest"], "sha256:" + "a" * 64)
        self.assertNotEqual(record["configDigest"], record["localManifestDigest"])

    def test_missing_build_materials_or_bad_digests_are_not_success(self):
        for mutate in [lambda value: value.pop("containerimage.config.digest"),
                       lambda value: value.update({"containerimage.digest": "sha256:short"}),
                       lambda value: value.update({"buildx.build.provenance": {}}),
                       lambda value: value["buildx.build.provenance"]["materials"][0].update({"digest": {"sha256": "A" * 64}})]:
            value = self.metadata()
            mutate(value)
            with self.assertRaises(ValueError):
                evidence.build_materials(value)

    def test_os_packages_preserve_linux_source_and_license_fields(self):
        debian = evidence.os_inventory("FORMAT\tdpkg\nlibsample\t1.2-3\tarm64\tsample-source\t1.2-3\n")
        self.assertEqual(debian["packages"][0]["sourceVersion"], "1.2-3")
        alpine = evidence.os_inventory("FORMAT\tapk\nP:sample\nV:1.2-r0\nA:x86_64\no:sample-origin\nL:MIT AND BSD-2-Clause\n\n")
        self.assertEqual(alpine["packages"][0]["license"], "MIT AND BSD-2-Clause")
        self.assertEqual(alpine["packages"][0]["origin"], "sample-origin")
        for invalid in ["", "FORMAT\tdpkg\n", "FORMAT\tdpkg\nwrong\n", "FORMAT\tapk\nP:missing-version\n"]:
            with self.assertRaises(ValueError):
                evidence.os_inventory(invalid)

    def test_command_failure_does_not_expose_stderr_or_large_output(self):
        for result in [subprocess.CompletedProcess([], 1, "", "SECRET=do-not-print"),
                       subprocess.CompletedProcess([], 0, "x" * (evidence.LIMIT + 1), "")]:
            with patch.object(evidence.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, "failed or exceeded") as error:
                    evidence.command(["docker", "info"])
                self.assertNotIn("SECRET", str(error.exception))

    def test_native_mismatch_refuses_before_reading_images_or_writing_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with patch.object(evidence.platform, "machine", return_value="x86_64"), patch.object(evidence, "command") as command:
                with self.assertRaisesRegex(ValueError, "native matrix architecture"):
                    evidence.collect("arm64", "0.1.0-rc.1", "a" * 40, root, root / "out")
                command.assert_not_called()
                self.assertFalse((root / "out").exists())

    def test_image_architecture_or_build_config_mismatch_refuses_inventory(self):
        for architecture, image_id in [("amd64", "sha256:" + "a" * 64), ("arm64", "sha256:" + "d" * 64)]:
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                (root / "server.json").write_text(json.dumps(self.metadata()))
                inspection = json.dumps({"Architecture": architecture, "Os": "linux", "Id": image_id})
                with patch.object(evidence.platform, "machine", return_value="aarch64"), patch.object(evidence, "command", side_effect=["aarch64\n", inspection]), patch.object(evidence, "container") as container:
                    with self.assertRaisesRegex(ValueError, "architecture/config identity"):
                        evidence.collect("arm64", "0.1.0-rc.1", "a" * 40, root, root / "out")
                    container.assert_not_called()
                    self.assertEqual(list((root / "out").iterdir()), [])

    def test_inventory_runs_have_no_network_no_host_mounts_and_no_env(self):
        with patch.object(evidence, "command", return_value="{}") as command:
            evidence.container("eldhall-server:candidate", "node", ["-"], source="static-input")
        args = command.call_args.args[0]
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertIn("--read-only", args)
        for forbidden in ["--privileged", "--env-file", "--volume", "-v", "-e"]:
            self.assertNotIn(forbidden, args)

    def test_native_package_nested_nonstandard_license_names_are_hashed(self):
        with tempfile.TemporaryDirectory() as directory:
            modules = pathlib.Path(directory) / "node_modules"
            package = modules / "native-engine"
            notices = package / "licenses"
            notices.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": "native-engine", "version": "1.0.0", "license": "MIT"}))
            (package / "README.md").write_text("Not a license receipt")
            for name in ("DeepSeek-Harness-MIT.txt", "LibreOffice-MPL-2.0.txt", "LibreOffice-third-party.html"):
                (notices / name).write_text("Synthetic notice for " + name)
            result = subprocess.run(["node", "--input-type=module", "-", json.dumps([str(modules)])], input=evidence.NODE_INVENTORY, capture_output=True, text=True, timeout=30, check=True)
            inventory = json.loads(result.stdout)
            self.assertEqual(len(inventory["packages"]), 1)
            receipts = inventory["packages"][0]["licenseFiles"]
            self.assertEqual({pathlib.Path(item["path"]).name for item in receipts}, {"DeepSeek-Harness-MIT.txt", "LibreOffice-MPL-2.0.txt", "LibreOffice-third-party.html"})
            for receipt in receipts:
                self.assertEqual(receipt["sha256"], evidence.hashlib.sha256(pathlib.Path(receipt["path"]).read_bytes()).hexdigest())
                self.assertNotIn("Synthetic notice", json.dumps(receipt))

    def test_output_limit_prevents_oversized_evidence_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            evidence.write_json(root, "safe.json", {"status": "ok"})
            self.assertEqual(json.loads((root / "safe.json").read_text())["status"], "ok")
            with self.assertRaises(ValueError):
                evidence.write_json(root, "oversized.json", "x" * evidence.LIMIT)
            self.assertFalse((root / "oversized.json").exists())


if __name__ == "__main__":
    unittest.main()
