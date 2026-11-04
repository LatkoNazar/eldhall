#!/usr/bin/env python3
"""Verify a private, bounded legacy-attestation OCI graph before local Docker load.

Never extracts layer files, fetches URLs, signs, pushes, or retains image/config
bytes in evidence. OCI archives remain in the ephemeral runner directory.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import uuid
import zlib
from urllib.parse import parse_qs, unquote

HASH = re.compile(r"^sha256:[a-f0-9]{64}$")
INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
LAYER = "application/vnd.oci.image.layer.v1.tar"
INTOTO = "application/vnd.in-toto+json"
SPDX = "https://spdx.dev/Document"
SLSA = "https://slsa.dev/provenance/v0.2"
MAX_ARCHIVE = 12 * 1024**3
MAX_BLOB = 4 * 1024**3
MAX_EXPANDED_LAYER = 8 * 1024**3
MAX_EXPANDED_TOTAL = 24 * 1024**3
MAX_JSON = 32 * 1024**2
MAX_MEMBERS = 10000

# Only trusted, source-defined validation branches can produce these codes.
# No exception text, filesystem path, JSON value or command output is logged.
FAILURE_CODES = {
    'Non-finite JSON': 'OCI001',
    'JSON structure exceeds bounds': 'OCI002',
    'JSON collection exceeds bounds': 'OCI003',
    'JSON input must be a bounded regular file': 'OCI004',
    'Invalid SHA256 identity': 'OCI005',
    'OCI archive must be a bounded regular file': 'OCI006',
    'OCI member count, duplicate or extended metadata is unsupported': 'OCI007',
    'OCI archive contains an unsafe or unsupported entry': 'OCI008',
    'OCI member exceeds byte bound': 'OCI009',
    'OCI aggregate byte bound exceeded': 'OCI010',
    'OCI archive has nonzero trailing content': 'OCI011',
    'OCI layout metadata is missing': 'OCI012',
    'Unsupported OCI layout version': 'OCI013',
    'OCI blob content digest differs': 'OCI014',
    'OCI JSON blob missing or oversized': 'OCI015',
    'External or inline descriptors are unsupported': 'OCI016',
    'OCI descriptor size or blob differs': 'OCI017',
    'Unsupported OCI descriptor media type': 'OCI018',
    'OCI object type or schema differs': 'OCI019',
    'Expected verified exact source archive and native architecture': 'OCI020',
    'Expected one OCI layout entrypoint': 'OCI021',
    'Expected one runnable image plus bounded attestations': 'OCI022',
    'Expected unique native runnable manifest': 'OCI023',
    'Unsupported platform variant': 'OCI024',
    'Runnable image is an artifact': 'OCI025',
    'Runtime config/platform/layer set differs': 'OCI026',
    'Only raw or gzip OCI runtime layers are supported': 'OCI027',
    'Expanded layer byte bound exceeded': 'OCI028',
    'Uncompressed runtime layer DiffID differs': 'OCI029',
    'Unknown platform or unbound attestation descriptor': 'OCI030',
    'Only explicit legacy attestation encoding is supported': 'OCI031',
    'Attestation layer count differs': 'OCI032',
    'Unsupported in-toto statement': 'OCI033',
    'Attestation subject differs from runnable manifest': 'OCI034',
    'Missing or duplicate attestation predicate': 'OCI035',
    'SPDX document/packages are missing or unsupported': 'OCI036',
    'Unexpected provenance build type': 'OCI037',
    'Provenance materials are missing or unbounded': 'OCI038',
    'Dockerfile has no reviewed base policy': 'OCI039',
    'Provenance contains an unreviewed material': 'OCI040',
    'Provenance does not cover all reviewed Dockerfile bases': 'OCI041',
    'Missing required attestations or unreferenced OCI blobs': 'OCI042',
    'Buildx output does not identify the verified OCI graph': 'OCI043',
    'Loaded Docker runtime does not match verified OCI config and DiffIDs': 'OCI044',
    'Docker runtime descriptor is outside the verified image graph': 'OCI045',
    'Local OCI load/runtime command failed': 'OCI046',
    'Container image is outside the verified runtime graph': 'OCI047',
    'Expected one loaded native image': 'OCI048',
    'Invalid local probe container identity': 'OCI049',
    'Probe container image is outside the verified graph': 'OCI050',
    'Offline init requires a verified image and bounded fixed helper': 'OCI051',
    'Offline image init proof is incomplete': 'OCI052',
    'Offline init container did not complete': 'OCI053',
    'Offline init helper is not a bounded regular file': 'OCI054',
    'OCI archive member count exceeds bound': 'OCI055',
    'OCI archive has duplicate member names': 'OCI056',
    'OCI archive contains unsupported timestamp-only PAX metadata': 'OCI057',
    'OCI archive contains unsupported non-timestamp PAX metadata': 'OCI058',
}
PHASES = frozenset({"inputs", "archive-entries", "archive-blob-hashes", "layout-entrypoint", "runtime-manifest-config", "runtime-layers", "attestations", "build-metadata", "docker-load", "runtime-binding", "container-probe", "offline-init", "evidence-output"})
_phase = "inputs"


def phase(value):
    global _phase
    _phase = value if value in PHASES else "inputs"


class VerificationFailure(ValueError):
    def __init__(self, message):
        self.code = FAILURE_CODES.get(message, "OCI000")
        self.material_profile = None
        super().__init__(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse(data: bytes):
    if len(data) > MAX_JSON:
        raise ValueError("JSON byte bound exceeded")
    try:
        value = json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: fail("Non-finite JSON"))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError("JSON is invalid or excessively nested") from error
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 64 or count > 1_000_000:
            fail("JSON structure exceeds bounds")
        if isinstance(item, dict):
            if len(item) > 100_000 or len(pending) + len(item) > 1_000_000:
                fail("JSON collection exceeds bounds")
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            if len(item) > 100_000 or len(pending) + len(item) > 1_000_000:
                fail("JSON collection exceeds bounds")
            pending.extend((child, depth + 1) for child in item)
    return value


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON:
        fail("JSON input must be a bounded regular file")
    with path.open("rb") as stream:
        return parse(stream.read(MAX_JSON + 1))


def fail(message):
    raise VerificationFailure(message)


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        fail("Invalid SHA256 identity")
    return value


class Layout:
    def __init__(self, path: pathlib.Path):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE:
            fail("OCI archive must be a bounded regular file")
        self.archive = tarfile.open(path, "r:")
        try:
            self._index()
        except BaseException:
            self.archive.close()
            raise

    def _index(self):
        phase("archive-entries")
        self.members = {}
        self.referenced = set()
        total = 0
        seen = set()
        end = 0
        for count, member in enumerate(self.archive):
            if count >= MAX_MEMBERS:
                fail("OCI archive member count exceeds bound")
            if member.name in seen:
                fail("OCI archive has duplicate member names")
            if member.pax_headers:
                if set(member.pax_headers).issubset({"mtime", "atime", "ctime"}):
                    fail("OCI archive contains unsupported timestamp-only PAX metadata")
                fail("OCI archive contains unsupported non-timestamp PAX metadata")
            seen.add(member.name)
            end = member.offset_data + ((member.size + 511) // 512) * 512
            # Exporter may include these two harmless directory entries only.
            if member.isdir() and member.name.rstrip("/") in ("blobs", "blobs/sha256"):
                continue
            if not member.isfile() or not (member.name in ("oci-layout", "index.json") or re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", member.name)):
                fail("OCI archive contains an unsafe or unsupported entry")
            if member.size < 0 or member.size > MAX_BLOB:
                fail("OCI member exceeds byte bound")
            total += member.size
            if total > MAX_ARCHIVE:
                fail("OCI aggregate byte bound exceeded")
            self.members[member.name] = member
        # Do not let tar's first end marker hide a second archive/nonzero tail.
        self.archive.fileobj.seek(end)
        while tail := self.archive.fileobj.read(1024 * 1024):
            if any(tail):
                fail("OCI archive has nonzero trailing content")
        if not {"oci-layout", "index.json"}.issubset(self.members):
            fail("OCI layout metadata is missing")
        if self.json("oci-layout") != {"imageLayoutVersion": "1.0.0"}:
            fail("Unsupported OCI layout version")
        phase("archive-blob-hashes")
        # Every blob is checked, even if a later graph error makes it unreachable.
        for name, member in self.members.items():
            if not name.startswith("blobs/"):
                continue
            with self.archive.extractfile(member) as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != name.rsplit("/", 1)[1]:
                fail("OCI blob content digest differs")

    def close(self):
        self.archive.close()

    def read(self, name):
        member = self.members.get(name)
        if member is None or member.size > MAX_JSON:
            fail("OCI JSON blob missing or oversized")
        return self.archive.extractfile(member).read(MAX_JSON + 1)

    def json(self, name):
        return parse(self.read(name))

    def descriptor(self, value, media_type=None):
        if not isinstance(value, dict) or value.get("urls") or value.get("data"):
            fail("External or inline descriptors are unsupported")
        identity = digest(value.get("digest"))
        name = "blobs/sha256/" + identity[7:]
        member = self.members.get(name)
        if type(value.get("size")) is not int or member is None or value["size"] != member.size:
            fail("OCI descriptor size or blob differs")
        if media_type and value.get("mediaType") != media_type:
            fail("Unsupported OCI descriptor media type")
        self.referenced.add(name)
        return name

    def object(self, descriptor, media_type):
        obj = self.json(self.descriptor(descriptor, media_type))
        if not isinstance(obj, dict) or obj.get("schemaVersion") != 2 or obj.get("mediaType") != media_type:
            fail("OCI object type or schema differs")
        return obj


def material_matches(uri, identity, base, arch):
    if not isinstance(uri, str) or len(uri) > 1000 or not uri.startswith("pkg:docker/") or re.search(r"\s|#", uri):
        return False
    package, separator, query = uri[11:].partition("?")
    repository, separator2, version = package.rpartition("@")
    if not separator:
        return False
    if not separator2:
        # BuildKit RefToPURL emits canonical digest-only references without an
        # @version. They still require an explicit reviewed digest qualifier.
        repository, version = package, None
    repository = unquote(repository)
    version = unquote(version) if version is not None else None
    if "/" not in repository:
        repository = "docker.io/library/" + repository
    elif "." not in repository.split("/")[0] and ":" not in repository.split("/")[0]:
        repository = "docker.io/" + repository
    fields = parse_qs(query, strict_parsing=True, keep_blank_values=True)
    platforms = [p for p in base["platforms"] if p["platform"] == "linux/" + arch]
    allowed = {base["index"]["digest"], *(p["manifestDigest"] for p in platforms)}
    platform_names = {"linux/" + arch, *(p["platform"] + "/" + p["variant"] for p in platforms if p.get("variant"))}
    if version is not None and HASH.fullmatch(version) and (version != identity or "digest" in fields and fields["digest"] != [version]):
        return False
    version_matches = version in {base["tag"], *allowed} if version is not None else fields.get("digest") == [identity]
    return (repository == base["repository"] and version_matches and identity in allowed
            and set(fields).issubset({"platform", "digest"}) and len(fields.get("platform", [])) == 1
            and fields["platform"][0] in platform_names
            and ("digest" not in fields or fields["digest"] == [identity]))


def material_diagnostic(uri, identity, approved, lock, arch, position, count):
    """Only finite classifications against reviewed policy; never return input strings."""
    profile = {"position": position, "materialCount": count, "versionForm": "malformed", "qualifierForm": "malformed", "qualifiersUnique": False, "approvedBaseOverflow": len(approved) > 4, "approvedBases": [], "knownOtherLockedRelation": "none", "knownToolRelation": "none"}
    repository, version, fields = "", None, {}
    if isinstance(uri, str) and len(uri) <= 1000 and uri.startswith("pkg:docker/"):
        try:
            package, separator, query = uri[11:].partition("?")
            repository, has_version, version = package.rpartition("@")
            if not has_version:
                repository, version = package, None
            repository = unquote(repository)
            version = unquote(version) if version is not None else None
            if "/" not in repository:
                repository = "docker.io/library/" + repository
            elif "." not in repository.split("/")[0] and ":" not in repository.split("/")[0]:
                repository = "docker.io/" + repository
            fields = parse_qs(query, strict_parsing=True, keep_blank_values=True)
            if separator:
                profile["versionForm"] = "absent" if version is None else "empty" if version == "" else "digest" if HASH.fullmatch(version) else "tag"
                profile["qualifierForm"] = "platform-only" if set(fields) == {"platform"} else "digest-platform" if set(fields) == {"digest", "platform"} else "digest-platform-tag" if set(fields) == {"digest", "platform", "tag"} else "other"
                profile["qualifiersUnique"] = all(len(values) == 1 for values in fields.values())
        except (ValueError, UnicodeError):
            fields = {}
    def relation(base):
        if identity == base["index"]["digest"]:
            return "index"
        for platform in base["platforms"]:
            if identity == platform["manifestDigest"]:
                return "native-manifest" if platform["platform"] == "linux/" + arch else "other-manifest"
            if identity == platform["configDigest"]:
                return "config"
        return "none"
    approved_refs = {base["reference"] for base in approved}
    tool_refs = set(lock.get("tools", {}).values())
    for base in lock.get("images", []):
        if base["reference"] in approved_refs:
            continue
        known = relation(base)
        key = "knownToolRelation" if base["reference"] in tool_refs else "knownOtherLockedRelation"
        if known != "none":
            profile[key] = known
    for base in approved[:4]:
        platforms = [p for p in base["platforms"] if p["platform"] == "linux/" + arch]
        children = {p["manifestDigest"] for p in platforms}
        allowed = {base["index"]["digest"], *children}
        names = {"linux/" + arch, *(p["platform"] + "/" + p["variant"] for p in platforms if p.get("variant"))}
        profile["approvedBases"].append({"repositoryMatches": repository == base["repository"], "versionMatches": version in {base["tag"], *allowed} if version is not None else fields.get("digest") == [identity], "materialDigestIsIndex": identity == base["index"]["digest"], "materialDigestIsNativeManifest": identity in children, "platformMatches": len(fields.get("platform", [])) == 1 and fields["platform"][0] in names, "qualifierDigestMatchesMaterial": fields.get("digest") == [identity], "qualifierDigestIsIndex": fields.get("digest") == [base["index"]["digest"]], "qualifierDigestIsNativeManifest": len(fields.get("digest", [])) == 1 and fields["digest"][0] in children})
    return profile


def safe_material_profile(value):
    """Rebuild an allowlist, including if an unexpected exception spoofs details."""
    if not isinstance(value, dict):
        return None
    enums = {"versionForm": {"malformed", "absent", "empty", "tag", "digest"}, "qualifierForm": {"malformed", "platform-only", "digest-platform", "digest-platform-tag", "other"}, "knownOtherLockedRelation": {"none", "index", "native-manifest", "other-manifest", "config"}, "knownToolRelation": {"none", "index", "native-manifest", "other-manifest", "config"}}
    keys = {"repositoryMatches", "versionMatches", "materialDigestIsIndex", "materialDigestIsNativeManifest", "platformMatches", "qualifierDigestMatchesMaterial", "qualifierDigestIsIndex", "qualifierDigestIsNativeManifest"}
    if any(not isinstance(value.get(key), str) or value[key] not in choices for key, choices in enums.items()) or any(type(value.get(key)) is not bool for key in ("qualifiersUnique", "approvedBaseOverflow")) or type(value.get("position")) is not int or not 0 <= value["position"] < 100 or type(value.get("materialCount")) is not int or not 1 <= value["materialCount"] <= 100:
        return None
    bases = value.get("approvedBases")
    if not isinstance(bases, list) or len(bases) > 4 or any(not isinstance(base, dict) or any(type(base.get(key)) is not bool for key in keys) for base in bases):
        return None
    return {**{key: value[key] for key in enums}, **{key: value[key] for key in ("position", "materialCount", "qualifiersUnique", "approvedBaseOverflow")}, "approvedBases": [{key: base[key] for key in sorted(keys)} for base in bases]}


def verify_archive(path: pathlib.Path, arch: str, metadata: dict, source: dict, lock: dict, dockerfile: str, statements: dict | None = None) -> dict:
    if arch not in ("amd64", "arm64") or not re.fullmatch(r"[a-f0-9]{40}", source.get("commit", "")) or source.get("verifiedRegularMembers") is not True:
        fail("Expected verified exact source archive and native architecture")
    digest("sha256:" + source.get("archive", {}).get("sha256", ""))
    layout = Layout(path)
    try:
        phase("layout-entrypoint")
        entry_bytes = layout.read("index.json")
        entry = parse(entry_bytes)
        if not isinstance(entry, dict) or entry.get("schemaVersion") != 2 or entry.get("mediaType", INDEX) != INDEX or len(entry.get("manifests", [])) != 1:
            fail("Expected one OCI layout entrypoint")
        root_descriptor = entry["manifests"][0]
        root = layout.object(root_descriptor, INDEX)
        descriptors = root.get("manifests")
        if not isinstance(descriptors, list) or not 2 <= len(descriptors) <= 5:
            fail("Expected one runnable image plus bounded attestations")
        runtime = [d for d in descriptors if d.get("platform", {}).get("os") == "linux" and d.get("platform", {}).get("architecture") == arch]
        if len(runtime) != 1:
            fail("Expected unique native runnable manifest")
        selected = runtime[0]
        if selected.get("platform", {}).get("variant") not in (None, "v8" if arch == "arm64" else None):
            fail("Unsupported platform variant")
        phase("runtime-manifest-config")
        image = layout.object(selected, MANIFEST)
        if "subject" in image or "artifactType" in image:
            fail("Runnable image is an artifact")
        config = layout.json(layout.descriptor(image.get("config"), CONFIG))
        layers = image.get("layers")
        diffs = config.get("rootfs", {}).get("diff_ids")
        if config.get("os") != "linux" or config.get("architecture") != arch or config.get("rootfs", {}).get("type") != "layers" or not isinstance(layers, list) or not 1 <= len(layers) <= 100 or not isinstance(diffs, list) or len(diffs) != len(layers):
            fail("Runtime config/platform/layer set differs")
        phase("runtime-layers")
        expanded_total = 0
        for layer, expected in zip(layers, diffs):
            digest(expected)
            if layer.get("mediaType") not in (LAYER, LAYER + "+gzip"):
                fail("Only raw or gzip OCI runtime layers are supported")
            name = layout.descriptor(layer)
            hasher = hashlib.sha256()
            expanded = 0
            with layout.archive.extractfile(layout.members[name]) as raw:
                stream = gzip.GzipFile(fileobj=raw, mode="rb") if layer["mediaType"].endswith("+gzip") else raw
                while chunk := stream.read(1024 * 1024):
                    expanded += len(chunk)
                    expanded_total += len(chunk)
                    if expanded > MAX_EXPANDED_LAYER or expanded_total > MAX_EXPANDED_TOTAL:
                        fail("Expanded layer byte bound exceeded")
                    hasher.update(chunk)
                if stream is not raw:
                    stream.close()
            if "sha256:" + hasher.hexdigest() != expected:
                fail("Uncompressed runtime layer DiffID differs")
        # Only the explicitly selected legacy encoding is accepted. Unknown
        # formats are errors, rather than silently dropping an attestation.
        phase("attestations")
        attestations = []
        verified_statements = {}
        kinds = set()
        for descriptor in descriptors:
            if descriptor is selected:
                continue
            if descriptor.get("platform") != {"architecture": "unknown", "os": "unknown"} or descriptor.get("annotations", {}).get("vnd.docker.reference.type") != "attestation-manifest" or descriptor.get("annotations", {}).get("vnd.docker.reference.digest") != selected["digest"]:
                fail("Unknown platform or unbound attestation descriptor")
            attestation = layout.object(descriptor, MANIFEST)
            if "subject" in attestation or "artifactType" in attestation:
                fail("Only explicit legacy attestation encoding is supported")
            layout.json(layout.descriptor(attestation.get("config"), CONFIG))
            att_layers = attestation.get("layers")
            if not isinstance(att_layers, list) or not 1 <= len(att_layers) <= 4:
                fail("Attestation layer count differs")
            for layer in att_layers:
                statement_bytes = layout.read(layout.descriptor(layer, INTOTO))
                statement = parse(statement_bytes)
                kind = statement.get("predicateType")
                if statement.get("_type") not in ("https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1") or kind not in (SPDX, SLSA) or layer.get("annotations", {}).get("in-toto.io/predicate-type") != kind:
                    fail("Unsupported in-toto statement")
                subjects = statement.get("subject")
                if not isinstance(subjects, list) or len(subjects) != 1 or subjects[0].get("digest") != {"sha256": selected["digest"][7:]}:
                    fail("Attestation subject differs from runnable manifest")
                predicate = statement.get("predicate")
                if not isinstance(predicate, dict) or kind in kinds:
                    fail("Missing or duplicate attestation predicate")
                kinds.add(kind)
                verified_statements["sbom" if kind == SPDX else "provenance"] = statement_bytes
                item = {"manifestDigest": descriptor["digest"], "statementDigest": layer["digest"], "predicateType": kind, "subjectDigest": selected["digest"], "bytes": layer["size"], "signed": False}
                if kind == SPDX:
                    if predicate.get("spdxVersion") not in ("SPDX-2.2", "SPDX-2.3") or not isinstance(predicate.get("packages"), list) or not 1 <= len(predicate["packages"]) <= 100000:
                        fail("SPDX document/packages are missing or unsupported")
                    item["packageCount"] = len(predicate["packages"])
                else:
                    if predicate.get("buildType") != "https://mobyproject.org/buildkit@v1":
                        fail("Unexpected provenance build type")
                    materials = predicate.get("materials")
                    if not isinstance(materials, list) or not 1 <= len(materials) <= 100:
                        fail("Provenance materials are missing or unbounded")
                    expected_refs = lock.get("dockerfiles", {}).get(dockerfile)
                    if not isinstance(expected_refs, list) or not expected_refs:
                        fail("Dockerfile has no reviewed base policy")
                    approved = [image for image in lock.get("images", []) if image["reference"] in expected_refs]
                    # BuildKit captures the SBOM generator image in provenance.
                    # It is optional, distinct from Dockerfile base coverage, and
                    # only this reviewed tool role is permitted here.
                    scanner_ref = lock.get("tools", {}).get("sbomGenerator")
                    scanners = [base for base in lock.get("images", []) if base["reference"] == scanner_ref]
                    covered_refs = set()
                    base_materials = set()
                    tool_materials = set()
                    for position, material in enumerate(materials):
                        uri = material.get("uri", "")
                        identity = "sha256:" + material.get("digest", {}).get("sha256", "")
                        matched_refs = {base["reference"] for base in approved if material_matches(uri, identity, base, arch)}
                        if matched_refs:
                            covered_refs.update(matched_refs)
                            base_materials.update((reference, identity) for reference in matched_refs)
                        elif any(material_matches(uri, identity, scanner, arch) for scanner in scanners):
                            tool_materials.add((scanner_ref, identity))
                        else:
                            error = VerificationFailure("Provenance contains an unreviewed material")
                            error.material_profile = material_diagnostic(uri, identity, approved, lock, arch, position, len(materials))
                            raise error
                    if covered_refs != set(expected_refs) or len(approved) != len(expected_refs):
                        fail("Provenance does not cover all reviewed Dockerfile bases")
                    item["baseMaterials"] = [{"reference": reference, "digest": identity, "platform": "linux/" + arch} for reference, identity in sorted(base_materials)]
                    item["toolMaterials"] = [{"role": "sbom-generator", "reference": reference, "digest": identity, "platform": "linux/" + arch} for reference, identity in sorted(tool_materials)]
                attestations.append(item)
        if kinds != {SPDX, SLSA} or layout.referenced != {name for name in layout.members if name.startswith("blobs/")}:
            fail("Missing required attestations or unreferenced OCI blobs")
        phase("build-metadata")
        if ("containerimage.config.digest" in metadata and metadata["containerimage.config.digest"] != image["config"]["digest"]) or metadata.get("containerimage.digest") != root_descriptor["digest"]:
            fail("Buildx output does not identify the verified OCI graph")
        with path.open("rb") as stream:
            archive_digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
        if statements is not None:
            statements.update(verified_statements)
        return {"format": "eldhall-private-oci-v1", "platform": "linux/" + arch, "layoutEntrypointDigest": sha(entry_bytes), "imageIndexDigest": root_descriptor["digest"], "platformManifestDigest": selected["digest"], "configDigest": image["config"]["digest"], "diffIds": diffs, "archive": {"sha256": archive_digest, "bytes": path.stat().st_size}, "runtimeLayerCount": len(layers), "verifiedExpandedBytes": expanded_total, "attestations": attestations, "pinnedTools": lock["tools"], "source": {"commit": source["commit"], "archiveSha256": source["archive"]["sha256"], "binding": "runner-verified-source-input-not-provenance-git-claim"}, "limitations": ["Unsigned local BuildKit statements, not an independent trust or legal approval", "Scanner inventory is not proof of complete licensing coverage", "No publication, corresponding-source verification or image upload"]}
    finally:
        layout.close()


def runtime_binding(receipt: dict, inspection: dict) -> dict:
    phase("runtime-binding")
    kinds = {receipt["imageIndexDigest"]: "image-index", receipt["platformManifestDigest"]: "platform-manifest", receipt["configDigest"]: "config"}
    identity = inspection.get("Id")
    if identity not in kinds or inspection.get("Os") != "linux" or inspection.get("Architecture") != receipt["platform"].split("/")[1] or inspection.get("RootFS", {}).get("Type") != "layers" or inspection.get("RootFS", {}).get("Layers") != receipt["diffIds"]:
        fail("Loaded Docker runtime does not match verified OCI config and DiffIDs")
    descriptor = inspection.get("Descriptor")
    types = {receipt["imageIndexDigest"]: INDEX, receipt["platformManifestDigest"]: MANIFEST, receipt["configDigest"]: CONFIG}
    if descriptor and (descriptor.get("digest") not in types or descriptor.get("mediaType") != types[descriptor["digest"]]):
        fail("Docker runtime descriptor is outside the verified image graph")
    return {"runtimeImageId": identity, "runtimeIdKind": kinds[identity], "runtimeDescriptorDigest": descriptor.get("digest") if descriptor else None, "rootfsDiffIdsMatch": True}


def command(args, source=None):
    result = subprocess.run(args, input=source, capture_output=True, timeout=300, check=False)
    if result.returncode or len(result.stdout) > MAX_JSON:
        fail("Local OCI load/runtime command failed")
    return result.stdout


def container_binding(receipt, container):
    permitted = {receipt["imageIndexDigest"], receipt["platformManifestDigest"], receipt["configDigest"]}
    if container.get("Image") not in permitted or container.get("Config", {}).get("Image") != receipt["runtimeImageId"]:
        fail("Container image is outside the verified runtime graph")
    return {"imageId": container["Image"], "requestedRuntimeId": receipt["runtimeImageId"], "platform": receipt["platform"]}


def load_verified(path, tag, receipt):
    # Exactly the validated file is loaded. Neither a second build nor conversion.
    phase("docker-load")
    command(["docker", "load", "--input", str(path)])
    inspection = parse(command(["docker", "image", "inspect", tag]))
    if not isinstance(inspection, list) or len(inspection) != 1:
        fail("Expected one loaded native image")
    binding = runtime_binding(receipt, inspection[0])
    phase("container-probe")
    container_id = command(["docker", "create", "--platform", receipt["platform"], "--network", "none", "--read-only", "--entrypoint", "/bin/true", binding["runtimeImageId"]]).decode().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container_id):
        fail("Invalid local probe container identity")
    try:
        container = parse(command(["docker", "container", "inspect", container_id]))
        if len(container) != 1:
            fail("Probe container image is outside the verified graph")
        container_binding({**receipt, **binding}, container[0])
    finally:
        command(["docker", "rm", container_id])
    return {**receipt, **binding, "probeContainerImageBound": True}


def run_offline_init(receipt, smoke_script):
    digest(receipt["runtimeImageId"])
    if receipt.get("probeContainerImageBound") is not True or receipt.get("platform") not in ("linux/amd64", "linux/arm64") or len(smoke_script) > 1_000_000:
        fail("Offline init requires a verified image and bounded fixed helper")
    phase("offline-init")
    name = "candidate-init-" + uuid.uuid4().hex
    try:
        output = command(["docker", "run", "--name", name, "--interactive", "--platform", receipt["platform"], "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777", "--entrypoint", "node", receipt["runtimeImageId"], "--input-type=module"], source=smoke_script)
        proof = parse(output)
        if proof.get("valid") is not True or proof.get("proof") != "offline-image-init" or proof.get("state") != "prepared" or proof.get("releaseBinding") != "unbound":
            fail("Offline image init proof is incomplete")
        actual = parse(command(["docker", "container", "inspect", name]))
        if len(actual) != 1 or actual[0].get("State", {}).get("Status") != "exited" or actual[0].get("State", {}).get("ExitCode") != 0:
            fail("Offline init container did not complete")
        return {**proof, "ociRuntimeBinding": container_binding(receipt, actual[0])}
    finally:
        command(["docker", "rm", "--force", name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    verify = subparsers.add_parser("verify", help="Validate one OCI archive, then load and bind it locally")
    for name in ("archive", "metadata", "source-receipt", "lock", "output"):
        verify.add_argument("--" + name, type=pathlib.Path, required=True)
    verify.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    verify.add_argument("--role", choices=("server", "web", "mcp"), required=True)
    init = subparsers.add_parser("init", help="Run the fixed offline init helper by verified immutable ID")
    for name in ("receipt", "script", "output"):
        init.add_argument("--" + name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    policies = {"server": ("apps/api/Dockerfile", "eldhall-server:candidate"), "web": ("apps/frontend/Dockerfile", "eldhall-web:candidate"), "mcp": ("apps/mcp-openapi/Dockerfile", "eldhall-mcp-openapi:candidate")}
    phase("inputs")
    try:
        if args.operation == "init":
            if args.script.is_symlink() or not args.script.is_file() or args.script.stat().st_size > 1_000_000:
                fail("Offline init helper is not a bounded regular file")
            with args.script.open("rb") as stream:
                helper = stream.read(1_000_001)
            proof = run_offline_init(read_json(args.receipt), helper)
            args.output.write_text(json.dumps(proof, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            return 0
        dockerfile, tag = policies[args.role]
        statements = {}
        receipt = verify_archive(args.archive, args.arch, read_json(args.metadata), read_json(args.source_receipt), read_json(args.lock), dockerfile, statements)
        bound = load_verified(args.archive, tag, receipt)
        phase("evidence-output")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        for kind, data in statements.items():
            filename = f"{args.role}-{kind}.intoto.json"
            (args.output.parent / filename).write_bytes(data)
            item = next(item for item in bound["attestations"] if item["predicateType"] == (SPDX if kind == "sbom" else SLSA))
            item.update({"statementFile": filename, "role": args.role, "platform": receipt["platform"]})
        args.output.write_text(json.dumps(bound, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    except VerificationFailure as error:
        print(f"Private OCI verification failed: code={error.code} phase={_phase}; no raw input/config retained.", file=sys.stderr)
        profile = safe_material_profile(error.material_profile) if error.code == "OCI040" else None
        if profile is not None:
            print("Private OCI material profile: " + json.dumps(profile, sort_keys=True, separators=(",", ":")), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError, subprocess.SubprocessError, EOFError, RecursionError, zlib.error):
        print(f"Private OCI verification failed: code=OCI000 phase={_phase}; no raw input/config retained.", file=sys.stderr)
        return 1
    print("Private OCI graph, unsigned statements, layers and loaded native runtime verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
