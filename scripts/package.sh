#!/usr/bin/env bash
# Builds every browser version (scripts/build.sh) and also writes the Chrome zip under its old name,
# dist/agent-automation-v<version>.zip, which the install instructions and earlier releases use.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

bash scripts/build.sh

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
out="dist/agent-automation-v${version}.zip"
cp "dist/agent-automation-chrome-v${version}.zip" "$out"

echo "  $(pwd)/$out ($(du -h "$out" | cut -f1 | tr -d '[:space:]'), $(wc -c <"$out" | tr -d '[:space:]') bytes; the Chrome zip under its old name)"
