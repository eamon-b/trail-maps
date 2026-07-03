# Mobile App Testing Improvement Plan

## Context

The mobile app has 44% overall test coverage — web library code is at 100%, but mobile services are at 61%, components at 33%, and critical services like tile management, GPS tracking, and distance calculations have zero tests. The existing tests mock the database entirely, so schema/query bugs go undetected. Maestro E2E flows only cover navigation; no plan creation, editing, or import workflows are tested.

This plan adds ~139 test cases across 4 independent phases, targeting the highest-value gaps first.

---

## Phase 1: Unit Tests for Untested Services

6 new test files, ~62 test cases. No new dependencies.

**Run:** `cd mobile && npx jest --testPathPattern="__tests__/(distance-calculator|plan-utils|tile-service|grid-tile-service|tile-manager|location-service)"`

### 1.1 `mobile/src/services/__tests__/distance-calculator.test.ts`

All 3 exported functions are pure math — no mocks needed. Reuse `makeTrackPoints`/`makeWaypoints` factory pattern from `day-calculator.test.ts`.

**Source:** `mobile/src/services/distance-calculator.ts` (97 lines)
**Dependency:** `findNearestByDistance` from `mobile/src/lib/trail-utils.ts` (also pure)

```
describe('calculateElevationBetween')
  - ascending segment → positive gain, zero loss
  - descending segment → zero gain, positive loss
  - mixed terrain → both gain and loss
  - reversed start/end (startKm > endKm) → same result via min/max
  - single-point range → {0, 0}
  - empty trackPoints → {0, 0}
  - rounds to integers

describe('calculateDistancesToWaypoints')
  - returns only waypoints ahead of currentKm
  - correct trailDistanceKm for each waypoint
  - includes elevation gain/loss per waypoint
  - empty when no waypoints ahead
  - treats missing totalDistance as 0

describe('getNextWaypointsByType')
  - returns first campsite, water, town, shelter
  - maps water-tank → water key
  - maps hut → shelter key
  - ignores unrecognized types (e.g. "poi")
  - returns empty object when nothing ahead
```

~18 test cases.

### 1.2 `mobile/src/services/__tests__/plan-utils.test.ts`

**Source:** `mobile/src/services/plan-utils.ts` (28 lines)

```
describe('generateId')
  - returns non-empty string
  - returns unique values on repeated calls
  - falls back to hex when crypto.randomUUID unavailable
    (temporarily set globalThis.crypto.randomUUID = undefined, restore in afterEach)

describe('migrateStopsJson')
  - null input → empty array
  - preserves existing fields
  - backfills missing id with generated value
  - backfills missing waypointName to null
  - preserves existing id and waypointName
  - throws on invalid JSON
```

~9 test cases.

### 1.3 `mobile/src/services/__tests__/tile-service.test.ts`

**Source:** `mobile/src/services/tile-service.ts` (568 lines)

Mock `expo-file-system` (`File`, `Directory`, `Paths`) and `expo-asset` at module level. Focus on pure/semi-pure functions.

```
describe('buildTopoStyle')
  - returns MapLibre style object with version: 8
  - includes basemap and contour sources with mbtiles:// URLs containing trailId
  - includes glyphs URL from provided glyphsPath
  - has expected layer types (background, fill, line, symbol)

describe('getTrailTileStatus')
  - returns complete: false when no files exist
  - returns complete: true when both base + contours exist with size > 1000
  - returns complete: false when one file missing
  - correct totalSizeBytes summing file sizes

describe('deleteTrailTiles')
  - calls directory.delete() on the trail's tile directory
```

~10 test cases.

### 1.4 `mobile/src/services/__tests__/grid-tile-service.test.ts`

**Source:** `mobile/src/services/grid-tile-service.ts` (299 lines)

`resolveGridCells` is pure math — test thoroughly. `fetchGridIndex` needs `fetch` mock + fake timers for cache.

```
describe('resolveGridCells')
  - bounds fitting one grid cell → returns 1 cell
  - bounds spanning multiple cells → returns all overlapping cells
  - negative latitudes (Australian coords like -35)
  - empty when no index cells match
  - single-point bounds (degenerate)

describe('fetchGridIndex')
  - fetches from network on first call (mock global fetch)
  - returns cached result on subsequent calls
  - refetches after cache expiry (jest.useFakeTimers)
  - throws on non-OK response

describe('clearGridIndexCache')
  - forces next call to refetch
```

~11 test cases.

### 1.5 `mobile/src/services/__tests__/tile-manager.test.ts`

**Source:** `mobile/src/services/tile-manager.ts` (86 lines)

Mock the entire `tile-service` module since `TileManager` is a thin wrapper.

```
describe('TileManager')
  - isTrailDownloaded → delegates to getTrailTileStatus().complete
  - getTrailStatus → delegates to getTrailTileStatus
  - getDownloadedTrails → empty when no tiles dir; filters to complete trails
  - getOfflineStyle → null when not downloaded; provisions glyphs + returns style when downloaded
  - getTotalStorageUsed → sums sizes across all downloaded trails
```

~8 test cases.

### 1.6 `mobile/src/services/__tests__/location-service.test.ts` (lowest priority)

**Source:** `mobile/src/services/location-service.ts` (157 lines)

Almost all functions wrap `expo-location`. Only test the subscriber logic and permission mapping.

```
describe('subscribeToBackgroundLocation')
  - returns unsubscribe function
  - no leaked subscribers after unsubscribe

describe('requestLocationPermission')
  - returns granted/denied based on expo-location response

describe('stopLocationTracking')
  - removes subscription when active
  - no-op when no subscription
```

~6 test cases.

---

## Phase 2: Integration Tests with Real SQLite

1 adapter + 1 helper + 3 test files, ~32 test cases. Requires `better-sqlite3` dev dependency.

**Run:** `cd mobile && npx jest --testPathPattern="integration"`

### 2.1 Install dependency

```bash
cd mobile && npm install --save-dev better-sqlite3 @types/better-sqlite3
```

### 2.2 SQLite test adapter

**File:** `mobile/src/db/__tests__/sqlite-test-adapter.ts`

Wraps `better-sqlite3` in-memory DB to match the `expo-sqlite` `SQLiteDatabase` interface:
- `runAsync(sql, params?)` → `{ changes, lastInsertRowId }`
- `getFirstAsync<T>(sql, params?)` → `T | null`
- `getAllAsync<T>(sql, params?)` → `T[]`
- `execAsync(sql)` → execute raw multi-statement SQL (used by migrations)
- `closeAsync()` → close DB

Key: `execAsync` must handle multi-statement SQL blocks (the migration strings contain multiple CREATE TABLE + CREATE INDEX statements separated by semicolons). `better-sqlite3`'s `exec()` supports this natively.

### 2.3 Test helper

**File:** `mobile/src/db/__tests__/test-helpers.ts`

```typescript
export async function createMigratedTestDb() {
  const db = createTestDatabase();
  await migrateDatabase(db as any);
  return db;
}
```

### 2.4 Schema integration tests

**File:** `mobile/src/db/__tests__/integration/schema-integration.test.ts`

```
describe('schema migrations')
  - fresh migration (0 → 4) creates all 5 tables
  - schema_version contains version 4
  - partial migration (2 → 4) works
  - idempotent: calling migrate twice doesn't error
  - v4 columns exist (is_custom, source_filename, track_data_json)

describe('constraints')
  - FK: waypoint with invalid trail_id fails
  - FK: plan with invalid trail_id fails
  - cascade: deleting trail removes waypoints
  - cascade: deleting trail removes plans
  - cascade: deleting plan removes plan_versions
```

~10 test cases.

### 2.5 TrailDataService integration tests

**File:** `mobile/src/services/__tests__/integration/trail-data-service-integration.test.ts`

Each test gets a fresh in-memory DB with migrations applied, injected into a new `TrailDataService`.

```
describe('TrailDataService integration')
  - stores and retrieves a trail by ID
  - stores and retrieves waypoints for a trail
  - lists all trails
  - deletes trail → cascades to waypoints
  - storeTrail with same ID replaces existing
  - storeWaypoints replaces existing for trail
  - stores/retrieves custom trail track data
```

~10 test cases. **Source:** `mobile/src/services/trail-data-service.ts`

### 2.6 PlanService integration tests

**File:** `mobile/src/services/__tests__/integration/plan-service-integration.test.ts`

Each test pre-inserts a trail (FK requirement).

```
describe('PlanService integration')
  - creates and retrieves a plan
  - lists plans by trail, ordered by updated_at DESC
  - updates specific plan fields
  - deletes a plan
  - gets active (most recent) plan for trail
  - saves plan version snapshot
  - lists plan versions newest first
  - loads plan version (restores state)
  - deletes plan version
  - cascade: deleting plan removes versions
  - rejects plan with non-existent trail_id
```

~12 test cases. **Source:** `mobile/src/services/plan-service.ts`

### 2.7 Add npm script

Add `"test:integration": "jest --testPathPattern=integration"` to `mobile/package.json` scripts.

---

## Phase 3: Maestro E2E Tests

5 new YAML flows in `mobile/maestro/`. No dependency changes.

**Run:** `~/.maestro/bin/maestro test mobile/maestro/`

**Note:** Exact button labels and screen text must be verified against the actual UI via screenshots before finalizing flows. The flows below use placeholder text that should be confirmed.

### 3.1 `mobile/maestro/plan-creation.yaml`

Launch → open first trail → tap "Create Plan" → verify plan screen opens with direction selector and stops section → back.

### 3.2 `mobile/maestro/plan-editing.yaml`

Launch → create plan → toggle a stop → verify "DAY 1" appears → back.

### 3.3 `mobile/maestro/gpx-import-screen.yaml`

Launch → navigate to import screen → verify "Import Trail" header → back. (Cannot test actual file picker via Maestro — just verify the screen loads.)

### 3.4 `mobile/maestro/tile-download-status.yaml`

Launch → open trail → scroll to "OFFLINE MAPS" section → verify "Download" button visible → back.

### 3.5 `mobile/maestro/measure-tool.yaml`

Launch → open trail → navigate to map/measure → verify measure UI → back.

---

## Phase 4: Selective Component Tests

5 new test files, ~40 test cases. No new dependencies. Follow pattern from `DayPlanCard.test.tsx`: `renderWithTheme` wrapper + `@testing-library/react-native`.

**Run:** `cd mobile && npx jest --testPathPattern="components/__tests__/(StopSelector|ClimateOverview|LocationStatusBar|UndoToast|WaypointList)"`

### 4.1 `mobile/src/components/__tests__/StopSelector.test.tsx`

**Source:** `mobile/src/components/StopSelector.tsx`

```
- renders all waypoints with names and km values
- highlights selected stops via selectedStopKms
- calls onToggleStop on press
- filters by search text (case-insensitive)
- shows empty state when search matches nothing
- displays gap distance between waypoints
- falls back to deprecated selectedStopNames prop
```

~10 test cases.

### 4.2 `mobile/src/components/__tests__/ClimateOverview.test.tsx`

**Source:** `mobile/src/components/ClimateOverview.tsx`

```
- renders monthly temperature and precipitation
- "No climate data" for empty locations
- no tabs when single location
- tabs when multiple locations
- highlights months in planMonths
- switches data on tab press
```

~8 test cases.

### 4.3 `mobile/src/components/__tests__/LocationStatusBar.test.tsx`

**Source:** `mobile/src/components/LocationStatusBar.tsx`

```
- correct label for each state (onTrail, noGps, drifting, warning, offTrail)
- renders detail text when provided
- omits detail when not provided
```

~8 test cases.

### 4.4 `mobile/src/components/__tests__/UndoToast.test.tsx`

**Source:** `mobile/src/components/UndoToast.tsx`

Uses `jest.useFakeTimers()` + `act(() => jest.advanceTimersByTime(3000))` for auto-dismiss.

```
- renders nothing when visible=false
- renders message when visible=true
- calls onUndo on button press
- calls onDismiss after 3s timeout
```

~6 test cases.

### 4.5 `mobile/src/components/__tests__/WaypointList.test.tsx`

**Source:** `mobile/src/components/WaypointList.tsx`

```
- renders all waypoints
- limits display when maxItems set
- shows "See all" button when exceeding maxItems
- no "See all" when within maxItems or no onSeeAll
- highlights focused waypoint
- calls onSelect on press
- shows distance ahead when provided
```

~8 test cases.

---

## Verification

After all phases:
1. `cd mobile && npx jest` — all unit + integration tests pass
2. `cd mobile && npx jest --coverage` — check coverage improvement
3. `~/.maestro/bin/maestro test mobile/maestro/` — all E2E flows pass (requires emulator + Metro)
4. `npx tsc --noEmit` — no type errors from test files

## Implementation Order

Phases are independent. Recommended order: Phase 1 → Phase 2 → Phase 4 → Phase 3 (Maestro last since it requires manual UI verification of labels).
