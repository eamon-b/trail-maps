# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install            # Install dependencies
npm run dev            # Start Vite dev server (port 5173)
npm run build          # Full production build (climate + trails + TS compile + Vite)
npm run build:trails   # Build trail pages from data/trails/
npm run fetch:climate  # Fetch climate data for trail locations
npm run fetch:elevation # Fetch elevation data
npm run build:tiles    # Build map tiles
npm run fetch:fonts    # Fetch font glyphs for map labels
npm test               # Run all tests with Vitest
npm test -- --watch    # Watch mode
npm run lint           # Run ESLint
npm run preview        # Preview production build locally
```

## Architecture Overview

**Trail Maps** is a TypeScript web application for displaying Australian long-distance hiking trails with interactive maps, elevation profiles, and waypoint data.

### Core Library (`src/lib/`)

Shared processing modules (used by both web and mobile):
- `distance.ts` - Haversine distance calculations
- `gpx-parser.ts` - Parse GPX XML into structured data (browser APIs — NOT safe for mobile)
- `gpx-optimizer.ts` - Track simplification (Douglas-Peucker, browser APIs — NOT safe for mobile)
- `track-classification.ts` - Classify main/alternate/side-trip tracks
- `waypoint-classifier.ts` - Classify waypoint types (town, hut, water, etc.)
- `types.ts` - TypeScript interfaces
- `plan-types.ts` - Plan data types shared with mobile
- `track-geometry.ts` - Nearest-point lookup and elevation gain/loss between km positions
- `day-calculator.ts` - Hiking time estimation and day splitting
- `resupply-calculator.ts` - Town resupply point calculations (incl. food carry weight)
- `water-carry-calculator.ts` - Water carry distance calculations

**Shared calculators:** `track-geometry.ts`, `day-calculator.ts`, `resupply-calculator.ts`, and `water-carry-calculator.ts` are the single implementations used by both web and mobile. Mobile imports them via the `@lib` alias (Metro `watchFolders` + tsconfig paths + Jest `moduleNameMapper`). Parameter types are structural (e.g. `PlanWaypoint`, `PlanStopInput`) so each platform's own trail/waypoint/stop shapes are accepted without conversion. Mobile-only StopData (persisted in SQLite) stays in `mobile/src/services/plan-calculator-types.ts`, which re-exports the shared `SectionConfig`/`ComputedDay`.

### Build Scripts (`scripts/`)

- `build-trails.ts` - Generates static trail pages from GPX/JSON data
- `build-mobile-trails.ts` - Builds mobile-optimized trail JSON (reduced points, truncated precision)
- `build-contours-australia.ts` - Builds contour PMTiles for the contour tile worker
- `fetch-climate.ts` - Fetches historical climate data for trail locations
- `fetch-elevation.ts` - Fetches elevation data
- `fetch-pois.ts` - Fetches points of interest
- `fetch-font-glyphs.ts` - Fetches font glyphs for map label rendering
- `build-tiles.ts` - Builds map tiles for offline use
- `build-grid-tiles.ts` - Builds grid-based map tiles
- `tile-pipeline.ts` - Orchestrates the full tile generation pipeline
- `process-heysen-waypoints.ts` - Trail-specific waypoint data processing

### Web UI (`src/web/`)

- `index.html` - Landing page with trail listing
- `styles.css` - Global styles
- `trails/trail-template.html` - Template for individual trail pages
- `trails/trail-viewer.ts` - Interactive trail viewer (map, elevation profile, waypoints)
- `trails/climate-template.html` - Template for climate data pages
- `trails/plan-template.html` - Template for plan visualization pages
- `trails/plan-viewer.ts` - Interactive plan viewer
- `trails/plan-state.ts` - Plan state management

### Trail Data (`data/trails/`)

Each trail has its own directory containing:
- `*.gpx` - Original GPX track data
- `trail.json` - Trail metadata and waypoints
- `climate.json` - Climate data for locations along the trail

### Generated Data (`public/data/generated/`)

Built at build time:
- `index.json` - Trail index
- `{trail-id}.json` - Processed trail data with simplified tracks

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

### Contour Tile Worker (`workers/contour-tiles/`)

Cloudflare Worker serving contour vector tiles from PMTiles on R2. URL pattern: `/{source}/{z}/{x}/{y}.pbf`. Uses R2 bucket `aus-map-data` with PMTiles at `contours/australia.pmtiles`. Built with `wrangler`.

## Key Patterns

- **Build-time processing**: Trail data is processed at build time into optimized JSON
- **Static site**: All pages are pre-generated, no runtime server required
- **Client-side rendering**: Trail viewer loads JSON data and renders interactively
- **Web maps**: Leaflet with OpenTopoMap tiles for topographic display

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`). Mobile tests use `__tests__/` subdirectories within `components/`, `services/`, `tokens/`, and `lib/`.

```bash
# Mobile tests (from mobile/)
npm test                           # Run all mobile tests (Jest)
npm run test:watch                 # Watch mode
npm run test:integration           # Integration tests only
```

## Mobile App (Expo / React Native)

The mobile app lives in `mobile/`. It uses **Expo SDK 54** with React Native 0.81, the New Architecture, and development builds (not Expo Go) since MapLibre requires custom native code.

### Mobile Commands

```bash
# From the mobile app directory (mobile/)

# Dependencies — ALWAYS use expo install, not npm install, for Expo packages
npx expo install <package>       # Install SDK-compatible package
npx expo install --check         # Check for version mismatches
npx expo install --fix           # Fix version mismatches

# Project health
npx expo-doctor                  # Diagnose project issues
npx expo config --json           # Print resolved app config (verify it parses)
npx tsc --noEmit                 # TypeScript check
npx expo lint                    # ESLint

# Native project generation (Continuous Native Generation)
npx expo prebuild                # Generate ios/ and android/ from config
npx expo prebuild --clean        # Regenerate from scratch (use after plugin changes)

# Building
npx expo export                              # Bundle JS/assets for production
eas build --non-interactive --platform ios    # Cloud build (non-interactive)
eas build --non-interactive --platform android

# OTA updates (JS-only changes, no app store review needed)
eas update --branch production --message "description"

# Dev server (INTERACTIVE — requires human at terminal)
npx expo start --dev-client      # Start Metro + connect to dev client
```

### What Claude Code Can Run vs. What Needs a Human

**Claude Code can run** (non-interactive):
- `npx expo install`, `npx expo prebuild`, `npx expo export`
- `npx expo lint`, `npx expo-doctor`, `npx expo config --json`
- `npx tsc --noEmit`, `npx jest`
- `eas build --non-interactive`, `eas update`
- Android emulator interaction via ADB (see below)
- Maestro UI test flows (see below)

**Needs a human** (interactive or requires device):
- `npx expo start` — interactive terminal UI with hotkeys (user runs this in a separate terminal)
- `eas login` — credential prompts
- First-time iOS cloud build — Apple credential/2FA setup

### Key Expo Concepts

- **Continuous Native Generation (CNG)**: `ios/` and `android/` are generated from `app.json` + config plugins via `npx expo prebuild`. They are build artifacts, not source files. Regenerate with `--clean` after config changes.
- **Config plugins**: Declared in `app.json` `"plugins"` array. They modify native project files during prebuild (e.g. MapLibre adds location permissions automatically).
- **Development builds**: Custom debug apps built via EAS that include your native dependencies. Rebuild only when native deps change; JS changes hot-reload.
- **EAS Build profiles** (`eas.json`): `development` (dev client), `preview` (internal testers), `production` (app store).
- **EAS Update**: OTA JavaScript updates. Only works for JS/styling/image changes — native changes need a new binary build.
- **Expo Router**: File-based routing where files in `app/` become navigation routes. `_layout.tsx` defines navigators, `(groups)/` organize without adding URL segments, `[param].tsx` for dynamic routes.

### Verification After Dependency Changes

When changes affect native dependencies (adding/removing/updating packages, modifying `app.json` plugins), verify with:
1. `npx expo prebuild` — ensures config plugins resolve and native projects generate correctly
2. `eas build --profile development --platform android` — ensures the development build compiles with the updated dependencies

### Common Gotchas

- Always `npx expo install` for Expo packages — ensures SDK-compatible versions
- Run `npx expo prebuild --clean` after changing `app.json` plugins — stale native config is the #1 debugging time-sink
- Clear Metro cache when things are weird: `npx expo start --clear`
- Only env vars prefixed with `EXPO_PUBLIC_` are available in client code
- Expo Router: `_layout.tsx` naming must be exact (not `Layout.tsx` or `layout.tsx`)
- Don't have both `app/foo.tsx` and `app/foo/index.tsx` — they conflict

### Mobile App Architecture

- **Map**: MapLibre React Native with OpenFreeMap vector tiles (offline capable)
- **Storage**: `expo-sqlite` for trail data, `expo-file-system` for tile files
- **Shared code**: `src/lib/` modules shared via Metro `watchFolders` config. Safe modules: distance, track-classification, waypoint-classifier, types, plan-types, track-geometry, variant-reverse, trail-reverse, plan-direction, day-calculator, resupply-calculator, water-carry-calculator. NOT safe (browser APIs): gpx-parser, gpx-optimizer.
- **Navigation**: Three-mode bottom tabs (Plan / Hike / Contribute) via Expo Router
- **Data**: SQLite (`expo-sqlite`) for trails, waypoints, plans. Bundled trail JSON loaded on first launch.

### Mobile Route Structure (`mobile/app/`)

- `_layout.tsx` — Root layout
- `index.tsx` — Entry redirect
- `settings.tsx` — App settings screen
- `(tabs)/` — Bottom tab navigator: `plan.tsx`, `hike.tsx`, `contribute.tsx`
- `trail/` — Trail screens: `overview.tsx` (detail card), `[id].tsx` (map viewer), `datasheet.tsx` (waypoint datasheet)
- `plan/` — Plan screens: `create.tsx`, `[planId].tsx` (edit), `map.tsx`, `section-map.tsx`, `measure.tsx`
- `import/` — GPX import: `index.tsx`

### Mobile Source Structure (`mobile/src/`)

- `components/` — UI components: map (TrailMap, ElevationProfile, ElevationProfileDrawer, MapErrorBoundary), planning (DayPlanCard, StopSelector, SectionSelector, PlanSummaryCard), hike dashboard (HikeDashboard, WaypointList, WaypointCard, WaypointDetailSheet, WaterCountdown, LocationStatusBar, SunriseCountdown), resources (ResupplyList, WaterCarryList, ClimateCard, ClimateOverview), common (Card, AlertBanner, ProgressBar, SkeletonPlaceholder, UndoToast, ModeSelector, AppBottomSheet, haptics)
- `services/` — Business logic: data layer (trail-data-service, trail-loader, trail-bounds), planning (plan-service, plan-utils, plan-export, plan-calculator-types, day-calculator, distance-calculator), resources (resupply-calculator, water-carry-calculator), maps (tile-service, tile-manager, tile-paths, grid-tile-service, online-style-service), other (datasheet-service, custom-trail-service, climate-service, location-service, measure-service, off-trail-alert-service)
- `contexts/` — React contexts (TrailDataContext)
- `db/` — Database layer (database.ts, schema.ts)
- `hooks/` — React hooks (useLocation, useDirectionalTrail, useOffTrailAlert)
- `theme/` — Theme context and utilities
- `tokens/` — Design tokens (colors, typography, spacing, motion)
- `lib/` — Mobile-specific utilities (trail-utils, gpx-parser, gpx-processor, sunrise-sunset)

### Android Emulator (ADB)

An Android emulator (Pixel 7) is available for testing. The user runs Metro dev server (`npx expo start --dev-client`) in a separate terminal. Claude can interact with the emulator via ADB commands.

**Prerequisites**: User must have the emulator running and Metro dev server started before Claude uses these commands.

```bash
adb exec-out screencap -p > /tmp/screenshot.png   # Screenshot (view with Read tool)
adb shell am start -n com.trailcompanion.app/.MainActivity  # Launch app
adb shell am force-stop com.trailcompanion.app     # Force stop
adb shell pm clear com.trailcompanion.app          # Clear app data (fresh state)
adb shell input tap 540 1200                       # Tap at (x, y)
adb shell input swipe 540 1500 540 500 300         # Swipe (x1 y1 x2 y2 ms)
adb shell input keyevent KEYCODE_BACK              # Back button
adb shell input text "hello"                       # Type text
adb logcat -d -t 50 ReactNativeJS:* *:E | grep -v chatty  # Recent RN logs
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk  # Install APK
```

**Visual verification workflow**: Make changes (Metro hot-reloads) → screenshot → Read the PNG → check `adb logcat` for errors.

### Maestro UI Tests

Maestro test flows live in `mobile/maestro/`. Run them to verify UI behavior end-to-end.

```bash
# Run a single test flow
~/.maestro/bin/maestro test mobile/maestro/smoke-test.yaml

# Run all test flows
~/.maestro/bin/maestro test mobile/maestro/

# Record a test (writes a flow YAML from manual interaction)
~/.maestro/bin/maestro record mobile/maestro/new-flow.yaml
```

**Key flows**: `smoke-test.yaml` (full smoke), `app-launch.yaml`, `navigate-tabs.yaml`, `view-trail.yaml`, `trail-overview-details.yaml`, `trail-overview-to-map.yaml`, `deep-back-navigation.yaml`, `plan-creation.yaml`, `plan-editing.yaml`, `measure-tool.yaml`, `gpx-import-screen.yaml`, `manage-custom-trail.yaml`. Run `ls mobile/maestro/` for the full list (~20 flows).
