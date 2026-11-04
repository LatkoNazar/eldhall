"""support-mcp-import SPEC REVIEW --out MANIFEST [--report REPORT] [--previous OLD_MANIFEST]"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .manifest import build_manifest

MAX_SPEC_BYTES = 5_000_000


def _load(path: str) -> dict:
    file = Path(path)
    if file.stat().st_size > MAX_SPEC_BYTES:
        raise ValueError(f"{path} exceeds {MAX_SPEC_BYTES} bytes")
    data = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a local OpenAPI JSON into a reviewed Eldhall manifest.")
    parser.add_argument("spec")
    parser.add_argument("review", help="deployment-owned review overlay (effect, scope, outputFields, guard ...)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--report")
    parser.add_argument("--previous", help="previously published manifest, for the operation diff")
    args = parser.parse_args(argv)
    try:
        manifest, report = build_manifest(_load(args.spec), _load(args.review), _load(args.previous) if args.previous else None)
    except (OSError, ValueError) as error:
        print(f"import failed: {error}", file=sys.stderr)
        return 1
    Path(args.out).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    for row in report["operations"]:
        print(f"{row['status']:<11} {row['operationKey']}" + (f"  ({row['reason']})" if "reason" in row else ""))
    print("manifestHash", manifest["manifestHash"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
