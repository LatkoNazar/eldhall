#!/usr/bin/env python3
"""Prepare/verify/extract the private vetted commit archive for native image builds."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile

SPEC = importlib.util.spec_from_file_location("candidate_source_archive", pathlib.Path(__file__).with_name("source-archive.py"))
source_archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_archive)


def verify_extract(archive_path: pathlib.Path, file_manifest: pathlib.Path, checksum: pathlib.Path, commit: str, target: pathlib.Path) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or archive_path.stat().st_size > source_archive.MAX_TOTAL:
        raise ValueError("Archive identity/size is invalid")
    expected_name = f"eldhall-source-{commit}.tar.gz"
    if archive_path.name != expected_name:
        raise ValueError("Archive name differs from commit")
    archive_sha = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if checksum.read_bytes() != f"{archive_sha}  {expected_name}\n".encode():
        raise ValueError("Archive checksum differs")
    external = file_manifest.read_bytes()
    if len(external) > 4_000_000:
        raise ValueError("Source manifest is oversized")
    manifest = json.loads(external)
    if manifest.get("format") != source_archive.POLICY or manifest.get("commit") != commit or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("tree", "")):
        raise ValueError("Source manifest identity differs")
    entries = manifest.get("files", [])
    if not isinstance(entries, list) or not 1 <= len(entries) <= 10000:
        raise ValueError("Source manifest file set is invalid")
    expected = {}
    for entry in entries:
        if set(entry) != {"path", "mode", "gitBlob", "size", "sha256"} or source_archive.exclusion(entry["path"], entry["mode"]) is not None:
            raise ValueError("Source manifest contains an unsafe file")
        if entry["path"] == "SOURCE-MANIFEST.json" or entry["path"] in expected or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]) or not re.fullmatch(r"[a-f0-9]{40}", entry["gitBlob"]):
            raise ValueError("Source manifest file identity is ambiguous")
        if not isinstance(entry["size"], int) or not 0 <= entry["size"] <= source_archive.MAX_FILE:
            raise ValueError("Source file size is invalid")
        expected[entry["path"]] = entry
    if len({path.casefold() for path in expected}) != len(expected):
        raise ValueError("Source filenames collide")
    prefix = f"eldhall-source-{commit}/"
    verified = {}
    total = 0
    with tarfile.open(archive_path, "r:gz") as archive:
        for index, member in enumerate(archive):
            if index > len(expected) or not member.isfile() or not member.name.startswith(prefix) or (member.uid, member.gid, member.mtime) != (0, 0, 0):
                raise ValueError("Archive has unexpected/nonregular members")
            relative = member.name.removeprefix(prefix)
            if relative in verified:
                raise ValueError("Archive has duplicate members")
            if relative == "SOURCE-MANIFEST.json":
                if member.size != len(external) or member.mode != 0o644:
                    raise ValueError("Internal manifest metadata differs")
            else:
                entry = expected.get(relative)
                if not entry or member.size != entry["size"] or member.mode != (0o755 if entry["mode"] == "100755" else 0o644):
                    raise ValueError("Archive member differs from source file set")
            total += member.size
            if total > source_archive.MAX_TOTAL + len(external):
                raise ValueError("Archive expanded size exceeds bound")
            data = archive.extractfile(member).read()
            if relative == "SOURCE-MANIFEST.json":
                if data != external:
                    raise ValueError("Internal and external file manifests differ")
            elif hashlib.sha256(data).hexdigest() != expected[relative]["sha256"]:
                raise ValueError("Archive file checksum differs")
            verified[relative] = data
    if set(verified) != {*expected, "SOURCE-MANIFEST.json"}:
        raise ValueError("Archive has missing source files")
    source_archive.verify_build_tree({path: data for path, data in verified.items() if path != "SOURCE-MANIFEST.json"})
    # Never extract using tar ownership or link handling; write only verified
    # regular files into a brand-new private directory owned by this runner.
    if target.exists() or target.is_symlink():
        raise ValueError("Extraction root must not exist")
    target.mkdir(parents=True, mode=0o700)
    root = target / prefix.rstrip("/")
    root.mkdir(mode=0o700)
    for relative, data in verified.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = 0o755 if relative in expected and expected[relative]["mode"] == "100755" else 0o644
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        os.chmod(path, mode)
    return {"format": "eldhall-candidate-source-v1", "sourceRoot": "verified-vetted-commit-archive", "commit": commit, "tree": manifest["tree"], "archive": {"name": expected_name, "sha256": archive_sha, "bytes": archive_path.stat().st_size}, "files": len(expected), "verifiedRegularMembers": True, "buildContexts": ["apps/api", "repository-root-for-web", "apps/mcp-openapi"], "publication": "private-review-only"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--review-directory", type=pathlib.Path, required=True)
    parser.add_argument("--extract-directory", type=pathlib.Path, required=True)
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        if ".omc" not in args.review_directory.resolve().parts:
            raise ValueError("Source review output must remain private")
        receipt = source_archive.prepare(pathlib.Path.cwd(), args.commit, args.review_directory)
        name = receipt["archive"].removesuffix(".tar.gz")
        verified = verify_extract(args.review_directory / receipt["archive"], args.review_directory / (name + ".files.json"), args.review_directory / (name + ".sha256"), args.commit, args.extract_directory)
        if verified["tree"] != receipt["tree"] or verified["archive"]["sha256"] != receipt["sha256"]:
            raise ValueError("Extracted source identity differs from Git object receipt")
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(verified, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError):
        print("Candidate source preparation or verification failed; no raw source/path output retained.", file=sys.stderr)
        return 1
    print("Exact-commit private source archive verified and extracted for all native image builds.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
