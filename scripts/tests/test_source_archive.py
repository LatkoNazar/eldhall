import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / "source-archive.py"
SPEC = importlib.util.spec_from_file_location("source_archive", SCRIPT)
source_archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_archive)


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "--quiet")
        self.git("config", "core.autocrlf", "false")
        for name in source_archive.REQUIRED:
            self.write(name, b"synthetic source\n")
        self.write("apps/api/src/main.ts", b"export const marker = 'committed';\r\n")
        self.write("apps/mcp-openapi/src/support_mcp/server.py", b"print('fixture')\n")
        self.write("apps/api/Dockerfile", b"FROM node:fixture\nCOPY package.json package-lock.json ./\nCOPY src ./src\n")
        self.write("apps/frontend/Dockerfile", b"FROM node:fixture\nCOPY apps/frontend/package.json ./\nCOPY packages/analytics /app/packages/analytics\n")
        self.write("apps/mcp-openapi/Dockerfile", b"FROM python:fixture\nCOPY pyproject.toml uv.lock ./\nCOPY src ./src\n")
        self.git("add", "--force", "--all")
        self.commit = self.commit_tree()

    def git(self, *args, data=None):
        return subprocess.run(["git", "-C", str(self.repo), *args], input=data, capture_output=True, check=True).stdout

    def write(self, name, data):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def commit_tree(self):
        tree = self.git("write-tree").decode().strip()
        return self.git("-c", "user.name=Archive Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-m", "archive fixture").decode().strip()

    def add_entry(self, mode, path, content):
        oid = self.git("hash-object", "-w", "--stdin", data=content).decode().strip()
        self.git("update-index", "--add", "--cacheinfo", f"{mode},{oid},{path}")

    def archive(self, commit=None, name="out"):
        directory = self.root / ".omc" / name
        result = source_archive.prepare(self.repo, commit or self.commit, directory)
        return result, directory / result["archive"]

    def test_exact_git_commit_ignores_worktree_untracked_files_and_clock(self):
        first, path = self.archive(name="first")
        original = path.read_bytes()
        self.write("apps/api/src/main.ts", b"uncommitted secret must not replace committed bytes\n")
        self.write("apps/api/src/untracked.ts", b"untracked private content\n")
        second, repeated = self.archive(name="second")
        self.assertEqual(first, second)
        self.assertEqual(original, repeated.read_bytes())
        with tarfile.open(path) as archive:
            prefix = "eldhall-source-" + self.commit + "/"
            self.assertEqual(archive.extractfile(prefix + "apps/api/src/main.ts").read(), b"export const marker = 'committed';\r\n")
            self.assertNotIn(prefix + "apps/api/src/untracked.ts", archive.getnames())
            for member in archive.getmembers():
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.mtime, member.uname, member.gname), (0, 0, 0, "", ""))
        self.assertEqual(first["sha256"], hashlib.sha256(original).hexdigest())
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_private_media_links_submodules_and_lfs_never_enter_snapshot(self):
        excluded = {
            "apps/api/.env": b"password=private-test-value\n",
            "apps/api/private/customer.json": b"private-test-value",
            "apps/frontend/src/user-reference.png": b"private user media",
            "apps/api/src/space name.ts": b"unsafe source path",
            ".omc/history/session.json": b"private conversation",
            "docs/design-system/references/screen.png": b"user reference",
        }
        for name, content in excluded.items():
            self.write(name, content)
        self.git("add", "--force", "--all")
        self.add_entry("120000", "apps/api/src/linked.ts", b"../../../../private")
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.commit},apps/api/src/vendor")
        self.add_entry("100644", "apps/api/src/large.ts", b"version https://git-lfs.github.com/spec/v1\noid sha256:synthetic\nsize 10\n")
        commit = self.commit_tree()
        result, path = self.archive(commit)
        with tarfile.open(path) as archive:
            names = archive.getnames()
            self.assertFalse(any(any(part in name for part in (".env", "customer.json", ".png", "space name", ".omc", "linked.ts", "/vendor", "large.ts")) for name in names))
            manifest = json.loads(archive.extractfile(f"eldhall-source-{commit}/SOURCE-MANIFEST.json").read())
            self.assertNotIn("private-test-value", json.dumps(manifest))
            self.assertNotIn("customer.json", json.dumps(manifest))
        for key in ("symlink", "submodule", "lfs-pointer", "unsafe-path", "private-or-generated-path", "non-source-or-media"):
            self.assertGreater(result["excludedCounts"][key], 0)
        for name, data in excluded.items():
            self.assertEqual((self.repo / name).read_bytes(), data)

    def test_file_manifest_hashes_match_archive_and_executable_mode(self):
        self.add_entry("100755", "scripts/executable.sh", b"#!/bin/sh\nexit 0\n")
        commit = self.commit_tree()
        result, path = self.archive(commit)
        prefix = "eldhall-source-" + commit + "/"
        with tarfile.open(path) as archive:
            raw = archive.extractfile(prefix + "SOURCE-MANIFEST.json").read()
            manifest = json.loads(raw)
            self.assertEqual(raw, path.with_name(path.name.removesuffix(".tar.gz") + ".files.json").read_bytes())
            self.assertNotIn("SOURCE-MANIFEST.json", [entry["path"] for entry in manifest["files"]])
            self.assertEqual(len(archive.getmembers()), len(manifest["files"]) + 1)
            for entry in manifest["files"]:
                content = archive.extractfile(prefix + entry["path"]).read()
                self.assertEqual(entry["sha256"], hashlib.sha256(content).hexdigest())
                self.assertEqual(entry["size"], len(content))
            self.assertEqual(archive.getmember(prefix + "scripts/executable.sh").mode, 0o755)
        checksum = path.with_name(path.name.removesuffix(".tar.gz") + ".sha256").read_text()
        self.assertEqual(checksum, result["sha256"] + "  " + path.name + "\n")

    def test_missing_docker_copy_input_refuses_without_partial_output(self):
        self.write("apps/api/Dockerfile", b"FROM node:fixture\nCOPY nonexistent.js ./\n")
        self.git("add", "--all")
        commit = self.commit_tree()
        with self.assertRaisesRegex(ValueError, "Docker COPY input"):
            self.archive(commit)
        self.assertFalse((self.root / ".omc/out").exists())

    def test_private_key_marker_and_ambiguous_revision_are_refused(self):
        self.write("apps/api/src/key.txt", b"-----BEGIN " + b"PRIVATE KEY-----\nsynthetic\n")
        self.git("add", "--all")
        commit = self.commit_tree()
        with self.assertRaisesRegex(ValueError, "Private key marker"):
            self.archive(commit)
        with self.assertRaisesRegex(ValueError, "exact full"):
            self.archive("HEAD")

    def test_existing_artifacts_are_not_overwritten(self):
        _, path = self.archive()
        data = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "overwrite"):
            self.archive()
        self.assertEqual(path.read_bytes(), data)

    def test_unsafe_relative_paths_are_excluded(self):
        for path in ("../escape.ts", "/absolute.ts", "apps/api/./source.ts", "apps/api//source.ts", "apps/api/back\\slash.ts", "apps/api/NUL.ts", "apps/api/source."):
            self.assertEqual(source_archive.exclusion(path, "100644"), "unsafe-path")

    def test_reserved_internal_manifest_cannot_be_replaced_by_tracked_content(self):
        self.write("SOURCE-MANIFEST.json", b'{"untrusted":"tracked copy"}\n')
        self.git("add", "--all")
        with self.assertRaisesRegex(ValueError, "Reserved generated manifest"):
            self.archive(self.commit_tree())


if __name__ == "__main__":
    unittest.main()
