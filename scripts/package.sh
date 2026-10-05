#!/usr/bin/env bash
# Builds dist/agent-automation-v<version>.zip containing only the files the extension needs at runtime.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
if [ -z "$version" ]; then
  echo "Could not read the version from manifest.json" >&2
  exit 1
fi

files=(manifest.json background.js sidepanel.html sidepanel.css sidepanel.js src icons LICENSE README.md)
for f in "${files[@]}"; do
  if [ ! -e "$f" ]; then
    echo "Missing required file: $f" >&2
    exit 1
  fi
done

out="dist/agent-automation-v${version}.zip"
mkdir -p dist
rm -f "$out"

zip -r -q -X -D "$out" "${files[@]}" -x '*.DS_Store'

echo "Wrote $(pwd)/$out ($(du -h "$out" | cut -f1 | tr -d '[:space:]'), $(wc -c < "$out" | tr -d '[:space:]') bytes)"
