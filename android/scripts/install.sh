#!/usr/bin/env bash
# Install the debug APK and relaunch the app. HyperOS shows a "USB install" confirmation that defaults to
# reject after a countdown; tap "continue" (coordinates for the 3200x2136 landscape screen).
set -uo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"
LOG="$(mktemp)"
adb install -r "$APK" > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 40); do
  sleep 1
  if ! kill -0 $PID 2>/dev/null; then break; fi
  if adb shell dumpsys window | grep -q "mCurrentFocus=.*AdbInstallActivity"; then
    sleep 1.2
    adb shell input tap "${CONFIRM_X:-1384}" "${CONFIRM_Y:-1299}"
  fi
done
wait $PID
cat "$LOG"
grep -q Success "$LOG" || exit 1
adb shell am start -n io.github.flufy3d.maalow/.MainActivity > /dev/null
