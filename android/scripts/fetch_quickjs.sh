#!/usr/bin/env bash
# Download the quickjs-ng sources into third_party/quickjs-ng (compiled into libmaalow_js.so by CMake).
set -euo pipefail
VERSION="${QUICKJS_VERSION:-0.17.0}"
SHA256="${QUICKJS_SHA256:-559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/quickjs-ng"
TGZ="$ROOT/third_party/quickjs-ng-v$VERSION.tar.gz"
mkdir -p "$ROOT/third_party"
[ -f "$TGZ" ] || curl -fL -o "$TGZ" "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  $TGZ" | sha256sum -c -
rm -rf "$DEST" "$DEST.tmp"
mkdir -p "$DEST.tmp"
tar -xzf "$TGZ" -C "$DEST.tmp"
mkdir -p "$DEST"
for f in LICENSE *.c *.h; do
  cp "$DEST.tmp/quickjs-$VERSION/"$f "$DEST/" 2>/dev/null || true
done
rm -rf "$DEST.tmp"
echo "$VERSION" > "$DEST/VERSION.txt" # not VERSION: on a case-insensitive disk it would shadow <version>
echo "quickjs-ng $VERSION -> $DEST"
