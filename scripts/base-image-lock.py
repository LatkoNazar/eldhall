#!/usr/bin/env python3
"""Check reviewed Dockerfile base-reference policy offline; never queries a registry.

The lock records reviewed index/child/config identities, not a fresh cryptographic
proof of upstream membership, image content, signatures or redistribution rights.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shlex
import sys

DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
REPOSITORY = re.compile(r"(?:docker\.io|ghcr\.io)/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+\Z")
TAG = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z")
DOCKERFILES = frozenset(("apps/api/Dockerfile", "apps/frontend/Dockerfile", "apps/landing/Dockerfile", "apps/mcp-openapi/Dockerfile"))
PLATFORMS = frozenset(("linux/amd64", "linux/arm64"))
MAX_BYTES = 256_000


def fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Lock fields are missing or unsupported")


def digest(value):
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise ValueError("Lock digest is invalid")


def size(value):
    if type(value) is not int or not 1 <= value <= 1_000_000:
        raise ValueError("Lock descriptor size is invalid")


def validate_lock(value: object) -> dict:
    fields(value, ("lockFormat", "images", "dockerfiles", "tools"))
    if type(value["lockFormat"]) is not int or value["lockFormat"] != 1:
        raise ValueError("Lock format is unsupported")
    if not isinstance(value["images"], list) or not 1 <= len(value["images"]) <= 20:
        raise ValueError("Lock image count is invalid")
    references, identities, repositories = set(), set(), {}
    for image in value["images"]:
        fields(image, ("repository", "tag", "reference", "index", "platforms"))
        if not isinstance(image["repository"], str) or not REPOSITORY.fullmatch(image["repository"]) or not isinstance(image["tag"], str) or not TAG.fullmatch(image["tag"]):
            raise ValueError("Lock image identity is not canonical")
        fields(image["index"], ("mediaType", "digest", "size"))
        index = image["index"]
        if index["mediaType"] not in ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"):
            raise ValueError("Lock base must identify an image index")
        digest(index["digest"])
        size(index["size"])
        identity = image["repository"] + ":" + image["tag"]
        if image["reference"] != identity + "@" + index["digest"] or identity in identities or image["reference"] in references:
            raise ValueError("Lock references are inconsistent or ambiguous")
        identities.add(identity)
        references.add(image["reference"])
        repositories[image["reference"]] = image["repository"]
        if not isinstance(image["platforms"], list) or len(image["platforms"]) != 2:
            raise ValueError("Lock requires both native platform identities")
        platforms, object_digests = set(), {index["digest"]}
        for platform in image["platforms"]:
            fields(platform, ("platform", "variant", "manifestDigest", "manifestSize", "configDigest"))
            name = platform["platform"]
            if not isinstance(name, str) or name not in PLATFORMS or name in platforms:
                raise ValueError("Lock platform coverage is invalid")
            if platform["variant"] not in ((None, "v1") if name == "linux/amd64" else (None, "v8")):
                raise ValueError("Lock platform variant is unsupported")
            platforms.add(name)
            size(platform["manifestSize"])
            for key in ("manifestDigest", "configDigest"):
                digest(platform[key])
                if platform[key] in object_digests:
                    raise ValueError("Lock index, platform and config identities are ambiguous")
                object_digests.add(platform[key])
        if platforms != PLATFORMS:
            raise ValueError("Lock platform coverage is incomplete")
    fields(value["dockerfiles"], DOCKERFILES)
    used = set()
    for allowed in value["dockerfiles"].values():
        if not isinstance(allowed, list) or not 1 <= len(allowed) <= 20 or any(not isinstance(ref, str) or ref not in references for ref in allowed) or len(set(allowed)) != len(allowed):
            raise ValueError("Lock Dockerfile references are invalid")
        used.update(allowed)
    tools = value["tools"]
    fields(tools, ("buildkit", "sbomGenerator"))
    if any(not isinstance(ref, str) or ref not in references for ref in tools.values()):
        raise ValueError("Lock tooling references are invalid")
    if repositories[tools["buildkit"]] != "docker.io/moby/buildkit" or repositories[tools["sbomGenerator"]] != "docker.io/docker/buildkit-syft-scanner":
        raise ValueError("Lock tooling roles differ from reviewed repositories")
    used.update(tools.values())
    if used != references:
        raise ValueError("Lock has unused or missing image references")
    return value


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Lock JSON contains duplicate keys")
        value[key] = item
    return value


def bounded_text(path: pathlib.Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Input must be a regular file")
    with path.open("rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Input exceeds its byte limit")
    return data.decode("utf-8")


def load_lock(path: pathlib.Path) -> dict:
    def nonfinite(_):
        raise ValueError("Nonfinite lock value")
    try:
        value = json.loads(bounded_text(path), object_pairs_hook=unique_object, parse_constant=nonfinite)
    except RecursionError:
        raise ValueError("Lock JSON nesting is unsupported") from None
    return validate_lock(value)


def instructions(text: str):
    pending = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if re.match(r"#\s*(?:escape|syntax)\s*=", stripped, re.I):
                raise ValueError("Dockerfile frontend directive needs explicit review")
            continue
        if "<<" in stripped:
            raise ValueError("Dockerfile here-document form needs explicit review")
        if stripped.endswith("\\"):
            pending += stripped[:-1] + " "
            continue
        yield pending + stripped
        pending = ""
    if pending:
        raise ValueError("Dockerfile continuation is incomplete")


def verify_dockerfiles(root: pathlib.Path, lock: dict) -> None:
    validate_lock(lock)
    for filename, allowed in lock["dockerfiles"].items():
        stages, used = {}, set()
        current = -1

        def external(reference):
            if reference not in allowed:
                raise ValueError("Dockerfile uses a mutable, unknown or mismatched external image")
            used.add(reference)

        for line in instructions(bounded_text(root / filename)):
            parts = line.split(None, 1)
            opcode, body = parts[0], parts[1] if len(parts) == 2 else ""
            if opcode.upper() == "ONBUILD":
                raise ValueError("Dockerfile ONBUILD source needs explicit review")
            if opcode.upper() == "RUN" and re.search(r"(?:^|\s)--mount(?:=|\s)", body):
                raise ValueError("Dockerfile RUN mount source needs explicit review")
            if opcode.upper() not in ("FROM", "COPY"):
                continue
            tokens = shlex.split(body, comments=True)
            if opcode.upper() == "FROM":
                if len(tokens) not in (1, 3) or len(tokens) == 3 and (tokens[1].upper() != "AS" or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", tokens[2])):
                    raise ValueError("Dockerfile FROM form needs explicit review")
                if tokens[0].casefold() not in stages:
                    external(tokens[0])
                current += 1
                if len(tokens) == 3:
                    name = tokens[2].casefold()
                    if name in stages:
                        raise ValueError("Dockerfile build stage is ambiguous")
                    stages[name] = current
            else:
                if current < 0:
                    raise ValueError("Dockerfile COPY has no build stage")
                if "--from" in tokens:
                    raise ValueError("Dockerfile COPY flag form needs explicit review")
                sources = [token[7:] for token in tokens if token.startswith("--from=")]
                if len(sources) > 1:
                    raise ValueError("Dockerfile COPY source is ambiguous")
                if not sources:
                    continue
                source = sources[0]
                if source.casefold() in stages:
                    if stages[source.casefold()] >= current:
                        raise ValueError("Dockerfile cannot copy from its current stage")
                elif re.fullmatch(r"0|[1-9][0-9]*", source):
                    if int(source) >= current:
                        raise ValueError("Dockerfile COPY stage does not exist")
                else:
                    external(source)
        if current < 0 or used != set(allowed):
            raise ValueError("Dockerfile and lock reference coverage differ")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument("--lock", type=pathlib.Path)
    args = parser.parse_args()
    try:
        lock = load_lock(args.lock or args.root / "deploy/base-images.lock.json")
        verify_dockerfiles(args.root, lock)
    except (OSError, ValueError, TypeError, UnicodeError):
        print("Base-image policy refused: lock or Dockerfile input is invalid; no raw paths/content logged.", file=sys.stderr)
        return 1
    print(json.dumps({"valid": True, "scope": "offline-reference-policy", "dockerfiles": len(DOCKERFILES), "images": len(lock["images"]), "upstreamMembership": "reviewed-metadata-not-refetched"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
