#!/usr/bin/env bash
# Builds the extension for every browser from this one source tree:
#
#   dist/chrome/     Chrome: chrome://extensions → Load unpacked
#   dist/chromium/   Chromium, Edge, Brave, Opera, Vivaldi (the same files as dist/chrome)
#   dist/firefox/    Firefox: about:debugging → This Firefox → Load Temporary Add-on → its manifest.json
#
# and a zip of each: dist/agent-automation-{chrome,chromium,firefox}-v<version>.zip, plus
# dist/agent-automation-firefox-v<version>.xpi (the same archive as the Firefox zip, manifest.json at its root).
#
# The version comes from the root manifest.json. The Firefox build is the shared runtime files without Chrome's
# service worker and offscreen document, plus platform/firefox/ (its manifest.json and background page); the
# Firefox manifest's name, version, description and homepage_url are copied from the root manifest here, so
# they are only ever edited there.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The first "key": "value" line of a JSON file, as the raw (still JSON-escaped) string.
json_string() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\(.*\)\"[[:space:]]*,\{0,1\}[[:space:]]*\$/\1/p" "$2" | head -n 1
}

# Replaces the value of the first "key": "…" line of a JSON file (top-level keys come first in our manifests).
set_json_string() {
  local file=$1 key=$2 value=$3
  KEY="$key" VALUE="$value" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
    !done && $0 ~ ("^[[:space:]]*\"" key "\"[[:space:]]*:[[:space:]]*\"") {
      indent = $0
      sub(/[^[:space:]].*$/, "", indent)
      comma = ($0 ~ /,[[:space:]]*$/) ? "," : ""
      print indent "\"" key "\": \"" value "\"" comma
      done = 1
      next
    }
    { print }
    END { if (!done) exit 3 }
  ' "$file" >"$file.tmp" || {
    rm -f "$file.tmp"
    echo "Could not set \"$key\" in $file" >&2
    exit 1
  }
  mv "$file.tmp" "$file"
}

version=$(json_string version manifest.json)
if [ -z "$version" ]; then
  echo "Could not read the version from manifest.json" >&2
  exit 1
fi

# Runtime files every build needs, and what each platform adds.
common=(sidepanel.html sidepanel.css settings-tools.css sidepanel.js src vendor icons LICENSE README.md)
chrome_files=(manifest.json background.js offscreen.html)
firefox_overlay=platform/firefox

for f in "${common[@]}" "${chrome_files[@]}" "$firefox_overlay/manifest.json" "$firefox_overlay/background.html"; do
  if [ ! -e "$f" ]; then
    echo "Missing required file: $f" >&2
    exit 1
  fi
done

mkdir -p dist
rm -rf dist/chrome dist/chromium dist/firefox
rm -f "dist/agent-automation-chrome-v${version}.zip" "dist/agent-automation-chromium-v${version}.zip" \
  "dist/agent-automation-firefox-v${version}.zip" "dist/agent-automation-firefox-v${version}.xpi"

# Copies files and folders into a build folder, leaving out macOS litter.
stage() {
  local dest=$1
  shift
  mkdir -p "$dest"
  cp -R "$@" "$dest/"
  find "$dest" \( -name .DS_Store -o -name '._*' \) -exec rm -f {} +
}

# Zips a build folder with its files at the root of the archive.
pack() {
  local dir=$1 out=$2
  (cd "$dir" && zip -r -q -X -D "../${out##*/}" .)
}

# Chrome: manifest, service worker and offscreen document from the root. Firefox's entry point is not needed.
stage dist/chrome "${common[@]}" "${chrome_files[@]}"
rm -f dist/chrome/src/engine/firefox.js

# Chromium-based browsers load the Chrome build as it is.
stage dist/chromium dist/chrome/.

# Firefox: no service worker or offscreen document; the engine runs in the background page instead.
stage dist/firefox "${common[@]}" "$firefox_overlay/manifest.json" "$firefox_overlay/background.html"
rm -f dist/firefox/src/engine/offscreen.js
for key in name version description homepage_url; do
  value=$(json_string "$key" manifest.json)
  [ -n "$value" ] || { echo "manifest.json has no \"$key\"" >&2; exit 1; }
  set_json_string dist/firefox/manifest.json "$key" "$value"
  if [ "$(json_string "$key" dist/firefox/manifest.json)" != "$value" ]; then
    echo "Could not copy \"$key\" into the Firefox manifest" >&2
    exit 1
  fi
done
# A syntax check when a JSON parser is at hand (the build itself needs only bash, sed, awk and zip).
if command -v node >/dev/null 2>&1; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' dist/firefox/manifest.json
elif command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' dist/firefox/manifest.json
fi

chrome_zip="dist/agent-automation-chrome-v${version}.zip"
chromium_zip="dist/agent-automation-chromium-v${version}.zip"
firefox_zip="dist/agent-automation-firefox-v${version}.zip"
firefox_xpi="dist/agent-automation-firefox-v${version}.xpi"
pack dist/chrome "$chrome_zip"
pack dist/chromium "$chromium_zip"
pack dist/firefox "$firefox_zip"
cp "$firefox_zip" "$firefox_xpi"

size() { du -sh "$1" | cut -f1 | tr -d '[:space:]'; }
echo "Agent Automation v${version}"
for d in dist/chrome dist/chromium dist/firefox; do
  echo "  $(pwd)/$d/ ($(find "$d" -type f | wc -l | tr -d '[:space:]') files, $(size "$d"))"
done
for z in "$chrome_zip" "$chromium_zip" "$firefox_zip" "$firefox_xpi"; do
  echo "  $(pwd)/$z ($(size "$z"), $(wc -c <"$z" | tr -d '[:space:]') bytes)"
done
