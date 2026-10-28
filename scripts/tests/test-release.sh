#!/usr/bin/env bash
# Run on Linux (including WSL); never talks to a Docker daemon or server.
set -Eeuo pipefail
python3 "$(dirname "${BASH_SOURCE[0]}")/release_cases.py" -v
