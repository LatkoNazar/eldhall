import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / "candidate-image-evidence.py"
SPEC = importlib.util.spec_from_file_location("candidate_image_evidence", SCRIPT)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)
SOURCE_SPEC = importlib.util.spec_from_file_location("candidate_image_source", SCRIPT.with_name("candidate-image-source.py"))
candidate_source = importlib.util.module_from_spec(SOURCE_SPEC)
SOURCE_SPEC.loader.exec_module(candidate_source)
FIXTURE_SPEC = importlib.util.spec_from_file_location("source_archive_test_fixture", pathlib.Path(__file__).with_name("test_source_archive.py"))
archive_fixture = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(archive_fixture)


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
        self.assertEqual(record["buildxOutputDigest"], "sha256:" + "b" * 64)
        self.assertEqual(record["buildxOutputDigestKind"], "unverified-local-exporter-digest")
        self.assertNotIn("localManifestDigest", record)

    def test_loaded_buildx_digest_may_equal_config_id_without_manifest_claim(self):
        value = self.metadata()
        value["containerimage.digest"] = value["containerimage.config.digest"]
        record = evidence.build_materials(value)
        self.assertEqual(record["buildxOutputDigest"], record["configDigest"])
        self.assertEqual(record["buildxOutputDigestKind"], "unverified-local-exporter-digest")
        self.assertFalse(any("manifest" in key.lower() for key in record))

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

    def run_node_inventory(self, modules):
        return subprocess.run(["node", "--input-type=module", "-", json.dumps([str(modules)])], input=evidence.NODE_INVENTORY, capture_output=True, text=True, timeout=30)

    def native_fixture(self, root, name='@img/sharp-libvips-linux-x64'):
        modules = root / 'node_modules'
        parent = modules / 'consumer'
        parent.mkdir(parents=True)
        (parent / 'package.json').write_text(json.dumps({'name': 'consumer', 'version': '1.0.0'}))
        package = parent / 'node_modules' / name
        (package / 'lib').mkdir(parents=True)
        manifest = json.dumps({'name': name, 'version': '1.3.4', 'license': 'LGPL-3.0-or-later'}).encode()
        (package / 'package.json').write_bytes(manifest)
        return modules, package, manifest

    def test_wasm_elf_and_generated_sharp_notices_are_exact_installed_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            modules, package, manifest = self.native_fixture(pathlib.Path(directory))
            # Exact upstream v1.3.4 layout: package README is generated from
            # THIRD-PARTY-NOTICES; it is not named LICENSE and can be nested
            # under another npm package. Bytes here are synthetic test text.
            notice = b'\xef\xbb\xbf# Fixture\r\n## Licensing\r\nComplete notice: \xc2\xa9 sample\r\nhttps://never-fetch.invalid/source\r\n'
            (package / 'README.md').write_bytes(notice)
            (package / 'versions.json').write_bytes(b'{"vips":"8.18.7"}\r\n')
            wasm = b'\x00asm\x01\x00\x00\x00synthetic wasm'
            elf = b'\x7fELFsynthetic elf'
            (package / 'lib/runtime.wasm').write_bytes(wasm)
            (package / 'lib/libvips.so').write_bytes(elf)
            (package / 'lib/not-really.wasm').write_bytes(b'not wasm magic')
            result = self.run_node_inventory(modules)
            self.assertEqual(result.returncode, 0, 'Fixture collector failed')
            value = json.loads(result.stdout)
            component = value['nativeComponents'][0]
            self.assertEqual(component['package']['manifestSha256'], evidence.hashlib.sha256(manifest).hexdigest())
            self.assertEqual(component['sourceAvailability'], 'not_verified')
            self.assertEqual(component['missingKinds'], [])
            self.assertEqual({binary['format'] for binary in component['binaries']}, {'elf', 'wasm'})
            wasm_receipt = next(binary for binary in component['binaries'] if binary['format'] == 'wasm')
            self.assertEqual(wasm_receipt['sha256'], evidence.hashlib.sha256(wasm).hexdigest())
            self.assertEqual(wasm_receipt['package'], component['package'])
            readme = next(item for item in component['receipts'] if item['relativePath'] == 'README.md')
            self.assertEqual(readme['kind'], 'notice')
            self.assertEqual(readme['text'].encode('utf-8'), notice)
            self.assertEqual(readme['sha256'], evidence.hashlib.sha256(notice).hexdigest())
            self.assertTrue(any(item['relativePath'] == 'versions.json' and item['kind'] == 'build-source-metadata' for item in component['receipts']))
            image = {'imageId': 'sha256:' + 'a' * 64, 'architecture': 'amd64', **evidence.build_materials(self.metadata())}
            bound = evidence.native_review_inputs(value['nativeComponents'], image, 'c' * 40, {'kind': 'verified-vetted-commit-archive'})
            self.assertEqual(bound['image']['imageId'], image['configDigest'])
            self.assertEqual(bound['image']['buildMaterials'], image['buildMaterials'])
            self.assertEqual(bound['sourceAvailability'], 'not_verified')
            for changes in [{'imageId': 'sha256:' + 'd' * 64}, {'architecture': 'unknown'}]:
                with self.assertRaises(ValueError):
                    evidence.native_review_inputs(value['nativeComponents'], {**image, **changes}, 'c' * 40, {})
            component['receipts'][0]['text'] += 'changed'
            with self.assertRaisesRegex(ValueError, 'byte-exact'):
                evidence.native_review_inputs(value['nativeComponents'], image, 'c' * 40, {})

    def test_missing_notices_are_explicit_and_bad_or_oversized_text_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            modules, package, _ = self.native_fixture(pathlib.Path(directory), '@deepseek-ai/libreoffice-kit-wasm')
            result = self.run_node_inventory(modules)
            self.assertEqual(result.returncode, 0)
            component = json.loads(result.stdout)['nativeComponents'][0]
            self.assertIn('notice', component['missingKinds'])
            self.assertIn('binary-fingerprint', component['missingKinds'])
            for invalid in [b'bad utf8:\xff', b'x' * 1_000_001]:
                (package / 'NOTICE').write_bytes(invalid)
                result = self.run_node_inventory(modules)
                self.assertNotEqual(result.returncode, 0, 'Non-exact/oversized notice cannot be silently truncated')

    def test_native_notice_component_and_total_budgets_fail_without_partial_json(self):
        for budget in ('component', 'total'):
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                names = ['@img/sharp-libvips-linux-x64'] if budget == 'component' else ['@img/sharp-libvips-linux-x64', '@img/sharp-libvips-linux-arm64', '@img/sharp-libvips-linuxmusl-x64', '@img/sharp-libvips-linuxmusl-arm64']
                for name in names:
                    # Build the same nested installed-package layout; the
                    # fixture helper's consumer may already exist.
                    modules = root / 'node_modules'
                    parent = modules / 'consumer'
                    parent.mkdir(parents=True, exist_ok=True)
                    (parent / 'package.json').write_text('{"name":"consumer","version":"1.0.0"}')
                    package = parent / 'node_modules' / name
                    package.mkdir(parents=True)
                    (package / 'package.json').write_text(json.dumps({'name': name, 'version': '1.3.4'}))
                    for notice in (['LICENSE', 'NOTICE', 'COPYING'] if budget == 'component' else ['LICENSE', 'NOTICE']):
                        (package / notice).write_bytes(b'x' * 800_000)
                result = self.run_node_inventory(modules)
                self.assertNotEqual(result.returncode, 0, budget)
                self.assertEqual(result.stdout, '', 'Failed collection must not emit a partial successful evidence document')

    def test_output_limit_prevents_oversized_evidence_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            evidence.write_json(root, "safe.json", {"status": "ok"})
            self.assertEqual(json.loads((root / "safe.json").read_text())["status"], "ok")
            with self.assertRaises(ValueError):
                evidence.write_json(root, "oversized.json", "x" * evidence.LIMIT)
            self.assertFalse((root / "oversized.json").exists())

    def source_fixture(self):
        fixture = archive_fixture.SourceArchiveTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result, path = fixture.archive()
        base = path.name.removesuffix('.tar.gz')
        return fixture, result, path, path.with_name(base + '.files.json'), path.with_name(base + '.sha256')

    def test_archive_verified_before_extraction_preserves_exact_commit_bytes(self):
        fixture, result, path, manifest, checksum = self.source_fixture()
        destination = fixture.root / 'extracted'
        receipt = candidate_source.verify_extract(path, manifest, checksum, fixture.commit, destination)
        self.assertEqual(receipt['commit'], fixture.commit)
        self.assertEqual(receipt['archive']['sha256'], result['sha256'])
        extracted = destination / ('eldhall-source-' + fixture.commit)
        self.assertEqual((extracted / 'apps/api/src/main.ts').read_bytes(), b"export const marker = 'committed';\r\n")
        self.assertEqual((extracted / 'SOURCE-MANIFEST.json').read_bytes(), manifest.read_bytes())
        self.assertFalse((extracted / '.git').exists())
        with self.assertRaisesRegex(ValueError, 'must not exist'):
            candidate_source.verify_extract(path, manifest, checksum, fixture.commit, destination)

    def test_tampered_link_traversal_or_file_checksum_never_extracts(self):
        fixture, _, path, manifest, checksum = self.source_fixture()
        original = path.read_bytes()
        for kind in ('symlink', 'traversal', 'content'):
            path.write_bytes(original)
            with tarfile.open(path, 'r:gz') as source:
                members = [(item, source.extractfile(item).read()) for item in source]
            with tarfile.open(path, 'w:gz') as altered:
                for index, (item, data) in enumerate(members):
                    if kind == 'content' and index == len(members) - 1:
                        data = data[:-1] + (b'X' if data[-1:] != b'X' else b'Y')
                    altered.addfile(item, io.BytesIO(data))
                if kind != 'content':
                    item = tarfile.TarInfo('eldhall-source-' + fixture.commit + '/../escape')
                    if kind == 'symlink':
                        item.type = tarfile.SYMTYPE
                        item.linkname = '/outside'
                    altered.addfile(item)
            checksum.write_text(evidence.hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')
            destination = fixture.root / kind
            with self.assertRaises(ValueError):
                candidate_source.verify_extract(path, manifest, checksum, fixture.commit, destination)
            self.assertFalse(destination.exists())
        self.assertFalse((fixture.root / 'escape').exists())


if __name__ == "__main__":
    unittest.main()
