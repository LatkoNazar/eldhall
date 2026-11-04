#!/usr/bin/env python3
"""Prepare a private vetted Git-object source snapshot; never publishes or reads env files."""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
from html.parser import HTMLParser
import io
import json
import os
import pathlib
import posixpath
import re
import shlex
import subprocess
import sys
import tarfile
from urllib.parse import unquote, urlsplit

POLICY = "eldhall-source-v1"
ROOTS = ("apps/api/", "apps/frontend/", "apps/landing/", "apps/mcp-openapi/", "packages/analytics/", "schemas/", "deploy/", "examples/orders/", "scripts/")
ROOT_FILES = {"LICENSE", "NOTICE", "README.md", ".dockerignore", ".gitattributes", ".gitignore", ".env.example"}
DOCS = {"API_CONTRACTS.md", "ARCHITECTURE.md", "CLI.md", "distribution-contract.md", "EXTERNAL_DATA.md", "implementation.md", "INSTALLATION_INIT.md", "insights.md", "integrations-manifest.md", "integrations-runtime.md", "KNOWLEDGE_BASE.md", "LICENSING.md", "NATIVE_RECEIPTS.md", "PRIVATE_OCI.md", "OPENAPI_QUICKSTART.md", "openrouter.md", "RELEASE_STATUS.md", "SCHEMA_OBSERVATION.md", "THIRD_PARTY_NOTICES.md"}
ESSENTIAL_DOCS = {"README.md", *("docs/" + name for name in DOCS)}
EXTENSIONS = {".ts", ".tsx", ".js", ".mjs", ".json", ".py", ".toml", ".lock", ".md", ".txt", ".yaml", ".yml", ".sql", ".css", ".html", ".sh"}
DENIED_PARTS = {".git", ".omc", ".runtime", ".agents", ".codex", ".venv", ".ssh", ".aws", ".kube", "node_modules", "dist", "coverage", "__pycache__", ".pytest_cache", ".ruff_cache", ".deploy", "backups", "private", "secret", "secrets", "credentials", "qa-evidence", "demos", "deliverables"}
INSTALLATION_OUTPUTS = {"support.env", "support.json", "installation.json"}
SPECIAL = {"Dockerfile", "Caddyfile", "LICENSE", "NOTICE", ".dockerignore"}
MAX_FILE = 8_000_000
MAX_TOTAL = 64_000_000
BUILD_CONTEXTS = (("apps/api/Dockerfile", "apps/api"), ("apps/frontend/Dockerfile", ""), ("apps/mcp-openapi/Dockerfile", "apps/mcp-openapi"))
REQUIRED = {"deploy/base-images.lock.json", "LICENSE", "NOTICE", ".dockerignore", ".gitignore", "apps/api/package.json", "apps/api/package-lock.json", "apps/api/tsconfig.json", "apps/api/tsconfig.build.json", "apps/frontend/package.json", "apps/frontend/package-lock.json", "apps/frontend/index.html", "apps/mcp-openapi/pyproject.toml", "apps/mcp-openapi/uv.lock", "packages/analytics/package.json", "docs/LICENSING.md", "docs/THIRD_PARTY_NOTICES.md", *(entry[0] for entry in BUILD_CONTEXTS)}


def git(repo: pathlib.Path, *args: str, source: bytes | None = None) -> bytes:
    environment = {**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
    result = subprocess.run(["git", "--no-replace-objects", "-c", "protocol.allow=never", "-C", str(repo), *args], input=source, env=environment, capture_output=True, timeout=60, check=False)
    if result.returncode:
        raise ValueError("Git object operation failed")
    return result.stdout


def exclusion(path: str, mode: str) -> str | None:
    if not re.fullmatch(r"[A-Za-z0-9_.@+/-]+", path) or path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/")):
        return "unsafe-path"
    if mode == "120000":
        return "symlink"
    if mode == "160000":
        return "submodule"
    if mode not in ("100644", "100755"):
        return "unsupported-mode"
    parts = path.split("/")
    if any(part.endswith(".") or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.I) for part in parts):
        return "unsafe-path"
    if parts[-1].lower() in INSTALLATION_OUTPUTS or any(part.lower() in DENIED_PARTS for part in parts) or pathlib.PurePosixPath(path).stem.lower() in DENIED_PARTS or any(part.lower().startswith(".env") for part in parts) and path != ".env.example":
        return "private-or-generated-path"
    allowed = path in ROOT_FILES or path.startswith(ROOTS) or path.startswith("docs/") and path.removeprefix("docs/") in DOCS or path in ("examples/support.config.json", "examples/support.qdrant.config.json")
    if not allowed:
        return "outside-vetted-roots"
    if path in ROOT_FILES or pathlib.PurePosixPath(path).name in SPECIAL or pathlib.PurePosixPath(path).suffix in EXTENSIONS:
        return None
    return "non-source-or-media"


def tracked(repo: pathlib.Path, commit: str) -> tuple[list[dict], collections.Counter]:
    entries = []
    excluded = collections.Counter()
    for record in git(repo, "ls-tree", "-r", "-l", "-z", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid, raw_size = metadata.decode("ascii").split()
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError:
            excluded["unsafe-path"] += 1
            continue
        if path == "SOURCE-MANIFEST.json":
            raise ValueError("Reserved generated manifest path is tracked")
        reason = exclusion(path, mode)
        if reason:
            excluded[reason] += 1
            continue
        size = int(raw_size)
        if kind != "blob" or size > MAX_FILE:
            raise ValueError("Vetted source blob is oversized or invalid")
        entries.append({"path": path, "mode": mode, "gitBlob": oid, "size": size})
    if not entries or len(entries) > 10000 or sum(entry["size"] for entry in entries) > MAX_TOTAL:
        raise ValueError("Source snapshot exceeds its file/byte bound or is empty")
    paths = [entry["path"].casefold() for entry in entries]
    if len(set(paths)) != len(paths):
        raise ValueError("Source paths collide on case-insensitive filesystems")
    return sorted(entries, key=lambda entry: entry["path"]), excluded


def blobs(repo: pathlib.Path, entries: list[dict]) -> dict[str, bytes]:
    data = git(repo, "cat-file", "--batch", source="".join(entry["gitBlob"] + "\n" for entry in entries).encode("ascii"))
    offset = 0
    result = {}
    for entry in entries:
        end = data.index(b"\n", offset)
        header = data[offset:end].decode("ascii").split()
        if header != [entry["gitBlob"], "blob", str(entry["size"])]:
            raise ValueError("Git blob receipt does not match its tree entry")
        start = end + 1
        value = data[start:start + entry["size"]]
        if len(value) != entry["size"] or data[start + entry["size"]:start + entry["size"] + 1] != b"\n":
            raise ValueError("Git blob output is incomplete")
        result[entry["path"]] = value
        offset = start + entry["size"] + 1
    if offset != len(data):
        raise ValueError("Git blob output has unexpected trailing data")
    return result


def verify_build_tree(files: dict[str, bytes]) -> None:
    if not REQUIRED.issubset(files):
        raise ValueError("Snapshot lacks required product build inputs")
    for dockerfile, context in BUILD_CONTEXTS:
        for line in files[dockerfile].decode("utf-8").splitlines():
            if not line.upper().startswith("COPY "):
                continue
            tokens = shlex.split(line[5:])
            if any(token.startswith("--from=") for token in tokens):
                continue
            tokens = [token for token in tokens if not token.startswith("--")]
            if len(tokens) < 2 or any("*" in token or token.startswith("[") for token in tokens):
                raise ValueError("Docker COPY form needs explicit source policy review")
            for source in tokens[:-1]:
                source_path = pathlib.PurePosixPath(context, source).as_posix().removeprefix("./").rstrip("/")
                if source_path == ".":
                    source_path = ""
                if not any(path == source_path or path.startswith(source_path + "/") or not source_path for path in files):
                    raise ValueError("Snapshot lacks a Docker COPY input")


def documentation_text(text: str) -> str:
    """Only the selected guides' fenced/inline code grammar; not CommonMark."""
    lines = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
        elif marker:
            fence = marker[1]
        else:
            lines.append(line)
    text = re.sub(r"<!--.*?-->", "", "\n".join(lines), flags=re.S)
    return re.sub(r"(`+)(.*?)\1(?!`)", "", text, flags=re.S)


class DocumentationHtml(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.targets = []

    def handle_starttag(self, tag, attrs):
        self.targets.extend(value for key, value in attrs if key in ("href", "src") and value is not None)


def documentation_targets(text: str) -> list[str]:
    text = documentation_text(text)
    inline = re.compile(r"!?\[[^\]\n]*\]\([ \t]*(?:<([^<>\n]*)>|([^\s()]*))(?:[ \t]+(?:\"[^\"\n]*\"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)")
    targets = [match[1] if match[1] is not None else match[2] for match in inline.finditer(text)]
    remainder = inline.sub("", text)
    if re.search(r"\][ \t]*\(", remainder):
        raise ValueError("Documentation link form needs explicit policy review")
    definitions = re.compile(r"(?m)^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\n]+)>|(\S+))(?:[ \t]+(?:\"[^\"\n]*\"|'[^'\n]*'))?[ \t]*$")
    references = {}
    for match in definitions.finditer(remainder):
        key = " ".join(match[1].split()).casefold()
        target = match[2] if match[2] is not None else match[3]
        if key in references and references[key] != target:
            raise ValueError("Documentation reference definition is ambiguous")
        references[key] = target
        targets.append(target)
    for match in re.finditer(r"!?\[([^\]\n]+)\]\[([^\]\n]*)\]", definitions.sub("", remainder)):
        key = " ".join((match[2] or match[1]).split()).casefold()
        if key not in references:
            raise ValueError("Documentation reference definition is missing")
    html = DocumentationHtml()
    html.feed(text)
    return targets + html.targets


def verify_documentation(files: dict[str, bytes]) -> None:
    """Target-file closure only: no heading validation or external fetching."""
    if not ESSENTIAL_DOCS.issubset(files):
        raise ValueError("Snapshot lacks essential product documentation")
    for source, content in files.items():
        if not source.endswith(".md"):
            continue
        for target in documentation_targets(content.decode("utf-8")):
            if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in target):
                raise ValueError("Documentation target is unsafe")
            link = urlsplit(target)
            if link.scheme in ("https", "http", "mailto", "tel") or not link.scheme and link.netloc:
                continue
            if link.scheme:
                raise ValueError("Documentation target scheme is unsupported")
            path = unquote(link.path, encoding="utf-8", errors="strict")
            if path.startswith("/") or "\\" in path or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in path):
                raise ValueError("Documentation target is unsafe")
            if not path:
                continue  # Same document; heading fragments are deliberately unverified.
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
            if resolved == ".." or resolved.startswith("../"):
                raise ValueError("Documentation target escapes the snapshot")
            directory = path.endswith("/") or posixpath.basename(path) in (".", "..")
            if not (resolved in files and not directory) and not any(posixpath.normpath(posixpath.join(resolved, name)) in files for name in ("README.md", "index.md")):
                raise ValueError("Documentation target is missing or excluded")


def encode(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def prepare(repo: pathlib.Path, commit: str, output: pathlib.Path) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("An exact full lowercase commit SHA is required")
    actual = git(repo, "rev-parse", "--verify", commit + "^{commit}").decode().strip()
    if actual != commit:
        raise ValueError("Commit identity changed")
    tree = git(repo, "rev-parse", commit + "^{tree}").decode().strip()
    entries, excluded = tracked(repo, commit)
    files = blobs(repo, entries)
    selected = []
    for entry in entries:
        data = files[entry["path"]]
        if data.startswith(b"version https://git-lfs.github.com/spec/v1"):
            excluded["lfs-pointer"] += 1
            del files[entry["path"]]
            continue
        if re.search(rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----", data):
            raise ValueError("Private key marker in a vetted source input")
        selected.append({**entry, "sha256": hashlib.sha256(data).hexdigest()})
    verify_build_tree(files)
    verify_documentation(files)
    manifest = {"format": POLICY, "commit": commit, "tree": tree, "files": selected, "excludedCounts": dict(sorted(excluded.items())), "scope": "Vetted source/build/docs subset; no Git history, untracked files, symlinks, submodules, env/private files or media", "selfHash": "SOURCE-MANIFEST.json intentionally excludes itself; archive hash is external", "archive": {"tar": "pax", "gzipLevel": 9, "mtime": 0, "uid": 0, "gid": 0}}
    manifest_bytes = encode(manifest)
    name = "eldhall-source-" + commit
    archive_buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=archive_buffer, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            contents = {**files, "SOURCE-MANIFEST.json": manifest_bytes}
            modes = {entry["path"]: 0o755 if entry["mode"] == "100755" else 0o644 for entry in selected}
            for path in sorted(contents):
                info = tarfile.TarInfo(name + "/" + path)
                info.size = len(contents[path])
                info.mode = modes.get(path, 0o644)
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(contents[path]))
    data = archive_buffer.getvalue()
    if output.is_symlink():
        raise ValueError("Source output directory is linked")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    targets = {name + ".tar.gz": data, name + ".files.json": manifest_bytes, name + ".sha256": (hashlib.sha256(data).hexdigest() + "  " + name + ".tar.gz\n").encode()}
    for path, content in targets.items():
        target = output / path
        if target.exists() or target.is_symlink():
            raise ValueError("Refusing to overwrite an existing source artifact")
    for path, content in targets.items():
        descriptor = os.open(output / path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
    return {"commit": commit, "tree": tree, "files": len(selected), "excludedCounts": manifest["excludedCounts"], "archive": name + ".tar.gz", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "publication": "private-review-only"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        if ".omc" not in args.output_dir.resolve().parts:
            raise ValueError("Review outputs must remain in a private .omc directory")
        print(json.dumps(prepare(args.repo, args.commit, args.output_dir), sort_keys=True))
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        print("Source preparation refused: input/identity/policy or output checks failed; no raw paths/content logged.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
