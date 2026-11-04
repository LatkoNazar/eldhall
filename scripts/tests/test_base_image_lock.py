import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / "base-image-lock.py"
ROOT = SCRIPT.parents[1]
SPEC = importlib.util.spec_from_file_location("base_image_lock", SCRIPT)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class BaseImageLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.lock = policy.load_lock(ROOT / "deploy/base-images.lock.json")
        for name in policy.DOCKERFILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((ROOT / name).read_bytes())
        self.lock_path = self.root / "deploy/base-images.lock.json"
        self.lock_path.parent.mkdir()
        self.lock_path.write_text(json.dumps(self.lock), encoding="utf-8")

    def change_api(self, transform):
        file = self.root / "apps/api/Dockerfile"
        file.write_text(transform((ROOT / "apps/api/Dockerfile").read_text()), encoding="utf-8")

    def test_actual_four_dockerfiles_and_offline_cli_match_the_reviewed_lock(self):
        policy.verify_dockerfiles(self.root, self.lock)
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        output = json.loads(result.stdout)
        self.assertEqual(output["scope"], "offline-reference-policy")
        self.assertEqual(output["upstreamMembership"], "reviewed-metadata-not-refetched")
        self.assertEqual(output["dockerfiles"], len(policy.DOCKERFILES))

    def test_mutable_unknown_wrong_digest_config_and_wrong_role_from_are_refused(self):
        node = self.lock["dockerfiles"]["apps/api/Dockerfile"][0]
        item = next(image for image in self.lock["images"] if image["reference"] == node)
        bad = (
            node.split("@", 1)[0],
            "docker.io/library/unreviewed:1@sha256:" + "f" * 64,
            node[:-1] + ("0" if node[-1] != "0" else "1"),
            node.split("@", 1)[0] + "@" + item["platforms"][0]["configDigest"],
            self.lock["dockerfiles"]["apps/mcp-openapi/Dockerfile"][0],
            "${UNREVIEWED_BASE}",
        )
        for reference in bad:
            with self.subTest(reference=reference):
                self.change_api(lambda source: source.replace(node, reference))
                with self.assertRaises(ValueError):
                    policy.verify_dockerfiles(self.root, self.lock)
        # Tabs are Docker instruction whitespace, not a way around the gate.
        self.change_api(lambda source: source + "\nFROM\tunreviewed:latest\n")
        with self.assertRaises(ValueError):
            policy.verify_dockerfiles(self.root, self.lock)

    def test_external_uv_copy_and_missing_locked_input_cannot_be_hidden_by_stages(self):
        path = self.root / "apps/mcp-openapi/Dockerfile"
        original = path.read_text()
        uv = next(ref for ref in self.lock["dockerfiles"]["apps/mcp-openapi/Dockerfile"] if "astral-sh/uv" in ref)
        for source in (uv.split("@", 1)[0], "unreviewed-stage", "${UV_IMAGE}"):
            path.write_text(original.replace("--from=" + uv, "--from=" + source))
            with self.assertRaises(ValueError):
                policy.verify_dockerfiles(self.root, self.lock)
        path.write_text("\n".join(line for line in original.splitlines() if "--from=" + uv not in line))
        with self.assertRaisesRegex(ValueError, "coverage"):
            policy.verify_dockerfiles(self.root, self.lock)
        lock = copy.deepcopy(self.lock)
        lock["images"] = [image for image in lock["images"] if image["reference"] != uv]
        with self.assertRaises(ValueError):
            policy.validate_lock(lock)

    def test_existing_named_numeric_and_continued_stage_references_remain_valid(self):
        self.change_api(lambda source: source.replace("COPY --from=build", "COPY --from=2"))
        policy.verify_dockerfiles(self.root, self.lock)
        self.change_api(lambda source: source.replace(" AS production", " \\\nAS production"))
        policy.verify_dockerfiles(self.root, self.lock)
        for transform in (
            lambda source: source.replace("COPY --from=build", "COPY --from=production"),
            lambda source: source.replace("COPY --from=build", "COPY --from=99"),
            lambda source: source.replace(" AS production", " AS build"),
        ):
            self.change_api(transform)
            with self.assertRaises(ValueError):
                policy.verify_dockerfiles(self.root, self.lock)

    def test_unsupported_frontends_mounts_onbuild_and_heredocs_fail_closed(self):
        node = self.lock["dockerfiles"]["apps/api/Dockerfile"][0]
        additions = (
            "# syntax=unreviewed/frontend:latest\n",
            "# escape=`\n",
            "RUN --mount=type=bind,from=unreviewed:latest,target=/input true\n",
            "ONBUILD COPY --from=unreviewed:latest /input /output\n",
            "RUN <<EOF\nFROM " + node + " AS fake\nEOF\nCOPY --from=fake /input /output\n",
        )
        for addition in additions:
            with self.subTest(kind=addition.splitlines()[0]):
                self.change_api(lambda source: addition + source)
                with self.assertRaises(ValueError):
                    policy.verify_dockerfiles(self.root, self.lock)

    def test_lock_ambiguity_coverage_descriptors_and_tool_role_drift_are_refused(self):
        mutations = (
            lambda lock: lock.update(lockFormat=True),
            lambda lock: lock.update(unreviewed=True),
            lambda lock: lock["images"].append(copy.deepcopy(lock["images"][0])),
            lambda lock: lock["images"][0]["platforms"].pop(),
            lambda lock: lock["images"][0]["platforms"].__setitem__(1, copy.deepcopy(lock["images"][0]["platforms"][0])),
            lambda lock: lock["images"][0]["platforms"][0].update(configDigest=lock["images"][0]["index"]["digest"]),
            lambda lock: lock["images"][0]["index"].update(size=True),
            lambda lock: lock["images"][0]["index"].update(mediaType="application/vnd.oci.image.manifest.v1+json"),
            lambda lock: lock["dockerfiles"].pop("apps/landing/Dockerfile"),
            lambda lock: lock["dockerfiles"]["apps/api/Dockerfile"].append(lock["dockerfiles"]["apps/api/Dockerfile"][0]),
            lambda lock: lock.update(tools={}),
            lambda lock: lock["tools"].update(buildkit=lock["tools"]["sbomGenerator"]),
        )
        for mutate in mutations:
            lock = copy.deepcopy(self.lock)
            mutate(lock)
            with self.assertRaises(ValueError):
                policy.validate_lock(lock)

    def test_duplicate_json_oversize_and_cli_errors_never_echo_input_or_paths(self):
        for text in ('{"lockFormat":1,' + json.dumps(self.lock)[1:], '{"\\u0069mages":[],' + json.dumps(self.lock)[1:], "[" * 2000 + "0" + "]" * 2000, "synthetic-private-value" * 20_000):
            self.lock_path.write_text(text)
            with self.assertRaises(ValueError):
                policy.load_lock(self.lock_path)
        self.lock_path.write_text(json.dumps(self.lock))
        self.change_api(lambda source: source.replace(self.lock["dockerfiles"]["apps/api/Dockerfile"][0], "synthetic-private-value"))
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("synthetic-private-value", result.stderr)
        self.assertNotIn(str(self.root), result.stderr)


if __name__ == "__main__":
    unittest.main()
