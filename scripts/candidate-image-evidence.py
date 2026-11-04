#!/usr/bin/env python3
"""Read local candidate images; retain bounded public inventory/identity inputs only.

No container environment/configuration, registry authentication, payloads or image
archives are retained. Inventories and hashes are inputs to a later legal/source
review, not an SBOM, source offer or cryptographically verified provenance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys

LIMIT = 8_000_000
IMAGES = {"server": "eldhall-server:candidate", "web": "eldhall-web:candidate", "mcp": "eldhall-mcp-openapi:candidate"}
HASH = re.compile(r"^sha256:[a-f0-9]{64}$")

NODE_INVENTORY = r'''
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const packages=[], nativeFiles=[], nativeComponents=[], seen=new Set(); let files=0, total=0, receiptTotal=0;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bounded=(value,max=500)=>{if(value===undefined)return null;if(typeof value!=='string'||value.length>max)throw Error('Metadata limit');return value;};
const selected=name=>name==='sharp'||name==='@deepseek-ai/libreoffice-kit'||name==='@deepseek-ai/libreoffice-kit-wasm'||/^@img\/sharp-(?:libvips-)?linux(?:musl)?-(?:x64|arm64)$/.test(name??'');
const metadataNames=new Set(['package.json','readme','readme.md','versions.json','versions.properties','build-info.json','build-metadata.json','source-info.json','source-metadata.json']);
async function walk(directory,licenses,owner,component){
  for(const item of await fs.readdir(directory,{withFileTypes:true})){
    if(++files>100000)throw Error('File count limit');
    if(item.name==='node_modules'||item.isSymbolicLink())continue;
    const file=path.join(directory,item.name);
    if(item.isDirectory()){await walk(file,licenses,owner,component);continue;}
    if(!item.isFile())continue;
    const handle=await fs.open(file,'r');const header=Buffer.alloc(4);await handle.read(header,0,4,0);await handle.close();
    const format=header.equals(Buffer.from([127,69,76,70]))?'elf':header.equals(Buffer.from([0,97,115,109]))?'wasm':null;
    const relative=path.relative(owner.path,file).split(path.sep).join('/');
    const readmeNotice=component&&owner.name.startsWith('@img/sharp-libvips-')&&/^readme(?:\.md)?$/i.test(relative);
    const license=/^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(item.name)||/^third[-_]party[-_]notices(?:[._-]|$)/i.test(item.name)||file.split(path.sep).some(part=>/^licen[sc]es?$/i.test(part))||readmeNotice;
    const sourceMetadata=component&&!relative.includes('/')&&metadataNames.has(relative.toLowerCase());
    if(!format&&!license&&!sourceMetadata)continue;
    const stat=await fs.stat(file);total+=stat.size;
    if(stat.size>250000000||total>1000000000)throw Error('Input byte limit');
    if(component&&(license||sourceMetadata)&&stat.size>1000000)throw Error('Native receipt byte/count limit');
    const bytes=await fs.readFile(file),entry={path:file,sha256:hash(bytes),size:stat.size};
    if(format){
      const binary={...entry,format,package:{...owner}};nativeFiles.push(binary);
      if(component)component.binaries.push(binary);
    }
    if(license)licenses.push(entry);
    if(component&&(license||sourceMetadata)){
      receiptTotal+=bytes.length;component.receiptBytes+=bytes.length;
      if(bytes.length>1000000||component.receiptBytes>2000000||receiptTotal>6000000||component.receipts.length>=100)throw Error('Native receipt byte/count limit');
      const text=bytes.toString('utf8');
      if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Native receipt is not lossless UTF8');
      component.receipts.push({...entry,relativePath:relative,kind:license?'notice':'build-source-metadata',encoding:'utf-8',text,origin:'installed-package-file',package:{...owner}});
    }
  }
}
async function packageAt(directory){
  if(seen.has(directory))return;seen.add(directory);
  const file=path.join(directory,'package.json');
  let bytes;try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Package manifest is not a regular file');bytes=await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(bytes.length>1000000||packages.length>=3000)throw Error('Package limit');
  const value=JSON.parse(bytes),licenses=[];
  const owner={path:directory,name:bounded(value.name),version:bounded(value.version),manifestSha256:hash(bytes)};
  const component=selected(owner.name)?{package:owner,binaries:[],receipts:[],receiptBytes:0,sourceAvailability:'not_verified'}:null;
  if(component&&nativeComponents.length>=30)throw Error('Native component limit');
  await walk(directory,licenses,owner,component);
  packages.push({...owner,license:bounded(typeof value.license==='object'?value.license?.type:value.license),licenseFiles:licenses.sort((a,b)=>a.path.localeCompare(b.path))});
  if(component){
    component.receipts.sort((a,b)=>a.path.localeCompare(b.path));
    component.binaries.sort((a,b)=>a.path.localeCompare(b.path));
    component.missingKinds=['notice','build-source-metadata'].filter(kind=>!component.receipts.some(receipt=>receipt.kind===kind));
    if(!component.binaries.length)component.missingKinds.push('binary-fingerprint');
    nativeComponents.push(component);
  }
  await modulesAt(path.join(directory,'node_modules'));
}
async function modulesAt(directory){
  let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const item of entries){
    if(!item.isDirectory()||item.name.startsWith('.'))continue;
    const child=path.join(directory,item.name);
    if(item.name.startsWith('@')){for(const scoped of await fs.readdir(child,{withFileTypes:true}))if(scoped.isDirectory())await packageAt(path.join(child,scoped.name));}
    else await packageAt(child);
  }
}
// Optional explicit roots are only for local fixture tests; production passes no arguments.
const roots=process.argv[2]===undefined?['/app/node_modules','/usr/local/lib/node_modules']:JSON.parse(process.argv[2]);
if(!Array.isArray(roots)||!roots.length||roots.length>2||roots.some(root=>typeof root!=='string'||!path.isAbsolute(root)))throw Error('Invalid inventory roots');
for(const root of roots)await modulesAt(root);
const output=JSON.stringify({schemaVersion:1,kind:'installed-npm-inputs',architecture:process.arch,runtimeVersions:process.versions,packages:packages.sort((a,b)=>a.path.localeCompare(b.path)),nativeFiles:nativeFiles.sort((a,b)=>a.path.localeCompare(b.path)),nativeComponents:nativeComponents.sort((a,b)=>a.package.path.localeCompare(b.package.path))});
if(Buffer.byteLength(output)>8000000)throw Error('Output limit');console.log(output);
'''

PYTHON_INVENTORY = r'''
import hashlib,importlib.metadata,json,pathlib,platform,sys
packages=[];native_files=[];native_bytes=0
for dist in importlib.metadata.distributions():
    if len(packages)>=1000: raise RuntimeError('Package limit')
    license_files=[]
    for entry in dist.files or []:
        text=str(entry)
        file=pathlib.Path(dist.locate_file(entry)).resolve()
        if not file.is_relative_to(pathlib.Path('/app/.venv')) or not file.is_file(): continue
        if file.suffix in ('.so','.node'):
            native_bytes+=file.stat().st_size
            if file.stat().st_size>250000000 or native_bytes>1000000000 or len(native_files)>=2000: raise RuntimeError('Native input limit')
            native_files.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'size':file.stat().st_size})
        if not any(part.lower().startswith(('license','licence','copying','notice','copyright')) for part in pathlib.PurePosixPath(text).parts): continue
        if file.stat().st_size>2000000 or len(license_files)>=100: raise RuntimeError('License limit')
        license_files.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'size':file.stat().st_size})
    metadata={key:dist.metadata.get(key) for key in ('Name','Version','License','License-Expression')}
    if any(value is not None and len(value)>20000 for value in metadata.values()): raise RuntimeError('Metadata limit')
    packages.append({'metadata':metadata,'licenseFiles':sorted(license_files,key=lambda entry:entry['path'])})
output=json.dumps({'schemaVersion':1,'kind':'installed-python-inputs','python':platform.python_version(),'architecture':platform.machine(),'packages':sorted(packages,key=lambda entry:(entry['metadata']['Name'] or '').lower()),'nativeFiles':sorted(native_files,key=lambda entry:entry['path'])},sort_keys=True)
if len(output.encode())>8000000: raise RuntimeError('Output limit')
print(output)
'''

OS_INVENTORY = r'''
set -eu
if command -v dpkg-query >/dev/null; then
  printf 'FORMAT\tdpkg\n'
  dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n'
elif test -f /lib/apk/db/installed; then
  printf 'FORMAT\tapk\n'
  cat /lib/apk/db/installed
else exit 1; fi
'''

OS_LICENSES = r'''
set -eu
for file in /usr/share/doc/*/copyright /usr/share/licenses/*/LICENSE /usr/share/licenses/*/COPYING; do
  test ! -f "$file" || sha256sum "$file"
done
'''


def command(args: list[str], *, source: str | None = None) -> str:
    result = subprocess.run(args, input=source, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode or len(result.stdout.encode()) > LIMIT:
        raise ValueError("Candidate evidence command failed or exceeded its output limit")
    return result.stdout


def container(image: str, executable: str, args: list[str], *, source: str | None = None) -> str:
    return command(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", executable, "-i", image, *args], source=source)


def build_materials(metadata: dict) -> dict:
    config = metadata.get("containerimage.config.digest")
    manifest = metadata.get("containerimage.digest")
    if not isinstance(config, str) or not HASH.fullmatch(config) or not isinstance(manifest, str) or not HASH.fullmatch(manifest):
        raise ValueError("Build output digest is unavailable")
    materials = []
    for entry in metadata.get("buildx.build.provenance", {}).get("materials", []):
        uri = entry.get("uri", "")
        if not isinstance(uri, str) or len(uri) > 1000:
            raise ValueError("Build material identity is unavailable")
        if not uri.startswith("pkg:docker/"):
            continue
        digest = entry.get("digest", {}).get("sha256", "")
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or re.search(r"\s|[\r\n]", uri):
            raise ValueError("Build material identity is unavailable")
        materials.append({"uri": uri, "digest": "sha256:" + digest})
    if not materials:
        raise ValueError("Resolved base image materials are unavailable")
    return {"configDigest": config, "buildxOutputDigest": manifest, "buildxOutputDigestKind": "unverified-local-exporter-digest", "buildMaterials": materials}


def os_inventory(text: str) -> dict:
    if text.startswith("FORMAT\tdpkg\n"):
        packages = []
        for line in text.splitlines()[1:]:
            fields = line.split("\t")
            if len(fields) != 5:
                raise ValueError("OS package metadata is malformed")
            packages.append(dict(zip(("name", "version", "architecture", "sourcePackage", "sourceVersion"), fields)))
        kind = "dpkg"
    elif text.startswith("FORMAT\tapk\n"):
        packages = []
        for paragraph in text.split("\n", 1)[1].split("\n\n"):
            fields = dict(line.split(":", 1) for line in paragraph.splitlines() if ":" in line)
            if fields:
                if not all(fields.get(key) for key in ("P", "V", "A")):
                    raise ValueError("OS package metadata is malformed")
                packages.append({"name": fields["P"], "version": fields["V"], "architecture": fields["A"], "origin": fields.get("o"), "license": fields.get("L")})
        kind = "apk"
    else:
        raise ValueError("OS package inventory is unavailable")
    if not 1 <= len(packages) <= 5000:
        raise ValueError("OS package count is outside its limit")
    return {"kind": kind, "packages": sorted(packages, key=lambda item: item["name"])}


def write_json(output: pathlib.Path, name: str, value: object) -> None:
    text = json.dumps(value, sort_keys=True, indent=2) + "\n"
    if len(text.encode()) > LIMIT:
        raise ValueError("Evidence artifact exceeds its size limit")
    (output / name).write_text(text, encoding="utf-8")


def native_review_inputs(components: list[dict], image: dict, revision: str, build_source: dict) -> dict:
    """Bind observed files to the immutable image, without approving their terms/source."""
    if image.get("imageId") != image.get("configDigest") or not HASH.fullmatch(image.get("imageId", "")) or image.get("architecture") not in ("amd64", "arm64"):
        raise ValueError("Native receipt image binding is invalid")
    if len(components) > 30:
        raise ValueError("Native component count exceeds bound")
    text_bytes = 0
    for component in components:
        owner = component["package"]
        if not isinstance(owner.get("name"), str) or not isinstance(owner.get("version"), str) or not re.fullmatch(r"[a-f0-9]{64}", owner.get("manifestSha256", "")) or component.get("sourceAvailability") != "not_verified":
            raise ValueError("Native package identity is incomplete")
        component_bytes = 0
        for binary in component["binaries"]:
            if binary.get("package") != owner or binary.get("format") not in ("elf", "wasm"):
                raise ValueError("Native binary package binding is invalid")
        for receipt in component["receipts"]:
            raw = receipt["text"].encode("utf-8")
            if receipt.get("package") != owner or receipt.get("encoding") != "utf-8" or receipt.get("origin") != "installed-package-file" or len(raw) != receipt["size"] or hashlib.sha256(raw).hexdigest() != receipt["sha256"]:
                raise ValueError("Installed notice/source receipt is not byte-exact")
            component_bytes += len(raw)
            if len(raw) > 1_000_000:
                raise ValueError("Native receipt exceeds byte bound")
        text_bytes += component_bytes
        if component_bytes > 2_000_000 or text_bytes > 6_000_000:
            raise ValueError("Native receipts exceed aggregate byte bound")
    return {"format": "eldhall-native-review-inputs-v1", "image": {key: image[key] for key in ("imageId", "configDigest", "architecture", "buildxOutputDigest", "buildxOutputDigestKind", "buildMaterials")}, "sourceRevision": revision, "buildSource": build_source, "components": components, "receiptBytes": text_bytes, "sourceAvailability": "not_verified", "scope": "Observed installed native files/notices/declared build metadata; not an SBOM, corresponding-source verification or legal approval"}


def collect(arch: str, version: str, revision: str, metadata_dir: pathlib.Path, output: pathlib.Path, source_root: pathlib.Path | None = None) -> None:
    native = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
    if native.get(platform.machine()) != arch or native.get(command(["docker", "info", "--format", "{{.Architecture}}"]).strip()) != arch:
        raise ValueError("Host and Docker daemon do not match the native matrix architecture")
    output.mkdir(parents=True, exist_ok=True)
    source_root = source_root or pathlib.Path.cwd()
    records = {}
    for name, image in IMAGES.items():
        inspection = json.loads(command(["docker", "image", "inspect", image, "--format", '{{json .}}']))
        material = build_materials(json.loads((metadata_dir / f"{name}.json").read_text(encoding="utf-8")))
        if inspection.get("Architecture") != arch or inspection.get("Os") != "linux" or inspection.get("Id") != material["configDigest"]:
            raise ValueError("Built image architecture/config identity does not match its receipt")
        legal_dir = "/srv/licenses" if name == "web" else "/app/licenses"
        expected_user = inspection.get("Config", {}).get("User", "")
        if not expected_user or expected_user in ("root", "0", "0:0"):
            raise ValueError("Image does not declare a non-root user")
        legal_names = ["LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.md", "manifest.json"]
        source_legal = source_root / ("apps/frontend/public/licenses" if name == "web" else f"apps/{'api' if name == 'server' else 'mcp-openapi'}/licenses")
        if name == "web":
            legal_names.append("BROWSER_NOTICES.txt")
        immutable_image = inspection["Id"]
        legal = container(immutable_image, "/bin/sh", ["-ec", 'test "$(id -u)" -ne 0; sha256sum ' + " ".join(f"{legal_dir}/{file}" for file in legal_names)])
        hashes = [line.split()[0] for line in legal.splitlines()]
        expected = [hashlib.sha256((source_legal / file).read_bytes()).hexdigest() for file in legal_names]
        if hashes != expected:
            raise ValueError("Image project license/notice differs from canonical files")
        os_record = os_inventory(container(immutable_image, "/bin/sh", ["-s"], source=OS_INVENTORY))
        os_record["licenseFileHashes"] = container(immutable_image, "/bin/sh", ["-s"], source=OS_LICENSES).splitlines()
        write_json(output, f"{name}-os-inputs.json", os_record)
        records[name] = {"image": image, "imageId": inspection["Id"], "architecture": arch, "user": expected_user, "projectNoticesMatch": True, **material}
    node = json.loads(container(records["server"]["imageId"], "node", ["--input-type=module", "-"], source=NODE_INVENTORY))
    if node.get("architecture") != {"amd64": "x64", "arm64": "arm64"}[arch]:
        raise ValueError("Node runtime architecture does not match the matrix")
    components = node.pop("nativeComponents")
    write_json(output, "server-npm-inputs.json", node)
    python = json.loads(container(records["mcp"]["imageId"], "python", ["-"], source=PYTHON_INVENTORY))
    if native.get(python.get("architecture")) != arch:
        raise ValueError("Python runtime architecture does not match the matrix")
    write_json(output, "mcp-python-inputs.json", python)
    caddy = container(records["web"]["imageId"], "caddy", ["build-info"]).splitlines()
    if not caddy or len(caddy) > 2000:
        raise ValueError("Web native build inventory is unavailable")
    write_json(output, "web-caddy-build-inputs.json", {"schemaVersion": 1, "kind": "native-binary-declared-modules", "lines": caddy})
    help_output = container(records["server"]["imageId"], "eldhall", ["help"])
    if "version" not in help_output or "config validate" not in help_output or len(help_output) > 20_000:
        raise ValueError("Image CLI help is incomplete")
    cli = json.loads(container(records["server"]["imageId"], "eldhall", ["version"]))
    if cli.get("name") != "eldhall" or cli.get("version") != version or cli.get("sourceRevision") != revision or cli.get("buildMetadata") != "recorded":
        raise ValueError("Image CLI does not report its baked build identity")
    # Deliberately conflicting runtime values must not rewrite baked version information.
    injected = json.loads(command(["docker", "run", "--rm", "--network", "none", "--read-only", "-e", "ELDHALL_VERSION=9.9.9", "-e", "ELDHALL_SOURCE_REVISION=" + "f" * 40, records["server"]["imageId"], "eldhall", "version"]))
    if injected != cli:
        raise ValueError("Runtime environment replaced baked image identity")
    inputs = ("LICENSE", "NOTICE", "apps/api/package-lock.json", "apps/mcp-openapi/uv.lock", "apps/frontend/package-lock.json", "apps/api/Dockerfile", "apps/frontend/Dockerfile", "apps/mcp-openapi/Dockerfile")
    source_manifest = source_root / "SOURCE-MANIFEST.json"
    if source_manifest.is_file():
        source_identity = json.loads(source_manifest.read_text(encoding="utf-8"))
        if source_identity.get("commit") != revision or source_identity.get("format") != "eldhall-source-v1":
            raise ValueError("Image source manifest differs from the requested revision")
        build_source = {"kind": "verified-vetted-commit-archive", "commit": revision, "tree": source_identity["tree"], "fileManifestSha256": hashlib.sha256(source_manifest.read_bytes()).hexdigest()}
    else:
        raise ValueError("Native images require the verified archive source manifest")
    write_json(output, "server-native-review-inputs.json", native_review_inputs(components, records["server"], revision, build_source))
    write_json(output, "identity.json", {"schemaVersion": 1, "mode": "native-archive-source-build-not-published", "buildSource": build_source, "sourceRevision": revision, "candidateVersion": version, "cli": cli, "images": records, "sourceReceiptInputs": [{"path": file, "sha256": hashlib.sha256((source_root / file).read_bytes()).hexdigest()} for file in inputs], "limitations": ["No registry push/pull or release publication", "No signed attestation/SBOM or legal/source-access approval", "Base materials and installed inventories are review inputs only", "Web/sidecar source identity comes from archive build inputs; they do not self-report release metadata"]})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--metadata-dir", type=pathlib.Path, required=True)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.version != "0.1.0-rc.1" or not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        parser.error("Expected fixed preview version and full source revision")
    try:
        collect(args.arch, args.version, args.revision, args.metadata_dir, args.output, args.source_root)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print("Candidate image evidence is incomplete; no raw command/error output retained.", file=sys.stderr)
        return 1
    print("Candidate native identity and installed-license inputs captured (not a publication approval).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
