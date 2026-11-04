import gzip
import importlib.util
import io
import json
from contextlib import redirect_stderr
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / "candidate-image-oci.py"
SPEC = importlib.util.spec_from_file_location("candidate_oci", SCRIPT)
oci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oci)


class CandidateOciTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)

    def fixture(self, *, arch="amd64", encoding="legacy", layer_type="gzip", bad_diff=False,
                bad_subject=False, missing=None, duplicate=False, material=None, extra_platform=False,
                material_uri="pkg:docker/node@fixture?platform=linux%2Famd64"):
        blobs = {}

        def blob(value, media):
            data = value if isinstance(value, bytes) else json.dumps(value, separators=(",", ":")).encode()
            identity = oci.sha(data)
            blobs["blobs/sha256/" + identity[7:]] = data
            return {"mediaType": media, "digest": identity, "size": len(data)}

        raw = b"synthetic layer bytes\x00" * 100
        layer = blob(gzip.compress(raw, mtime=0) if layer_type == "gzip" else raw,
                     oci.LAYER + ("+gzip" if layer_type == "gzip" else ""))
        config = blob({"architecture": arch, "os": "linux", "rootfs": {"type": "layers", "diff_ids": [oci.sha(b"wrong" if bad_diff else raw)]}, "config": {"Env": ["NEVER_RETAIN_RAW_CONFIG=synthetic"]}}, oci.CONFIG)
        runtime = blob({"schemaVersion": 2, "mediaType": oci.MANIFEST, "config": config, "layers": [layer]}, oci.MANIFEST)
        runtime["platform"] = {"architecture": arch, "os": "linux"}
        base = "sha256:" + "b" * 64
        ref = "docker.io/library/node:fixture@" + base
        lock = {"images": [{"repository": "docker.io/library/node", "tag": "fixture", "reference": ref, "index": {"digest": base}, "platforms": [{"platform": "linux/amd64", "manifestDigest": "sha256:" + "c" * 64}]}], "dockerfiles": {"apps/api/Dockerfile": [ref]}, "tools": {"buildkit": "pinned-builder", "sbomGenerator": "pinned-scanner"}}
        statements = []
        for kind in [oci.SPDX, oci.SLSA] + ([oci.SPDX] if duplicate else []):
            if kind == missing:
                continue
            predicate = {"spdxVersion": "SPDX-2.3", "packages": [{"name": "synthetic"}]} if kind == oci.SPDX else {"buildType": "https://mobyproject.org/buildkit@v1", "materials": [{"uri": material_uri, "digest": {"sha256": (material or base)[7:]}}]}
            statement = blob({"_type": "https://in-toto.io/Statement/v0.1", "subject": [{"name": "synthetic", "digest": {"sha256": (oci.sha(b"another image") if bad_subject else runtime["digest"])[7:]}}], "predicateType": kind, "predicate": predicate}, oci.INTOTO)
            statement["annotations"] = {"in-toto.io/predicate-type": kind}
            statements.append(statement)
        att = {"schemaVersion": 2, "mediaType": oci.MANIFEST, "config": blob({"architecture": "unknown", "os": "unknown", "rootfs": {"type": "layers", "diff_ids": []}}, oci.CONFIG), "layers": statements}
        if encoding == "artifact":
            att.update({"artifactType": "application/vnd.docker.attestation.manifest.v1+json", "subject": runtime})
        ad = blob(att, oci.MANIFEST)
        ad["platform"] = {"architecture": "unknown", "os": "unknown"}
        ad["annotations"] = {"vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": runtime["digest"]}
        descriptors = [runtime, ad]
        if extra_platform:
            descriptors.append({**runtime, "platform": {"architecture": "arm64", "os": "linux"}})
        index = blob({"schemaVersion": 2, "mediaType": oci.INDEX, "manifests": descriptors}, oci.INDEX)
        files = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": json.dumps({"schemaVersion": 2, "mediaType": oci.INDEX, "manifests": [index]}).encode(), **blobs}
        archive = self.root / "candidate.tar"
        self.write_tar(archive, files)
        metadata = {"containerimage.config.digest": config["digest"], "containerimage.digest": index["digest"]}
        source = {"commit": "a" * 40, "verifiedRegularMembers": True, "archive": {"sha256": "d" * 64}}
        return archive, metadata, source, lock, files

    def write_tar(self, path, files, extra=None):
        with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)

    def verify(self, fixture):
        return oci.verify_archive(fixture[0], "amd64", fixture[1], fixture[2], fixture[3], "apps/api/Dockerfile")

    def test_exact_graph_subjects_layers_and_unsigned_summaries(self):
        result = self.verify(self.fixture())
        self.assertEqual(result["platform"], "linux/amd64")
        self.assertEqual({item["predicateType"] for item in result["attestations"]}, {oci.SPDX, oci.SLSA})
        self.assertTrue(all(item["subjectDigest"] == result["platformManifestDigest"] and item["signed"] is False for item in result["attestations"]))
        self.assertEqual(result["source"]["binding"], "runner-verified-source-input-not-provenance-git-claim")
        self.assertNotIn("NEVER_RETAIN_RAW_CONFIG", json.dumps(result))
        self.assertNotEqual(result["layoutEntrypointDigest"], result["imageIndexDigest"])

    def test_attested_export_may_omit_reported_config_but_not_index_or_contradict_config(self):
        fixture = self.fixture()
        expected = fixture[1].pop("containerimage.config.digest")
        self.assertEqual(self.verify(fixture)["configDigest"], expected)
        fixture[1]["containerimage.config.digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "Buildx"):
            self.verify(fixture)
        fixture[1].pop("containerimage.config.digest")
        fixture[1].pop("containerimage.digest")
        with self.assertRaisesRegex(ValueError, "Buildx"):
            self.verify(fixture)

    def test_raw_layers_are_verified_without_extracting_layer_files(self):
        result = self.verify(self.fixture(layer_type="raw"))
        self.assertEqual(result["runtimeLayerCount"], 1)
        self.assertEqual(set(path.name for path in self.root.iterdir()), {"candidate.tar"})

    def test_statement_retention_is_exact_and_only_after_entire_graph_validates(self):
        fixture = self.fixture()
        statements = {}
        receipt = oci.verify_archive(fixture[0], "amd64", fixture[1], fixture[2], fixture[3], "apps/api/Dockerfile", statements)
        self.assertEqual(set(statements), {"sbom", "provenance"})
        for kind, data in statements.items():
            record = next(item for item in receipt["attestations"] if item["predicateType"] == (oci.SPDX if kind == "sbom" else oci.SLSA))
            self.assertEqual(oci.sha(data), record["statementDigest"])
            self.assertEqual(data, fixture[4]["blobs/sha256/" + record["statementDigest"][7:]])
        fixture[1]["containerimage.digest"] = "sha256:" + "f" * 64
        failed = {}
        with self.assertRaises(ValueError):
            oci.verify_archive(fixture[0], "amd64", fixture[1], fixture[2], fixture[3], "apps/api/Dockerfile", failed)
        self.assertEqual(failed, {})

    def test_material_digest_does_not_authorize_wrong_repository_tag_or_platform(self):
        for uri in ["pkg:docker/attacker@fixture?platform=linux%2Famd64", "pkg:docker/node@different?platform=linux%2Famd64", "pkg:docker/node@fixture?platform=linux%2Farm64", "pkg:docker/node@fixture", "pkg:docker/node@fixture?platform=linux%2Famd64&platform=linux%2Farm64"]:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                self.verify(self.fixture(material_uri=uri))
        for uri in ["pkg:docker/library/node@fixture?platform=linux%2Famd64", "pkg:docker/docker.io/library/node@fixture?platform=linux%2Famd64", "pkg:docker/node@sha256%3A" + "b" * 64 + "?platform=linux%2Famd64"]:
            self.verify(self.fixture(material_uri=uri))

    def test_pinned_buildkit_digest_only_purl_has_no_version_but_keeps_reviewed_identity(self):
        # Exact RefToPURL shape in the pinned builder's util/purl/image_test.go:
        # canonical `name@digest` -> `pkg:docker/name?digest=...&platform=...`.
        approved = "sha256:" + "b" * 64
        valid = "pkg:docker/node?digest=" + approved + "&platform=linux%2Famd64"
        self.verify(self.fixture(material_uri=valid))
        for uri in [
            "pkg:docker/node?platform=linux%2Famd64",
            "pkg:docker/node@?digest=" + approved + "&platform=linux%2Famd64",
            valid.replace("node?", "attacker?"),
            valid.replace(approved, "sha256:" + "f" * 64),
            valid.replace("amd64", "arm64"),
            valid + "&digest=" + approved,
            valid + "&platform=linux%2Famd64",
            valid + "&unknown=value",
            valid + "&tag=fixture",
        ]:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                self.verify(self.fixture(material_uri=uri))

    def test_semantic_mismatches_fail_closed(self):
        for options in [{"arch": "arm64"}, {"encoding": "artifact"}, {"bad_diff": True}, {"bad_subject": True}, {"missing": oci.SPDX}, {"duplicate": True}, {"material": "sha256:" + "e" * 64}, {"extra_platform": True}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.verify(self.fixture(**options))

    def test_blob_corruption_size_and_unreferenced_payloads_refuse(self):
        fixture = self.fixture()
        files = fixture[4]
        name = next(name for name in files if name.startswith("blobs/"))
        original = files[name]
        files[name] = b"modified blob"
        self.write_tar(fixture[0], files)
        with self.assertRaisesRegex(ValueError, "digest"):
            self.verify(fixture)
        files[name] = original
        files["blobs/sha256/" + oci.sha(b"unreferenced")[7:]] = b"unreferenced"
        self.write_tar(fixture[0], files)
        with self.assertRaisesRegex(ValueError, "unreferenced"):
            self.verify(fixture)

    def test_unsafe_paths_links_duplicate_members_and_duplicate_json_refuse(self):
        fixture = self.fixture()
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("index.json", tarfile.REGTYPE)]:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "/outside"
            self.write_tar(fixture[0], fixture[4], member)
            with self.assertRaises(ValueError):
                self.verify(fixture)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            oci.parse(b'{"schemaVersion":2,"schemaVersion":2}')
        self.assertFalse((self.root.parent / "escape").exists())

    def test_expansion_bound_and_metadata_identity_refuse(self):
        fixture = self.fixture()
        with patch.object(oci, "MAX_EXPANDED_LAYER", 10), self.assertRaisesRegex(ValueError, "Expanded"):
            self.verify(fixture)

        fixture[1]["containerimage.digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "Buildx"):
            self.verify(fixture)

    def test_size_descriptor_and_json_bounds_refuse(self):
        fixture = self.fixture()
        files = fixture[4]
        entry = json.loads(files["index.json"])
        entry["manifests"][0]["size"] += 1
        files["index.json"] = json.dumps(entry).encode()
        self.write_tar(fixture[0], files)
        with self.assertRaisesRegex(ValueError, "size"):
            self.verify(fixture)
        with patch.object(oci, "MAX_JSON", 10), self.assertRaises(ValueError):
            oci.parse(b'{"too-large":"' + b"x" * 20 + b'"}')

    def test_bounded_regular_json_reader_deep_json_and_nonzero_tar_tail_refuse(self):
        path = self.root / "input.json"
        path.write_bytes(b"[" * 100 + b"0" + b"]" * 100)
        with self.assertRaisesRegex(ValueError, "bounds"):
            oci.read_json(path)
        path.write_bytes(b"x" * 11)
        with patch.object(oci, "MAX_JSON", 10), self.assertRaisesRegex(ValueError, "bounded"):
            oci.read_json(path)
        fixture = self.fixture()
        with fixture[0].open("ab") as stream:
            stream.write(b"not another archive")
        with self.assertRaisesRegex(ValueError, "trailing"):
            self.verify(fixture)

    def inspection(self, receipt, identity):
        return {"Id": identity, "Os": "linux", "Architecture": "amd64", "RootFS": {"Type": "layers", "Layers": receipt["diffIds"]}, "Descriptor": {"mediaType": oci.INDEX, "digest": receipt["imageIndexDigest"]}}

    def test_runtime_id_is_classified_not_assumed_to_be_config(self):
        receipt = self.verify(self.fixture())
        for field, kind in [("imageIndexDigest", "image-index"), ("platformManifestDigest", "platform-manifest"), ("configDigest", "config")]:
            result = oci.runtime_binding(receipt, self.inspection(receipt, receipt[field]))
            self.assertEqual(result["runtimeIdKind"], kind)
        for mutate in [lambda v: v.update(Id="sha256:" + "e" * 64), lambda v: v.update(Architecture="arm64"), lambda v: v["RootFS"].update(Layers=[]), lambda v: v["Descriptor"].update(digest=receipt["attestations"][0]["manifestDigest"])]:
            value = self.inspection(receipt, receipt["imageIndexDigest"])
            mutate(value)
            with self.assertRaises(ValueError):
                oci.runtime_binding(receipt, value)
        value = self.inspection(receipt, receipt["imageIndexDigest"])
        value["Descriptor"] = {"digest": receipt["configDigest"], "mediaType": oci.INDEX}
        with self.assertRaises(ValueError):
            oci.runtime_binding(receipt, value)

    def test_exact_verified_archive_is_loaded_once_and_container_binding_checked(self):
        fixture = self.fixture()
        receipt = self.verify(fixture)
        inspection = self.inspection(receipt, receipt["imageIndexDigest"])
        outputs = [b"loaded", json.dumps([inspection]).encode(), ("c" * 64).encode(), json.dumps([{"Image": receipt["configDigest"], "Config": {"Image": receipt["imageIndexDigest"]}}]).encode(), b"removed"]
        with patch.object(oci, "command", side_effect=outputs) as command:
            result = oci.load_verified(fixture[0], "eldhall-server:candidate", receipt)
        self.assertTrue(result["probeContainerImageBound"])
        self.assertEqual(command.call_args_list[0].args[0], ["docker", "load", "--input", str(fixture[0])])
        self.assertFalse(any("build" in call.args[0] for call in command.call_args_list))
        self.assertIn("--platform", command.call_args_list[2].args[0])
        outputs[3] = json.dumps([{"Image": receipt["attestations"][0]["manifestDigest"]}]).encode()
        with patch.object(oci, "command", side_effect=outputs) as command, self.assertRaisesRegex(ValueError, "outside"):
            oci.load_verified(fixture[0], "eldhall-server:candidate", receipt)
        self.assertEqual(command.call_args_list[-1].args[0], ["docker", "rm", "c" * 64])

    def test_offline_init_runs_exact_image_and_verifies_actual_container_before_removal(self):
        receipt = self.verify(self.fixture())
        receipt.update({"runtimeImageId": receipt["imageIndexDigest"], "probeContainerImageBound": True})
        proof = {"valid": True, "proof": "offline-image-init", "state": "prepared", "releaseBinding": "unbound", "privateModes": True, "replayUnchanged": True}
        inspected = [{"Image": receipt["configDigest"], "Config": {"Image": receipt["runtimeImageId"]}, "State": {"Status": "exited", "ExitCode": 0}}]
        outputs = [json.dumps(proof).encode(), json.dumps(inspected).encode(), b"removed"]
        with patch.object(oci, "command", side_effect=outputs) as command:
            actual = oci.run_offline_init(receipt, b"fixed synthetic helper")
        self.assertEqual(actual["ociRuntimeBinding"]["imageId"], receipt["configDigest"])
        args = command.call_args_list[0].args[0]
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertIn("--read-only", args)
        self.assertIn(receipt["runtimeImageId"], args)
        self.assertEqual(command.call_args_list[0].kwargs["source"], b"fixed synthetic helper")
        self.assertEqual(command.call_args_list[-1].args[0][:3], ["docker", "rm", "--force"])
        inspected[0]["Config"]["Image"] = "mutable:candidate"
        outputs[1] = json.dumps(inspected).encode()
        with patch.object(oci, "command", side_effect=outputs), self.assertRaisesRegex(ValueError, "outside"):
            oci.run_offline_init(receipt, b"fixed synthetic helper")

    def test_command_errors_are_sanitized(self):
        with patch.object(oci.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"PRIVATE_RAW_CONFIG")):
            with self.assertRaises(ValueError) as caught:
                oci.command(["docker", "load"])
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_cli_malformed_archive_never_loads_or_writes_partial_receipts(self):
        fixture = self.fixture(bad_subject=True)
        arguments = [str(SCRIPT), "verify", "--archive", str(fixture[0]), "--arch", "amd64", "--role", "server"]
        for name, value in [("metadata", fixture[1]), ("source-receipt", fixture[2]), ("lock", fixture[3])]:
            path = self.root / (name + ".json")
            path.write_text(json.dumps(value))
            arguments.extend(["--" + name, str(path)])
        destination = self.root / "not-created" / "server-oci.json"
        arguments.extend(["--output", str(destination)])
        stderr = io.StringIO()
        with patch.object(oci.sys, "argv", arguments), patch.object(oci, "command") as command, redirect_stderr(stderr):
            self.assertEqual(oci.main(), 1)
        command.assert_not_called()
        self.assertFalse(destination.parent.exists())
        self.assertNotIn(str(self.root), stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())
        self.assertIn("code=OCI034 phase=attestations", stderr.getvalue())
        for error in (ValueError("PRIVATE exception /secret/path"), OSError("PRIVATE exception /secret/path"), oci.VerificationFailure("PRIVATE exception /secret/path")):
            stderr = io.StringIO()
            with patch.object(oci.sys, "argv", arguments), patch.object(oci, "verify_archive", side_effect=error), patch.object(oci, "command") as command, redirect_stderr(stderr):
                self.assertEqual(oci.main(), 1)
            command.assert_not_called()
            self.assertIn("code=OCI000 phase=inputs", stderr.getvalue())
            self.assertNotIn("PRIVATE", stderr.getvalue())
            self.assertNotIn("secret", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())
            self.assertFalse(destination.parent.exists())


if __name__ == "__main__":
    unittest.main()
