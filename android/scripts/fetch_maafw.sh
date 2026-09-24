#!/usr/bin/env bash
# Download the MaaFramework Android release into third_party/maafw (headers + arm64 jniLibs).
set -euo pipefail
VERSION="${MAAFW_VERSION:-5.13.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/maafw"
ZIP="$ROOT/third_party/MAA-android-aarch64-v$VERSION.zip"
mkdir -p "$ROOT/third_party"
[ -f "$ZIP" ] || curl -fL -o "$ZIP" "https://github.com/MaaXYZ/MaaFramework/releases/download/v$VERSION/MAA-android-aarch64-v$VERSION.zip"
rm -rf "$DEST" "$DEST.tmp"
mkdir -p "$DEST.tmp" "$DEST/jniLibs/arm64-v8a"
unzip -q "$ZIP" -d "$DEST.tmp"
mv "$DEST.tmp/include" "$DEST/include"
cp "$DEST.tmp/LICENSE.md" "$DEST/"
# libc++_shared is the release's copy, used by opencv/onnxruntime/fastdeploy; the Maa libs themselves use the
# libc++ inside libMaaUtils.so (see app/src/main/cpp/CMakeLists.txt).
for lib in MaaFramework MaaUtils MaaAndroidNativeControlUnit MaaCustomControlUnit opencv_world4 onnxruntime fastdeploy_ppocr c++_shared; do
  cp "$DEST.tmp/bin/lib$lib.so" "$DEST/jniLibs/arm64-v8a/"
done
rm -rf "$DEST.tmp"
echo "$VERSION" > "$DEST/VERSION"
echo "MaaFramework $VERSION -> $DEST"
