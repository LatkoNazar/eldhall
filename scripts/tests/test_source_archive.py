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
        for name in source_archive.REQUIRED | source_archive.ESSENTIAL_DOCS:
            self.write(name, b"synthetic source\n")
        self.write("apps/api/src/main.ts", b"export const marker = 'committed';\r\n")
        self.write("apps/mcp-openapi/src/support_mcp/server.py", b"print('fixture')\n")
        self.write("apps/api/Dockerfile", b"FROM node:fixture\nCOPY package.json package-lock.json ./\nCOPY src ./src\n")
        self.write("apps/frontend/Dockerfile", b"FROM node:fixture\nCOPY apps/frontend/package.json ./\nCOPY packages/analytics /app/packages/analytics\nCOPY packages/i18n /app/packages/i18n\n")
        self.write("apps/landing/Dockerfile", b"FROM node:fixture\nCOPY apps/landing/package.json ./\nCOPY packages/i18n /app/packages/i18n\n")
        self.write("apps/landing/package.json", b'{"private":true}\n')
        self.write("apps/mcp-openapi/Dockerfile", b"FROM python:fixture\nCOPY pyproject.toml uv.lock ./\nCOPY src ./src\n")
        for name in source_archive.FONT_FILES:
            self.write(name, (SCRIPT.parents[1] / name).read_bytes())
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

    def test_reviewed_fonts_and_full_licence_survive_exact_git_export_without_broad_media_allowance(self):
        self.add_entry("100644", "apps/frontend/public/fonts/google-sans/unreviewed.ttf", b"unknown font")
        self.add_entry("100644", "apps/frontend/public/fonts/elsewhere.woff2", b"unknown font")
        self.add_entry("100644", "apps/frontend/public/fonts/google-sans/unreviewed.json", b"{}")
        _, archive_path = self.archive(self.commit_tree(), name="fonts")
        with tarfile.open(archive_path) as archive:
            prefix = archive.getnames()[0].split("/", 1)[0] + "/"
            for name in source_archive.FONT_FILES:
                self.assertEqual(archive.extractfile(prefix + name).read(), (SCRIPT.parents[1] / name).read_bytes())
            self.assertFalse(any("unreviewed" in name or "elsewhere.woff2" in name for name in archive.getnames()))
        for name in ("demos/reference/youtube/font.ttf", "apps/frontend/private/font.ttf", "apps/frontend/public/unknown.ttf"):
            self.assertIsNotNone(source_archive.exclusion(name, "100644"))
        self.assertEqual(source_archive.exclusion(source_archive.FONT_ROOT + "GoogleSans-Variable.ttf", "120000"), "symlink")

    def test_missing_changed_or_lfs_font_and_licence_fail_archive_closure(self):
        for index, name in enumerate(sorted(source_archive.FONT_FILES)):
            original = self.git("ls-files", "--stage", name).decode().split()[1]
            self.git("update-index", "--force-remove", name)
            with self.assertRaises(ValueError):
                self.archive(self.commit_tree(), name=f"missing-font-{index}")
            self.git("update-index", "--add", "--cacheinfo", f"100644,{original},{name}")
        for index, data in enumerate((b"changed-font", b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"0" * 64 + b"\nsize 10\n")):
            self.add_entry("100644", source_archive.FONT_ROOT + "GoogleSans-Variable.ttf", data)
            with self.assertRaises(ValueError):
                self.archive(self.commit_tree(), name=f"invalid-font-{index}")
        files = {name: (SCRIPT.parents[1] / name).read_bytes() for name in source_archive.FONT_FILES}
        manifest = json.loads(files[source_archive.FONT_ROOT + "manifest.json"])
        manifest["files"][0]["sha256"] = hashlib.sha256(b"changed-font").hexdigest()
        manifest["files"][0]["size"] = len(b"changed-font")
        files[source_archive.FONT_ROOT + "manifest.json"] = json.dumps(manifest).encode()
        files[source_archive.FONT_ROOT + "GoogleSans-Variable.ttf"] = b"changed-font"
        with self.assertRaises(ValueError):
            source_archive.verify_fonts(files)

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

    def test_inspector_demo_is_self_contained_and_refuses_a_missing_fixture(self):
        _, archive_path = self.archive(name="inspector-demo")
        with tarfile.open(archive_path) as archive:
            prefix = "eldhall-source-" + self.commit + "/"
            names = set(archive.getnames())
            for path in ("apps/frontend/scripts/inspector-demo.mjs", "scripts/inspector-demo.mjs", "examples/inspector/scenarios.v1.json", "docs/INSPECTOR_TEMPLATES.md"):
                self.assertIn(prefix + path, names)
        self.git("update-index", "--force-remove", "examples/inspector/scenarios.v1.json")
        with self.assertRaises(ValueError):
            self.archive(self.commit_tree(), name="missing-inspector-demo")

    def test_request_catalog_migration_and_contract_are_retained_and_required(self):
        _, archive_path = self.archive(name="request-catalog")
        prefix = "eldhall-source-" + self.commit + "/"
        with tarfile.open(archive_path) as archive:
            for path in ("apps/api/migrations/0009_customer_requests.sql", "apps/api/src/modules/support/requests/contracts.ts", "docs/REQUEST_CATALOG.md"):
                self.assertIn(prefix + path, archive.getnames())
        self.git("update-index", "--force-remove", "apps/api/migrations/0009_customer_requests.sql")
        with self.assertRaisesRegex(ValueError, "required product build inputs"):
            self.archive(self.commit_tree(), name="missing-request-catalog-migration")
        self.assertFalse((self.root / ".omc/missing-request-catalog-migration").exists())

    def test_managed_import_and_current_schema_evidence_are_required_for_source_closure(self):
        _, archive_path = self.archive(name="managed-import")
        prefix = "eldhall-source-" + self.commit + "/"
        with tarfile.open(archive_path) as archive:
            for path in ("apps/api/migrations/0010_integration_imports.sql", "apps/mcp-openapi/src/support_mcp/managed.py", "schemas/postgres-schema-references.v2.json", "schemas/postgres-schema-references.v2.receipt.json"):
                self.assertIn(prefix + path, archive.getnames())
        self.git("update-index", "--force-remove", "schemas/postgres-schema-references.v2.receipt.json")
        with self.assertRaisesRegex(ValueError, "required product build inputs"):
            self.archive(self.commit_tree(), name="missing-managed-schema-evidence")
        self.assertFalse((self.root / ".omc/missing-managed-schema-evidence").exists())

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

    def test_shared_localization_sources_are_required_and_retained_for_both_browser_builds(self):
        _, path = self.archive()
        prefix = "eldhall-source-" + self.commit + "/"
        with tarfile.open(path) as archive:
            for source in ("packages/i18n/package.json", "packages/i18n/src/core.ts", "apps/landing/Dockerfile"):
                self.assertIn(prefix + source, archive.getnames())
        self.git("update-index", "--force-remove", "packages/i18n/src/core.ts")
        commit = self.commit_tree()
        with self.assertRaisesRegex(ValueError, "required product build inputs"):
            self.archive(commit, name="missing-locale-core")
        self.assertFalse((self.root / ".omc/missing-locale-core").exists())

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

    def test_named_product_guides_are_required_and_internal_guides_remain_excluded(self):
        for name in ("OPENAPI_QUICKSTART.md", "NATIVE_RECEIPTS.md", "RELEASE_STATUS.md", "INSTALLATION_INIT.md", "CLI.md", "SCHEMA_OBSERVATION.md", "customer-database-investigation.md", "provider-neutral-agent-context.md"):
            self.assertIn(name, source_archive.DOCS)
            self.assertIn("docs/" + name, source_archive.ESSENTIAL_DOCS)
            (self.repo / "docs" / name).unlink()
            self.git("add", "--all")
            with self.assertRaisesRegex(ValueError, "essential product documentation"):
                self.archive(self.commit_tree(), name=name)
            self.assertFalse((self.root / ".omc" / name).exists())
            self.write("docs/" + name, b"synthetic source\n")
        for path in ("README.starter.md", "docs/STARTER_DEVELOPMENT.md", "docs/STATUS.md", "docs/integrations.md", "docs/TEAM_PROMPTS.md", "todos/README.md", "demos/README.md", "docs/design-system/references/example.png"):
            self.assertIsNotNone(source_archive.exclusion(path, "100644"))

    def test_documentation_links_close_over_exact_included_targets_without_network_or_code_fakes(self):
        files = {name: b"synthetic source\n" for name in source_archive.ESSENTIAL_DOCS}
        files["apps/api/README.md"] = b"# Package\n"
        files["schemas/config.json"] = b"{}\n"
        files["README.md"] = b"""# Product
[guide](docs/API_CONTRACTS.md#heading-not-checked "Guide")
[directory](apps/api/)
[same](#this-heading-is-deliberately-not-validated)
[external](https://unreachable.example.invalid/missing)
[mail](mailto:nobody@example.invalid)
[phone](tel:+100000000)
[protocol-relative](//unreachable.example.invalid/missing)
`[inline fake](missing.md)`
``[fake](also-missing.md)``
```markdown
[fenced fake](excluded.md)
```
~~~html
<img src="excluded.png">
~~~
<!-- [comment fake](excluded.md) -->
"""
        files["docs/API_CONTRACTS.md"] = b"""[read][API]
![read][api]
[API]: <../README.md> "Product"
[api][]
<a href="CLI.md#not-checked">CLI</a><img src="../schemas/config.json">
[encoded](%43LI.md?view=local#not-checked)
[root directory](../)
"""
        source_archive.verify_documentation(files)

    def test_missing_excluded_ambiguous_and_unsafe_documentation_targets_are_refused(self):
        files = {name: b"synthetic source\n" for name in source_archive.ESSENTIAL_DOCS}
        cases = (
            "[missing](missing.md)", "[excluded](STATUS.md)", "[case](cli.md)",
            "[escape](../../README.md)", "[encoded escape](%2e%2e/%2e%2e/README.md)",
            "[absolute](/README.md)", "[encoded absolute](%2fREADME.md)",
            "[backslash](..%5cREADME.md)", "[nul](CLI.md%00)", "[control](CLI.md%0a)",
            "[drive](C:/README.md)", "[scheme](file:///README.md)", "[scheme](javascript:alert)",
            "[no index](../apps/api/)", "[file as directory](CLI.md/)", "[file as directory](CLI.md/.)", "[file as directory](CLI.md/%2e)", "[missing][undefined]", "[missing][]",
            "[ref]: missing.md", "[ref]: CLI.md\n[ref]: API_CONTRACTS.md",
            "![image](excluded.png)", '<img src="excluded.png">', '<a href="missing.md">link</a>',
            "[unsupported](<broken target)",
        )
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                source_archive.verify_documentation({**files, "docs/API_CONTRACTS.md": case.encode()})

    def test_missing_documentation_target_fails_before_any_archive_output_or_automatic_inclusion(self):
        self.write("README.md", b"[not exported](docs/STATUS.md)\n")
        self.write("docs/STATUS.md", b"internal historical material stays private\n")
        self.git("add", "--all")
        with self.assertRaisesRegex(ValueError, "missing or excluded"):
            self.archive(self.commit_tree())
        self.assertFalse((self.root / ".omc/out").exists())
        self.assertEqual((self.repo / "docs/STATUS.md").read_bytes(), b"internal historical material stays private\n")

    def test_exact_ignore_file_is_shipped_but_forced_private_installation_outputs_are_excluded(self):
        ignore = SCRIPT.parents[1].joinpath(".gitignore").read_bytes()
        self.write(".gitignore", ignore)
        private = ("support.env", "support.json", "installation.json", "apps/api/config/support.env", "apps/api/config/support.json", "apps/api/config/installation.json", "apps/api/.runtime/state.json")
        ignored = self.git("check-ignore", "--stdin", data=("\n".join(private) + "\n").encode()).decode().splitlines()
        self.assertEqual(ignored, list(private))
        for name in private:
            self.write(name, b"synthetic-private-installation-value\n")
        self.write("examples/support.config.json", b"{}\n")
        self.write("examples/support.qdrant.config.json", b"{}\n")
        self.git("add", "--force", "--all")
        commit = self.commit_tree()
        _, path = self.archive(commit)
        with tarfile.open(path) as archive:
            prefix = "eldhall-source-" + commit + "/"
            self.assertEqual(archive.extractfile(prefix + ".gitignore").read(), ignore)
            for name in private:
                self.assertNotIn(prefix + name, archive.getnames())
            for name in ("examples/support.config.json", "examples/support.qdrant.config.json"):
                self.assertIn(prefix + name, archive.getnames())


if __name__ == "__main__":
    unittest.main()
