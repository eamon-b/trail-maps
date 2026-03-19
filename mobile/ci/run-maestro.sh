#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/maestro-screenshots

# Forward Metro port so emulator can reach the host bundler
adb reverse tcp:8081 tcp:8081

# Start Metro bundler in background (CI=true disables interactive UI)
# Use explicit subshell so the cd doesn't affect the parent shell
(cd mobile && npx expo start --dev-client --port 8081) &
METRO_PID=$!

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
  kill $METRO_PID 2>/dev/null || true
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
  -d "exp+trail-maps://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" \
  com.trailcompanion.app

APP_READY=false
for i in $(seq 1 30); do
  if adb shell dumpsys activity activities 2>/dev/null | grep -q trailcompanion; then
    APP_READY=true
    break
  fi
  sleep 1
done
if [ "$APP_READY" = false ]; then
  echo "::error::App failed to launch within 30s"
  adb logcat -d -t 50 ReactNativeJS:* *:E > /tmp/maestro-screenshots/logcat-launch-failure.txt || true
  kill $METRO_PID 2>/dev/null || true
  exit 1
fi

# Wait for the JS bundle to load and the dev menu welcome to appear,
# then dismiss it with a back press so Maestro tests start clean.
sleep 10
adb shell input keyevent KEYCODE_BACK
sleep 2

# Run Maestro tests
~/.maestro/bin/maestro test mobile/maestro/
RESULT=$?

kill $METRO_PID 2>/dev/null || true
exit $RESULT
