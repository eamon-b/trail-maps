#!/usr/bin/env bash
set -euo pipefail

export CI=true

mkdir -p /tmp/maestro-screenshots

# Forward Metro port so emulator can reach the host bundler
adb reverse tcp:8081 tcp:8081

# Start Metro bundler in a new session (setsid) so its process tree is
# detached from the script's process group.  Without this, Metro's child
# node processes become orphans that the GitHub Actions runner waits on
# after the script exits, causing a ~45 min hang until the job timeout.
setsid sh -c 'cd mobile && exec npx expo start --dev-client --port 8081' &

# Wait for Metro to be ready (up to 120s) — fail explicitly if it doesn't start
METRO_READY=false
for i in $(seq 1 60); do
  if curl -s http://localhost:8081/status 2>/dev/null | grep -q running; then
    METRO_READY=true
    break
  fi
  sleep 2
done
if [ "$METRO_READY" = false ]; then
  echo "::error::Metro bundler failed to start within 120s"
  exit 1
fi

# Pre-compile the JS bundle so it's cached before the app requests it.
# Without this, the first app launch triggers bundle compilation which can
# take 30+ seconds on CI, causing Maestro tests to time out.
echo "Pre-compiling JS bundle..."
curl -s "http://localhost:8081/index.bundle?platform=android&dev=true&minify=false" > /dev/null
echo "Bundle compiled."

# Install APK
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk

# Launch the app via deep link to bypass the Expo Dev Launcher screen.
# Dev builds show a launcher UI on plain `am start`; the deep link tells
# the dev client to auto-connect to the Metro bundler.
adb shell am start -a android.intent.action.VIEW \
  -d "exp+tracknotes://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" \
  com.tracknotes.app

APP_READY=false
for i in $(seq 1 30); do
  if adb shell dumpsys activity activities 2>/dev/null | grep -q tracknotes; then
    APP_READY=true
    break
  fi
  sleep 1
done
if [ "$APP_READY" = false ]; then
  echo "::error::App failed to launch within 30s"
  adb logcat -d -t 50 ReactNativeJS:* *:E > /tmp/maestro-screenshots/logcat-launch-failure.txt || true
  exit 1
fi

# Wait for the JS bundle to load and the dev menu welcome to appear,
# then dismiss it with a back press so Maestro tests start clean.
sleep 10
adb shell input keyevent KEYCODE_BACK
sleep 2

# Run Maestro tests — capture exit code so we can clean up Metro before exiting.
# --exclude-tags=quarantine skips flows tagged `quarantine` (e.g.
# custom-waypoint.yaml, whose datasheet assertion is unreliable on long trails);
# passing a single flow file to `maestro test` ignores tags, so those stay
# runnable manually.
MAESTRO_EXIT=0
~/.maestro/bin/maestro test --exclude-tags=quarantine mobile/maestro/ || MAESTRO_EXIT=$?

# On failure, capture diagnostics WHILE the emulator is still alive.  The
# emulator is torn down by the android-emulator-runner action as soon as this
# script exits, so any adb-based capture in a later workflow step runs against
# a dead device and blocks on "waiting for device".  The `timeout 30` guards
# ensure a slow/hung adb can't stall this script, and `|| true` keeps
# `set -e` from aborting before Metro cleanup runs.
if [ "$MAESTRO_EXIT" -ne 0 ]; then
  echo "Maestro failed (exit $MAESTRO_EXIT); capturing diagnostics from live emulator..."
  timeout 30 adb exec-out screencap -p > /tmp/maestro-screenshots/failure.png || true
  timeout 30 adb logcat -d -t 200 'ReactNativeJS:*' '*:E' > /tmp/maestro-screenshots/logcat.txt || true
fi

# Kill Metro and its entire process tree.  Even with setsid, the GitHub
# Actions runner waits for orphan node processes, causing a ~45 min hang.
pkill -f "expo start --dev-client" || true
sleep 2
# Belt-and-suspenders: kill any remaining node processes spawned by Metro
pkill -f "metro-config" || true

exit $MAESTRO_EXIT
