#!/usr/bin/env bash
# Download the onnxruntime C API header into third_party/onnxruntime, for skills' infer() (app/src/main/cpp/nn_jni.cpp).
# Only the header: the library is MaaFramework's own libonnxruntime.so (fetch_maafw.sh), so the version must match it.
set -euo pipefail
VERSION="${ORT_VERSION:-1.19.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/onnxruntime"
mkdir -p "$DEST"
curl -fL -o "$DEST/onnxruntime_c_api.h" \
  "https://raw.githubusercontent.com/microsoft/onnxruntime/v$VERSION/include/onnxruntime/core/session/onnxruntime_c_api.h"
echo "$VERSION" > "$DEST/VERSION.txt"
echo "onnxruntime $VERSION header -> $DEST"
