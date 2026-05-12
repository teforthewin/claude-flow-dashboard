#!/usr/bin/env bash
# Build the LoomScope Electron app inside Docker and copy artefacts to dist-linux/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p dist-linux

echo "==> Building LoomScope Electron artefacts (Linux) inside Docker..."
docker compose --profile build run --rm loomscope-build

echo ""
echo "==> Done. Artefacts written to dist-linux/:"
ls -lh dist-linux/
