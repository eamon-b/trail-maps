#!/usr/bin/env bash
set -euo pipefail

# Forward Metro port so emulator can reach the host bundler
adb reverse tcp:8081 tcp:8081

# Start Metro bundler in background (CI=true disables interactive UI)
cd mobile && npx expo start --dev-client --port 8081 &
METRO_PID=$!
cd ..

# Wait for Metro to be ready (up to 120s)
for i in $(seq 1 60); do
  curl -s http://localhost:8081/status 2>/dev/null && break
  sleep 2
done

# Install APK and give the app time to connect + load bundle
adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk
sleep 10

# Run Maestro tests
~/.maestro/bin/maestro test mobile/maestro/
RESULT=$?

kill $METRO_PID 2>/dev/null || true
exit $RESULT
