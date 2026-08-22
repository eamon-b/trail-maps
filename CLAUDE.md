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

**Trail Maps** is a TypeScript web application for displaying Australian long-distance hiking trails with interactive maps, elevation profiles, and waypoint data. The repo also contains **Tracknotes**, the companion Expo/React Native mobile app (`mobile/` — see Mobile App section).

### Core Library (`src/lib/`)

Shared processing modules (used by both web and mobile):
- `distance.ts` - Haversine distance calculations
- `gpx-parser.ts` - Parse GPX XML into structured data; `parseGpx(xml, adapter?, limits?)` is platform-neutral (see XML adapters below) and parses coordinates strictly (throws instead of plotting 0,0)
- `xml-adapter.ts` - Minimal XML node interface (`querySelectorAll`/`querySelector`/`getAttribute`/`textContent`, tag selectors only) + the DOMParser adapter
- `xml-adapter-fxp.ts` - fast-xml-parser adapter (the React Native path — Hermes has no DOMParser)
- `gpx-optimizer.ts` - Track simplification (Douglas-Peucker), elevation spike removal/smoothing, elevation stats
- `track-simplify.ts` - Target-point-count simplification + coordinate truncation (the mobile point budget)
- `track-classification.ts` - Classify main/alternate/side-trip tracks
- `waypoint-classifier.ts` - Classify waypoint types (town, hut, water, etc.)
- `trail-types.ts` - Shared `ProcessedTrail` / `TrackData` / `EnrichedWaypoint` / `RouteVariant` / `TrailConfig` — the shape of `public/data/generated/{id}.json`
- `trail-ingest.ts` - `buildTrail(gpx, options)`: the whole GPX → `ProcessedTrail` pipeline (route selection, cumulative distance, display simplification, waypoint enrichment, variant junctions, off-trail split), with hooks for the build script's file-system/registry concerns
- `gpx-import.ts` - `importGpx(xmlText, options)`: runtime import for user-supplied GPX (elevation cleaning on, `u_`/`uw_` synthetic ids, `ImportReport`)
- `track-simplify.ts` - `simplifyToTarget`/`truncatePoints` point-budget simplification (used by `build-mobile-trails.ts` and imports)
- `elevation-backfill.ts` - Open-Elevation backfill for GPX without `<ele>` (`backfillElevation` batches of 100, ≤2000 samples interpolated by distance; `applyElevation` re-derives ascent/waypoint stats via `recomputeTrailElevation`); `trailHasElevation`/`trailElevationIsUsable` drive the "distance-only estimate" labels
- `trail-handoff.ts` - `<slug>.tracknotes.json` web → mobile handoff format (`wrapTrailForHandoff`, strict `parseHandoffJson`)
- `types.ts` - TypeScript interfaces
- `plan-types.ts` - Plan data types shared with mobile
- `track-geometry.ts` - Nearest-point lookup and elevation gain/loss between km positions
- `day-calculator.ts` - Hiking time estimation and day splitting
- `resupply-calculator.ts` - Town resupply point calculations (incl. food carry weight)
- `water-carry-calculator.ts` - Water carry distance calculations

**XML adapters:** GPX parsing is injected, not hard-wired, so one parser serves three runtimes. `parseGpx` defaults to `DOMParser` (web); build scripts pass `jsdomXmlAdapter` (`scripts/lib/xml-adapter-jsdom.ts` — jsdom must never reach `src/lib`); mobile passes `fxpXmlAdapter` (`src/lib/xml-adapter-fxp.ts`). A parity test (`src/lib/xml-adapter.test.ts`) asserts the fast-xml-parser and DOMParser backends produce deep-equal `GpxData` for every fixture.

**Ingestion is shared, not forked:** `scripts/build-trails.ts` and `importGpx` both call `buildTrail`, so a GPX file produces the same trail in the build, on the web and on the phone. The build script keeps only what needs a file system: CalTopo GeoJSON, the CSV waypoint fallback, climate, curated descriptions, the `data/waypoint-ids.json` registry, and HTML generation — each passed in as a hook. Any change to `trail-ingest.ts` must leave `public/data/generated/*.json` byte-identical unless the change is intentional.

**Shared calculators:** `track-geometry.ts`, `day-calculator.ts`, `resupply-calculator.ts`, and `water-carry-calculator.ts` are the single implementations used by both web and mobile. Mobile imports them via the `@lib` alias (Metro `watchFolders` + tsconfig paths + Jest `moduleNameMapper`). Parameter types are structural (e.g. `PlanWaypoint`, `PlanStopInput`) so each platform's own trail/waypoint/stop shapes are accepted without conversion. On mobile the Plan screen is a live calculator (nothing persisted except pace + daily hours per trail); the adapters live in `mobile/src/features/plan/plan-adapters.ts`.

### Build Scripts (`scripts/`)

- `build-trails.ts` - Generates static trail pages + `public/data/generated/*.json` from GPX/JSON data; the geometry work lives in `@lib/trail-ingest` (`buildTrail`) — this script only supplies the file-system pieces (config, CalTopo GeoJSON, CSV fallback, climate, curated descriptions, waypoint-id registry) and writes the output
- `build-mobile-trails.ts` - Builds mobile-optimized trail JSON (reduced points, truncated precision)
- `build-contours-australia.ts` - Builds contour PMTiles for the contour tile worker
- `build-contours-world.ts` - Builds world contour shards from Copernicus GLO-30 DEM, `--join` merges shards to world.pmtiles (spec: `plans/world-contour-tiles.md`)
- `fetch-dem-copernicus.ts` - Downloads Copernicus GLO-30 DEM tiles (global, anonymous, per bbox/cells/shard)
- `contour-experiment.ts` - Contour quality experiment harness: settings-matrix builds + side-by-side compare viewer (`npm run experiment:contours`)
- `lib/world-grid.ts` - Global 2° cell grid, shard partition, Copernicus tile naming
- `lib/xml-adapter-jsdom.ts` - jsdom `XmlAdapter` for `parseGpx` (kept out of `src/lib` so jsdom never enters the mobile bundle)
- `remote/` - Remote-machine world build: bootstrap, detached shard driver, status, R2 upload (runbook: `docs/world-contours-remote-build.md`)
- `fetch-climate.ts` - Fetches historical climate data for trail locations
- `fetch-elevation.ts` - Fetches elevation data
- `fetch-pois.ts` - Fetches points of interest
- `fetch-font-glyphs.ts` - Fetches font glyphs for map label rendering
- `build-tiles.ts` - Builds map tiles for offline use
- `build-grid-tiles.ts` - Builds grid-based map tiles
- `tile-pipeline.ts` - Orchestrates the full tile generation pipeline
- `process-heysen-waypoints.ts` - Trail-specific waypoint data processing
- `upload-descriptions.ts` - PUTs curated waypoint descriptions to the comments API (`npm run upload:descriptions`, admin token in `$TRACKNOTES_ADMIN_TOKEN`; `--dry-run` prints the requests)

### Web UI (`src/web/`)

- `index.html` - Landing page with trail listing
- `styles.css` - Global styles
- `trails/trail-template.html` - Template for individual trail pages
- `trails/trail-viewer.ts` - Interactive trail viewer (map, elevation profile, waypoints)
- `trails/climate-template.html` - Template for climate data pages
- `trails/plan-template.html` - Template for plan visualization pages
- `trails/plan-viewer.ts` - Interactive plan viewer
- `trails/plan-state.ts` - Plan state management
- `upload.html` / `upload.ts` - User GPX import: drag-drop → `importGpx` → report (+ optional elevation backfill) → IndexedDB
- `my-trail.html` / `my-plan.html` (+ `.ts`) - Trail/plan pages for imported trails, booted from `?id=` via `imported-trails-db.ts` and the viewers' `preloadedTrail` argument; "Export for Tracknotes" handoff
- `imported-trails-db.ts` - IndexedDB store (`tracknotes-imports`) for imported `ProcessedTrail`s; `index.html` lists them under "My trails"
- `web-utils.ts` - `escapeHtml`, `getQueryParam` — every user-supplied string (trail names) must go through `escapeHtml`

### Trail Data (`data/trails/`)

Each trail has its own directory containing:
- `*.gpx` - Original GPX track data
- `trail.json` - Trail metadata and waypoints
- `climate.json` - Climate data for locations along the trail
- `descriptions.json` - Optional curated waypoint descriptions, keyed by the stable ids in `data/waypoint-ids.json`. `build-trails.ts` applies them to the bundled trail JSON (overriding any GPX/GeoJSON text); `upload-descriptions.ts` pushes the same file to the comments API, where mobile syncs it as an override (`synced ?? bundled`). See `scripts/lib/waypoint-descriptions.ts`.

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

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`). Mobile tests (Jest) live in `__tests__/` subdirectories colocated with source across `mobile/src/` (`api/`, `db/`, `features/*/`, `hooks/`, `services/`, `state/`, `sync/`, `tokens/`).

```bash
# Mobile tests (from mobile/)
npm test                           # Run all mobile tests (Jest)
npm run test:watch                 # Watch mode
npm run typecheck                  # tsc --noEmit
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
- **EAS Build profiles** (`eas.json`): `base` (shared env), `development` (dev client), `development-device` (dev client on a physical device), `preview` (internal testers), `production` (app store).
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

### Mobile Environment Variables

`EXPO_PUBLIC_*` vars are inlined by Metro at bundle time from `mobile/.env.local` — **restart Metro after changing them** (hot reload won't pick them up). The env block in `eas.json` applies only to EAS cloud builds, NOT to local Metro bundles, so each var must also be in `.env.local` for local dev. All three are non-secret public URLs (they ship in the client bundle):

```
# Comments API (local wrangler dev server, or the deployed worker URL)
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787   # deployed: https://api.contour-map-tiles.net

# Contour vector tiles — without this, online maps silently render without contours
EXPO_PUBLIC_CONTOUR_TILE_URL=https://tiles.contour-map-tiles.net

# Offline map tile downloads — without this, the Offline Maps screen disables downloads
EXPO_PUBLIC_TILE_BASE_URL=https://data.contour-map-tiles.net
```

### Mobile App Architecture

The app is named **Tracknotes** (`app.json` name/slug `tracknotes`, package `com.tracknotes.app`, URL scheme `tracknotes://`).

- **Map**: MapLibre React Native. Style objects are resolved before mount via `src/services/online-style-service.ts` (online) or `tileManager.getOfflineStyle()` (offline); the bundled base style is `mobile/assets/topo-style.json`, synced from `scripts/topo-style.json` with root `npm run sync:style`. Contours come from `EXPO_PUBLIC_CONTOUR_TILE_URL`.
- **Storage**: trail content is read from bundled JSON assets via `src/services/trail-loader.ts` (`listTrails`/`getTrailJson`) — there is no `trails` SQLite table. SQLite (`expo-sqlite`) holds per-guide state, comments + outbox, favorites, and custom routes. Tile files live in `expo-file-system`.
- **Shared code**: `src/lib/` (repo root) modules imported via `@lib`. Currently used: format-distance, comments-api-types, track-geometry, plan-types, day-calculator, resupply-calculator, water-carry-calculator, distance, types, trail-reverse, trail-types, gpx-import, xml-adapter-fxp. Every `src/lib` module is RN-safe: `gpx-parser`/`gpx-optimizer` no longer reach for `DOMParser` (mobile passes `fxpXmlAdapter`), and `gpx-import` avoids `crypto` entirely. jsdom stays out of `src/lib` — its adapter lives in `scripts/lib/xml-adapter-jsdom.ts`.
- **Navigation**: a single Expo Router Stack — "My Guides" list → per-trail guide (nested stack). No bottom tabs. Inside a guide, a segmented control switches three always-mounted panes: Map | Elevation | List (`src/features/guide/GuideView.tsx`).
- **State**: Zustand stores in `src/state/` (settings, downloads, favorites, identity) plus per-guide React contexts.

### Mobile Route Structure (`mobile/app/`)

- `_layout.tsx` — Root Stack (ThemeProvider, GestureHandlerRootView)
- `index.tsx` — "My Guides" home: bundled trails (download badges) + imported ones ("Imported" badge, long-press to delete); ＋ header action picks a GPX
- `settings.tsx` — App settings (units, display name)
- `import.tsx` — Modal: review a picked GPX (name, counts, warnings) then save it as a guide
- `guide/[trailId]/_layout.tsx` — Per-trail guide stack, wrapped in `GuideProvider` + `GuidePositionProvider`; header actions for Routes / Plan / Offline maps / Settings
- `guide/[trailId]/index.tsx` — Guide home: renders `GuideView` (Map | Elevation | List panes)
- `guide/[trailId]/downloads.tsx` — Offline maps: download/delete tile packs
- `guide/[trailId]/plan.tsx` — Live plan calculator (day splits, resupply, water carries)
- `guide/[trailId]/routes.tsx` — Saved custom routes (built on the map pane)
- `guide/[trailId]/waypoint/[waypointId].tsx` — Waypoint detail + offline-first comments

### Mobile Source Structure (`mobile/src/`)

Feature-sliced: UI lives with its feature, not in a global components dir.

- `features/` — one dir per feature, each with colocated `__tests__/`:
  - `guide/` — GuideView shell, waypoint list pane, contexts (GuideContext, GuidePositionContext), direction toggle, distance strip
  - `map/` — MapPane, GuideMap, map styles/geojson, waypoint icons, track legend, error boundary
  - `elevation/` — Skia elevation profile (axis, geometry, LOD)
  - `plan/` — plan inputs card, day-split list, resupply/water-carry cards, `plan-adapters.ts` (bridges to `@lib` calculators), `plan-inputs-store.ts`
  - `routes/` — route builder bar, route geometry, routes store
  - `comments/` — composer, display name, photo upload
  - `import/` — `import-gpx.ts`: document picker → read file → `@lib/gpx-import` (fast-xml-parser adapter) or `@lib/trail-handoff` for `.tracknotes.json` → persist; `elevation-backfill-flow.ts`; `incoming-file.ts` (Android `ACTION_VIEW` / iOS document-type "open with" → stage into cache → `/import` modal; `ACTION_SEND` payloads are not yet read — needs a native `EXTRA_STREAM` reader). Intent filters / document types live in `app.json` and need a new dev build
  - `settings/`, `share/` — display-name section; check-in sharing
- `api/` — comments API client (device auth, typed fetch wrapper, uuid via `globalThis.expo.uuidv4`)
- `db/` — SQLite layer: `database.ts`, `schema.ts`, and repos (comments, favorites, outbox, routes, imported-trails)
- `sync/` — comment sync engine, connectivity watcher, sync events
- `state/` — Zustand stores: settings, downloads, favorites, identity
- `services/` — trail-loader/assets/bounds (bundled + imported: `loadTrail`, `listAllTrails`, `isServerKnown`), imported-trail-store (JSON at `Paths.document/trails/{id}.json` + `imported_trails` registry row), server-trails (`isServerKnown` — comment sync and the composer are gated off for `u_` ids, so no request ever carries an imported trail id), offline-pack-resolver (an import whose bbox sits inside a bundled trail's coverage borrows that pack; otherwise offline maps are unavailable), tile-service/manager/paths, online-style-service, location-service, position-on-trail, distance-calculator (Naismith ETA)
- `hooks/` — `useLocation` (GPS + trail snapping), `useGuidePosition`
- `theme/` — ThemeContext, reduce-motion hook
- `tokens/` — design tokens (colors, themes, typography, spacing, motion); raw palette is import-restricted and lint-enforced (`mobile/lint/design-token-restrictions.js`)

### Android Emulator (ADB)

An Android emulator (Pixel 7) is available for testing. The user runs Metro dev server (`npx expo start --dev-client`) in a separate terminal. Claude can interact with the emulator via ADB commands.

**Prerequisites**: User must have the emulator running and Metro dev server started before Claude uses these commands.

```bash
adb exec-out screencap -p > /tmp/screenshot.png   # Screenshot (view with Read tool)
# Launch the dev build INTO the JS app (a plain `am start` lands on the Expo Dev Launcher)
adb shell am start -a android.intent.action.VIEW -d "tracknotes://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" com.tracknotes.app
adb shell am force-stop com.tracknotes.app         # Force stop
adb shell pm clear com.tracknotes.app              # Clear app data (fresh state)
adb shell input tap 540 1200                       # Tap at (x, y)
adb shell input swipe 540 1500 540 500 300         # Swipe (x1 y1 x2 y2 ms)
adb shell input keyevent KEYCODE_BACK              # Back button
adb shell input text "hello"                       # Type text
adb logcat -d -t 50 ReactNativeJS:* *:E | grep -v chatty  # Recent RN logs
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk  # Install APK
```

**Visual verification workflow**: Make changes (Metro hot-reloads) → screenshot → Read the PNG → check `adb logcat` for errors.

### Maestro UI Tests

Maestro test flows live in `mobile/maestro/`. They run locally against the emulator + Metro (no CI job — the Maestro CI workflow was removed 2026-08).

```bash
# Run a single test flow
~/.maestro/bin/maestro test mobile/maestro/app-launch.yaml

# Record a test (writes a flow YAML from manual interaction)
~/.maestro/bin/maestro record mobile/maestro/new-flow.yaml
```

**Flows**: `app-launch.yaml` (launch → "My Guides"), `plan-screen.yaml` (guide → Plan → day splits/water carries). Both start via `shared/launch-dev.yaml`, which deep-links the dev client into Metro — don't run `maestro test mobile/maestro/` on the directory, since that would execute the shared launcher as a standalone flow.
