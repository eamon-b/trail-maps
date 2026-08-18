# Part 4a: GPX Processing Engine

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

## Goal
Port the existing build-time GPX processing pipeline to work at runtime in React Native, producing the same data structures that built-in trails use.

This is the foundational piece for custom trail support. It runs independently of any UI — it takes raw GPX bytes in and produces a processed trail object out.

## Background

The existing pipeline lives in:
- `scripts/build-trails.ts` (1,197 lines) — full orchestration
- `src/lib/gpx-parser.ts` (134 lines) — XML parsing via `DOMParser` + `querySelectorAll`
- `src/lib/gpx-optimizer.ts` (634 lines) — Douglas-Peucker, elevation smoothing, spike detection
- `src/lib/track-classification.ts` (307 lines) — main/alternate/side-trip classification
- `src/lib/waypoint-classifier.ts` (244 lines) — 14 waypoint types
- `src/lib/distance.ts` — Haversine calculations

Of these, `track-classification.ts`, `waypoint-classifier.ts`, and `distance.ts` are pure math/string logic and already React Native safe. The parser and optimizer use browser DOM APIs (`DOMParser`, `querySelectorAll`) that don't exist in React Native.

## Deliverables

### 1. React Native GPX Parser
Replace `DOMParser`-based parsing with `fast-xml-parser` (JSON tree output).

- Install `fast-xml-parser` via `npx expo install`
- Create `mobile/src/lib/gpx-parser.ts` that produces the same output types as `src/lib/gpx-parser.ts`
- Extract tracks (with segments), waypoints, metadata
- Handle common GPX variations:
  - Single `<trk>` with multiple `<trkseg>`
  - Multiple `<trk>` elements
  - Waypoints as `<wpt>` (standard) and as `<rtept>` (route points)
  - GPX 1.0 vs 1.1 differences
  - Missing `<ele>` elements (elevation optional)
  - Extensions from Garmin, Strava, etc. (ignore gracefully)
- **File size limit:** 50MB max — reject larger files before parsing
- Clear error on non-GPX XML or non-XML input

### 2. Track Processing (MVP Scope)
Port the optimizer algorithms, simplified for MVP:

- Douglas-Peucker simplification with configurable tolerance
- Elevation spike detection and smoothing (moving average)
- Direction detection and normalization
- Gap handling and track segment merging
- Coordinate rounding for storage efficiency
- **MVP simplification:** Treat all tracks as main route (concatenate in order)
- *Deferred to v2:* Track classification (main/alternate/side-trip), variant junction detection

### 3. Waypoint Processing
- Waypoint-to-track matching (hysteresis-based snapping from existing code)
- Waypoint classification using `waypoint-classifier.ts` (already RN-safe)
- Cumulative distance and elevation calculation for each waypoint
- Handle waypoints that don't snap to track (orphaned waypoints — include with warning)

### 4. Processing Orchestrator
A single function that ties it all together:

```typescript
async function processGpx(gpxBytes: ArrayBuffer, options?: ProcessingOptions): Promise<ProcessedTrail>
```

- Takes raw GPX bytes, returns the same `Trail` / processed structure used by built-in trails
- Reports progress via callback: `onProgress?: (stage: string, percent: number) => void`
- Runs on background thread via `react-native-background-actions` or `expo-task-manager`
- Target: <30s for files under 10MB on mid-range devices

### 5. Error Handling
Processing-level errors (not UI — that's Part 4b):

- Invalid XML → clear error with line number if possible
- Not a GPX file → "This doesn't appear to be a GPX file"
- No tracks found → "GPX file has no track data"
- Missing elevation → proceed without elevation data, flag in result
- Clearly wrong elevation (spikes) → auto-smooth, flag in result
- Invalid coordinates (outside +-90/180) → skip bad points, flag in result
- Duplicate consecutive points → deduplicate silently
- Track gaps >500m → merge with gap marker, flag in result
- No waypoints → proceed (trail usable without POI markers), flag in result
- File too large (>50MB) → reject before parsing

Return a `ProcessingResult` that includes both the processed trail and a list of warnings/issues encountered.

## Testing Strategy

### Unit Tests
- Parser tests against real GPX exports from: Gaia GPS, AllTrails, Strava, Garmin Connect, CalTopo
- Parity tests: run same GPX through both the Node build pipeline and the new mobile pipeline, compare output structures
- Edge case tests: empty tracks, single point, huge files (10MB+), no elevation, no waypoints
- Malformed input tests: truncated XML, HTML instead of GPX, binary file

### Performance Tests
- Benchmark processing time on representative GPX files (1MB, 5MB, 10MB)
- Memory profiling to ensure no crashes on older devices
- Verify background thread doesn't block UI

## Success Criteria
- Produces equivalent output to `build-trails.ts` for simple single-track GPX files
- Processing completes in <30s for files under 10MB
- Memory usage stays under 200MB during processing
- All error cases produce a clear, actionable message
- Tested with real exports from Gaia, AllTrails, Strava, Garmin

## Dependencies
- Part 0: Foundation & Project Setup (shared library structure, Metro watchFolders)

## Notes
- This part has zero UI. It's a pure data processing library with tests.
- The key risk is the `DOMParser` → `fast-xml-parser` rewrite. The parser uses DOM traversal (`querySelectorAll`, `getAttribute`) throughout, and the replacement works with a JSON tree. This is a structural rewrite, not a find-and-replace.
- The optimizer's core algorithms (Douglas-Peucker, elevation smoothing) are pure math and port directly. Only the entry point that calls the parser needs changing.
- Consider writing the parser with an adapter pattern so the same processing code can work with both DOM and JSON tree inputs (useful for keeping the web build working too).
