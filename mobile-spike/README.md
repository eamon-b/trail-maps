# MapLibre Offline Spike

This spike validates that MapLibre GL works with React Native for offline vector tile caching - a critical requirement for the Trail Companion mobile app.

## Purpose

This is a **decision gate** for the mobile app project. Before committing to the React Native approach, we need to verify:

1. MapLibre React Native works with Expo development builds
2. Offline tile packs can be downloaded and stored
3. Storage sizes are acceptable for trail corridors
4. Performance is adequate for offline map rendering

## Prerequisites

### Required Software

- **Node.js**: v18+ (tested with v24.13.0)
- **npm**: v9+ (tested with v11.6.2)

### For iOS Testing

- **macOS** (required for iOS development)
- **Xcode**: 15.0+ with iOS 17 SDK
- **iOS Simulator** or physical iOS device

### For Android Testing

- **Android Studio**: Latest stable (Electric Eel or newer)
- **Android SDK**: API level 24+ (Android 7.0+)
- **Android Emulator** or physical Android device

## Setup

### Step 1: Install Dependencies

```bash
cd mobile-spike/MapLibreSpike
npm install
```

### Step 2: Build the Development Client

MapLibre uses native code, so you **cannot use Expo Go**. You need to build a custom development client that includes the native MapLibre libraries. There are two options:

#### Option A: Local Build (Recommended for Spike)

This builds directly on your machine - faster iteration, no cloud account needed.

**For iOS (requires macOS with Xcode):**
```bash
# Generate native iOS project
npx expo prebuild --platform ios

# Open in Xcode and build
open ios/MapLibreSpike.xcworkspace

# Or build from command line
cd ios && xcodebuild -workspace MapLibreSpike.xcworkspace \
  -scheme MapLibreSpike \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  build
```

**For Android (requires Android Studio):**
```bash
# Generate native Android project
npx expo prebuild --platform android

# Build debug APK
cd android && ./gradlew assembleDebug

# Install on connected device/emulator
adb install app/build/outputs/apk/debug/app-debug.apk
```

#### Option B: EAS Cloud Build

Uses Expo's cloud build service. Good for CI/CD but requires account setup.

```bash
# Install EAS CLI globally
npm install -g eas-cli

# Login to Expo account (create one at expo.dev if needed)
eas login

# Configure EAS for this project
eas build:configure

# Build for iOS simulator (cloud build)
eas build --profile development --platform ios

# Build for Android (cloud build)
eas build --profile development --platform android
```

After the cloud build completes, download and install the app:
- iOS: Drag .app to simulator
- Android: `adb install <downloaded.apk>`

### Step 3: Run the Development Server

```bash
# Start Metro bundler with dev-client flag
npm start
# or
npx expo start --dev-client
```

### Step 4: Connect the App

1. Open the installed development client app on your device/emulator
2. It will automatically connect to the Metro bundler
3. The app should load and show the MapLibre map

## Troubleshooting Build Issues

### iOS Build Fails

1. **CocoaPods issues**: Run `cd ios && pod install --repo-update`
2. **Xcode version**: Ensure Xcode 15+ is installed
3. **Signing**: For simulator builds, no signing is needed

### Android Build Fails

1. **SDK not found**: Set `ANDROID_HOME` environment variable
2. **Gradle issues**: Run `cd android && ./gradlew clean`
3. **NDK issues**: MapLibre may require specific NDK version - check error logs

### Metro Bundler Issues

1. **Cache issues**: Run `npx expo start --clear`
2. **Port conflicts**: Use `npx expo start --port 8082`

## Running the Spike

The app has a tabbed interface for each test phase. Use the phase tabs below the map to switch between phases.

### Phase 1: Verify Map Loads

1. Launch the app on your device/emulator
2. Wait for the map to load - you should see:
   - Blue header with "MapLibre Offline Spike" and a network status badge
   - Map centered on Western Australia
   - Red dashed rectangle showing Bibbulmun Track bounds
   - Log showing "Map loaded successfully"
3. **Record**: Does the map load? Any errors in the log?

### Phase 2: Download Offline Tiles

1. Select the **"2: Download"** tab
2. Tap "Run Zoom Level Tests (10-16)"
3. Monitor the log output - you'll see:
   - Progress percentage for each zoom level
   - Tile count and size when each level completes
4. Wait for all tests to complete (may take several minutes)
5. View results in the table showing tiles/size/time per zoom level
6. Tap "Export Results" to save detailed findings

### Phase 3: Test Offline Rendering

**Critical test - this validates the core requirement:**

1. Select the **"3: Offline"** tab
2. Enable Airplane Mode on your device
3. Wait for the network badge in the header to turn red and show "offline"
4. Tap "Test Offline Rendering" - this will programmatically fly the camera to several trail locations while offline
5. Verify the map renders correctly at each location (Kalamunda, Walpole, overview)
6. Manually pan/zoom within the red bounding box to further verify
7. Tap "Works" or "Broken" to record your finding
8. **Record**: Does offline rendering work? Any tiles missing?

### Phase 4: Measure Storage

1. Select the **"4: Storage"** tab
2. Tap "Measure Storage" to query MapLibre's offline pack sizes
3. View the total storage and per-pack breakdown
4. Also check device storage usage:
   - **iOS**: Settings > General > iPhone Storage > MapLibreSpike
   - **Android**: Settings > Apps > MapLibreSpike > Storage
5. Compare MapLibre-reported sizes with actual device storage
6. **Record**: Actual storage used vs reported

### Phase 5: Performance Testing

1. Select the **"5: Perf"** tab
2. Toggle "FPS" to ON - an FPS counter appears on the map
3. Manually pan/zoom the map to observe interactive framerate
4. Tap "Run Performance Test" to run the automated test:
   - Flies to 10 trail waypoints with varying zoom levels
   - Measures FPS at each location (avg, min, max)
   - Includes zoom-in, zoom-out, and rapid navigation tests
5. Review the results table and overall summary
6. **Record**:
   - Is rendering smooth (>= 30fps)?
   - Any lag or stuttering?
   - Memory warnings?

## What the Spike Tests

### Bibbulmun Track Corridor

The spike downloads offline tiles for the Bibbulmun Track in Western Australia:
- **Start**: Kalamunda (-31.97, 116.06)
- **End**: Albany (-35.03, 117.88)
- **Length**: ~982 km
- **Bounds**: ~3.4° latitude x ~2.2° longitude (with buffer)

### Zoom Levels

Tests each zoom level individually (10-16), plus a cumulative test:

| Zoom | Purpose | Expected Resolution |
|------|---------|---------------------|
| 10 | Regional overview | ~150m per pixel |
| 11 | Area view | ~75m per pixel |
| 12 | Local area | ~38m per pixel |
| 13 | Detailed area | ~19m per pixel |
| 14 | Trail detail | ~9m per pixel |
| 15 | High detail | ~5m per pixel |
| 16 | Maximum detail | ~2m per pixel |

### Metrics Collected

- **Tile count**: Number of tiles downloaded per zoom level
- **Storage size**: Bytes required for each zoom level
- **Download time**: Time to download each pack
- **Total storage**: Combined size for zoom 10-16

## Expected Results

Based on similar trail corridors, rough estimates:

| Zoom | Est. Tiles | Est. Size |
|------|------------|-----------|
| 10 | ~4 | ~50 KB |
| 11 | ~12 | ~150 KB |
| 12 | ~48 | ~600 KB |
| 13 | ~192 | ~2.5 MB |
| 14 | ~768 | ~10 MB |
| 15 | ~3,072 | ~40 MB |
| 16 | ~12,288 | ~150 MB |
| **Total** | **~16,000** | **~200 MB** |

Note: Vector tiles are significantly smaller than raster tiles. Actual results may vary based on tile content and encoding. **See [Actual Results](#actual-results) below — real tile counts were significantly higher than these estimates, and zoom 15-16 are not available from OpenFreeMap.**

## Decision Criteria

### Proceed with React Native if:

- [ ] MapLibre loads and renders correctly on both platforms
- [ ] Offline packs download successfully
- [ ] Total storage for Bibbulmun (z10-16) is under 500 MB
- [ ] Offline map renders without internet connection
- [ ] No significant performance issues observed

### Consider PWA approach if:

- [ ] MapLibre fails to initialize on either platform
- [ ] Offline pack downloads fail consistently
- [ ] Storage requirements exceed 1 GB
- [ ] Severe performance issues make the app unusable

## Known Issues & Limitations

### MapLibre React Native

- Requires development builds (not Expo Go)
- iOS requires minimum deployment target of iOS 13
- Android requires minSdkVersion 24
- The offline API may have slightly different behavior between iOS and Android

### Offline Tiles

- OpenFreeMap tiles used for testing (no API key required)
- Tile availability depends on tile server
- Very large downloads may timeout
- Vector tile size varies based on feature density (urban areas larger)

### Potential Blockers to Watch For

1. **Offline API not working**: If `offlineManager.createPack()` fails, check:
   - Is the style URL accessible?
   - Are bounds in correct format `[[sw_lon, sw_lat], [ne_lon, ne_lat]]`?
   - Is there sufficient device storage?

2. **Tiles not rendering offline**: MapLibre caches style resources separately from tiles. Both must be available for offline rendering.

3. **Memory issues**: Large tile downloads may cause memory pressure. Monitor for crashes.

## Alternative Tile Sources

If OpenFreeMap has issues, try these alternatives:

```typescript
// MapTiler (requires free API key from maptiler.com)
const MAPTILER_STYLE = 'https://api.maptiler.com/maps/outdoor-v2/style.json?key=YOUR_KEY';

// Protomaps (self-hosted option)
const PROTOMAPS_STYLE = 'https://api.protomaps.com/styles/v2/light.json?key=YOUR_KEY';

// Stadia Maps (requires free API key)
const STADIA_STYLE = 'https://tiles.stadiamaps.com/styles/outdoors.json?api_key=YOUR_KEY';
```

Update `STYLE_URL` in `App.tsx` to test different providers.

## Calculating Expected Tile Counts

For planning purposes, tile count at zoom level z for a bounding box:

```
tiles_x = ceil((lon_max - lon_min) / (360 / 2^z))
tiles_y = ceil((lat_max - lat_min) / (180 / 2^z))  // approximate
total_tiles = tiles_x * tiles_y
```

For Bibbulmun Track (3.4° lat x 2.2° lon):
- Zoom 10: ~2 x 2 = 4 tiles
- Zoom 12: ~6 x 8 = 48 tiles
- Zoom 14: ~23 x 35 = 805 tiles
- Zoom 16: ~90 x 140 = 12,600 tiles

## Files

```
MapLibreSpike/
├── App.tsx           # Main spike app with offline testing
├── app.json          # Expo configuration
├── package.json      # Dependencies
└── assets/           # Default Expo assets
```

## Next Steps

After completing the spike:

1. Fill in actual results in this README
2. Document any issues encountered
3. Make go/no-go decision for React Native
4. If proceeding, continue with Part 0 tasks

## Results

### Test Environment

- **Device**: Android emulator
- **Date**: 2026-02-06

### Actual Results

| Zoom | Tiles | Size | Time | Status |
|------|-------|------|------|--------|
| 10 | 91 | 922 KB | 0.2s | Complete |
| 11 | 350 | 1.8 MB | 0.2s | Complete |
| 12 | 1,248 | 4.7 MB | 0.4s | Complete |
| 13 | 4,794 | 9.4 MB | 65.6s | Complete |
| 14 | 18,887 | 26.1 MB | 347.4s | Complete |
| 15 | 0 | 0 | 0.3s | No tiles available |
| 16 | 0 | 0 | 0.2s | No tiles available |
| 10-16 | 25,370 | 42.9 MB | 5.2s | Complete (cached) |

### Observations

- **OpenFreeMap vector tiles max out at zoom 14.** Zoom 15-16 returned zero tiles. This is expected behaviour for vector tile services — the client overzooms by rendering zoom-14 tile data at higher zoom levels. No tiles need to be downloaded beyond zoom 14.
- **Actual tile counts are much higher than the pre-spike estimates.** The bounding box approach downloads tiles for the entire rectangular region, not just the trail corridor. At zoom 14 this means ~19k tiles vs the estimated ~768. A corridor-based download (buffering the actual track geometry by a few km) would dramatically reduce tile counts.
- **Rate limiting / throttling at higher zoom levels.** Zoom 10-12 downloaded in under a second each, but zoom 13 took 65.6s and zoom 14 took 347.4s (~5.8 minutes). The tile count grew ~4x per level (expected), but download time increased disproportionately — suggesting OpenFreeMap throttles bulk downloads.
- **Cumulative download was near-instant (5.2s)** because tiles were already cached from individual-level tests. The tile count (25,370) exactly equals the sum of zoom 10-14, confirming zoom 15-16 contributed nothing.
- **Total storage for full bounding box at zoom 10-14 is ~43 MB** — well within the 500 MB threshold. A corridor-based approach would reduce this further.
- **Vector tiles are smaller than raster equivalents** but tile counts are higher than the simple geometric estimate because the tile server returns tiles for the full bounding box even when some tiles contain minimal data.

### Implications for Mobile App

- **~43 MB per trail (full bounding box)** is acceptable. Corridor-based downloads would be smaller.
- **Rate limiting is a concern for UX.** Options to investigate:
  - Download tiles in smaller geographic batches
  - Use a self-hosted tile server (e.g. Protomaps) for bulk downloads
  - Pre-package tile bundles per trail and host them for direct download
  - Download during trip planning (not on-trail) to allow for longer download times

### Decision

- [x] **PROCEED** with React Native — MapLibre offline tiles work, storage is reasonable, and the core requirement (offline map rendering) is validated.

### Next Spike Items

These require interactive device testing (use the phase tabs in the app):

- [x] Phase 3: Test offline rendering — enable Airplane Mode, use "3: Offline" tab, verify map renders from cache
  - Correctly works. Tiles are rendered as expected.
- [x] Phase 4: Measure storage — use "4: Storage" tab + check device settings, compare reported vs actual
  - 48MB used as expected. The code did not show this but under settings -> apps -> MapLibre Offile Spike showed 97MB of user data
- [x] Phase 5: Performance testing — use "5: Perf" tab, run automated test + manual pan/zoom, record FPS results
  - very performant, stayed above 100FPS for the whole test
