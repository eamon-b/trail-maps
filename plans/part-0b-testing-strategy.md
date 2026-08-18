# Part 0b: Testing Strategy

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

## Goal

Define a testing strategy with **concrete, verifiable acceptance criteria** for every part of the Trail Companion app. Each part has specific test files to create, commands to run, and pass/fail criteria — so that both automated CI and Claude Code sessions can verify correctness.

## Why This Matters

A hiking app used in remote areas with no connectivity cannot fail silently. Users depend on accurate distance calculations, working offline maps, and reliable GPS tracking. The TODO.md emphasizes "very strong reliability. No gaps or missing points, considerations overlooked." Testing is not optional — it's a safety concern.

## Principles

1. **Tests are written alongside feature code**, not after
2. **Every task has a verification command** that proves it's done
3. **Pure logic is tested exhaustively**; UI is tested for critical flows
4. **Golden files catch regressions** in data processing
5. **Field testing validates** what automated tests cannot

---

## Current State

### What Exists Today

**Web app (`trail-maps/`):**
- Vitest with jsdom environment (`vitest.config.ts`)
- 4 unit test files colocated in `src/lib/`:
  - `distance.test.ts` — 5 test suites, ~15 assertions
  - `gpx-optimizer.test.ts` — 8 test suites, ~40 assertions
  - `track-classification.test.ts` — classification tests
  - `waypoint-classifier.test.ts` — type detection tests
- Run with: `npm test` (from repo root)

**Mobile app (`mobile/`):**
- Jest with jest-expo preset configured
- 16 unit tests across services (trail-data-service, plan-service, etc.)
- React Native Testing Library installed
- Has `test`, `typecheck`, and `lint` scripts

**CI/CD:**
- None configured

### What's Missing

| Gap | Impact | When to Fix |
|-----|--------|-------------|
| No mobile test runner | Can't verify any mobile logic | Part 0 |
| No CI pipeline | Tests only run manually | Part 0 |
| No integration tests | Build pipeline regressions go unnoticed | Part 0 |
| No golden files | Data processing changes are invisible | Part 0 |
| No E2E tests (web) | User-facing regressions possible | Part 2 |
| No E2E tests (mobile) | Critical flows unverified | Part 2+ |
| No performance benchmarks | Degradation unnoticed | Part 2 |
| No field testing protocol | Real-world failures not caught | Part 5a |

---

## Test Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Field Testing                        │
│  Real devices, real trails, multi-hour sessions         │
│  Validates: battery, GPS accuracy, offline resilience   │
├─────────────────────────────────────────────────────────┤
│              E2E Tests (Maestro / Playwright)           │
│  Full user workflows on real app                        │
│  Validates: screens render, navigation works, data flows│
├─────────────────────────────────────────────────────────┤
│              Component / Integration Tests              │
│  Multi-module workflows, UI components with mock data   │
│  Validates: data pipeline, rendering, state management  │
├─────────────────────────────────────────────────────────┤
│                    Unit Tests                           │
│  Pure functions in isolation                            │
│  Validates: algorithms, calculations, data transforms   │
└─────────────────────────────────────────────────────────┘
```

| Layer | Speed | Runner | When to Run | Who Can Run |
|-------|-------|--------|-------------|-------------|
| Unit | <1s each | Vitest (web), Jest (mobile) | Every commit, CI | Claude Code, CI |
| Component | <5s each | Jest + React Native Testing Library | Every commit, CI | Claude Code, CI |
| Integration | <30s each | Vitest / Jest | Pre-merge, CI | Claude Code, CI |
| E2E (web) | <5min total | Playwright | Pre-merge, CI | Claude Code, CI |
| E2E (mobile) | <10min total | Maestro | Pre-release | **Human only** (needs device/simulator) |
| Field | Hours | Manual | Pre-release milestone | **Human only** |

---

## Test Infrastructure Setup

### Web App (Existing — Extend)

**Current:** Vitest + jsdom, 4 test files in `src/lib/`.

**Add for integration/E2E:**

```bash
# From repo root (trail-maps/)
npm install -D @testing-library/dom playwright @playwright/test
```

**New scripts in `package.json`:**
```json
{
  "test": "vitest",
  "test:unit": "vitest run src/lib",
  "test:integration": "vitest run src/integration",
  "test:e2e": "playwright test",
  "test:all": "npm run test:unit && npm run test:integration && npm run test:e2e"
}
```

**New directories:**
```
src/
  lib/
    *.ts
    *.test.ts              # Unit tests (existing)
  integration/
    build-pipeline.test.ts # GPX → JSON pipeline tests
    golden-files.test.ts   # Regression tests against known-good output
tests/
  e2e/
    trail-browsing.spec.ts
    trail-viewing.spec.ts
  fixtures/
    gpx/                   # Test GPX files (see Fixtures section)
    expected/              # Golden file outputs
```

### Mobile App (New — Set Up in Part 0)

**Install test dependencies:**
```bash
# From mobile app directory
npx expo install jest-expo @testing-library/react-native
npx expo install -- --save-dev @types/jest
```

**Create `jest.config.js`:**
```js
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@maplibre/.*)'
  ],
  setupFilesAfterSetup: ['./jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  testMatch: ['**/__tests__/**/*.(ts|tsx)', '**/*.(test|spec).(ts|tsx)'],
};
```

**Create `jest.setup.js`:**
```js
// Mock native modules that don't work in test environment
jest.mock('@maplibre/maplibre-react-native', () => ({
  MapView: 'MapView',
  Camera: 'Camera',
  ShapeSource: 'ShapeSource',
  LineLayer: 'LineLayer',
  SymbolLayer: 'SymbolLayer',
  OfflineManager: {
    createPack: jest.fn(),
    getPacks: jest.fn(),
    deletePack: jest.fn(),
  },
}));
```

**Add scripts to mobile `package.json`:**
```json
{
  "test": "jest",
  "test:watch": "jest --watch",
  "test:coverage": "jest --coverage"
}
```

**Mobile test directory structure:**
```
app/                          # Expo Router screens
  __tests__/                  # Screen-level tests
    trail-list.test.tsx
    trail-viewer.test.tsx
src/
  services/
    __tests__/                # Service unit tests
      location-service.test.ts
      trail-data-service.test.ts
      plan-service.test.ts
  components/
    __tests__/                # Component tests
      DayCard.test.tsx
      WaypointList.test.tsx
      HikeDashboard.test.tsx
e2e/                          # Maestro E2E flows
  trail-browsing.yaml
  offline-mode.yaml
  campsite-planning.yaml
```

### Maestro E2E Setup (Mobile)

[Maestro](https://maestro.mobile.dev/) is used for mobile E2E testing. It runs against a real app on a simulator/device.

**Install:**
```bash
# macOS
curl -fsSL "https://get.maestro.mobile.dev" | bash

# Verify
maestro --version
```

**Example flow file (`e2e/trail-browsing.yaml`):**
```yaml
appId: com.trailcompanion.app
---
- launchApp
- assertVisible: "Bibbulmun Track"
- tapOn: "Bibbulmun Track"
- assertVisible:
    id: "map-view"
- assertVisible:
    id: "dashboard"
```

**Run:**
```bash
# Human only — requires running simulator/device
maestro test e2e/trail-browsing.yaml
maestro test e2e/  # Run all flows
```

### Shared Library (trail-core)

When shared code is extracted to `packages/trail-core/` (Part 0 task), tests must run in **both** environments:

```
packages/trail-core/
  src/
    distance.ts
    distance.test.ts           # Same tests as today
    gpx-optimizer.ts
    gpx-optimizer.test.ts
    track-classification.ts
    track-classification.test.ts
    waypoint-classifier.ts
    waypoint-classifier.test.ts
    types.ts
  vitest.config.ts             # For running in Node (web context)
  jest.config.js               # For running via Jest (RN context)
  package.json
```

Both test runners consume the same `.test.ts` files. The Vitest config includes jsdom; Jest config uses the jest-expo preset. This ensures the pure TypeScript logic works identically in both runtimes.

---

## CI Pipeline (GitHub Actions)

### `.github/workflows/test.yml`

```yaml
name: Tests
on:
  push:
    branches: [main, 'feature/**']
  pull_request:
    branches: [main]

jobs:
  web-unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test:unit -- --run
      - run: npm run lint

  web-integration-tests:
    runs-on: ubuntu-latest
    needs: web-unit-tests
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test:integration -- --run

  web-e2e-tests:
    runs-on: ubuntu-latest
    needs: web-integration-tests
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx playwright install --with-deps
      - run: npm run test:e2e

  mobile-unit-tests:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: mobile  # Update when app moves
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: mobile/package-lock.json
      - run: npm ci
      - run: npm test -- --ci --passWithNoTests
      - run: npm run typecheck

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: tsc --noEmit
```

### What CI Does NOT Cover (Needs Human)

- Maestro E2E tests (need simulator — run manually pre-release)
- Field testing (need physical device on a trail)
- Visual regression (need screenshot comparison setup — defer to Part 1)
- Performance profiling on device (need React Native profiler)

---

## Test Data & Fixtures

### Fixture Management Strategy

Fixtures live in `tests/fixtures/` at the repo root (shared between web and mobile).

**Creating golden files:**
```bash
# Generate golden files from current build output
npm run build:trails
# Copy generated JSON to fixtures
cp public/data/generated/bibbulmun.json tests/fixtures/expected/bibbulmun.json
```

**When golden files should change:**
- Only when you intentionally change the processing pipeline
- Always review diffs in golden files during code review
- CI fails if golden file output doesn't match — this is intentional

### Required GPX Test Files

These must be collected manually (you need to export from each app):

```
tests/fixtures/gpx/
  # Real exports — collect these by hand from each app
  gaia-export.gpx            # Export from Gaia GPS
  alltrails-export.gpx       # Export from AllTrails
  strava-export.gpx          # Export from Strava
  garmin-export.gpx          # Export from Garmin Connect
  caltopo-export.gpx         # Export from CalTopo

  # Synthetic edge cases — generate or hand-craft these
  no-elevation.gpx           # Track without <ele> elements
  no-waypoints.gpx           # Track only, no <wpt> elements
  multi-track.gpx            # Multiple <trk> elements
  track-with-gaps.gpx        # Non-continuous track segments
  single-point.gpx           # Degenerate: one track point
  empty-track.gpx            # <trk> with empty <trkseg>
  huge-file.gpx              # 10MB+ for performance testing
  malformed.gpx              # Invalid XML structure

  # Reference trails (copy from data/trails/)
  bibbulmun-sample.gpx       # Subset of Bibbulmun for fast tests
  simple-trail.gpx           # ~50 points, known distances
  trail-with-variants.gpx    # Main + alternate tracks
```

### Expected Output Files

```
tests/fixtures/expected/
  bibbulmun.json             # Golden file: full Bibbulmun build output
  larapinta.json             # Golden file: Larapinta
  simple-trail.json          # Golden file: simple trail
```

**Action item for you (human):** Export GPX files from Gaia, AllTrails, Strava, and Garmin for the same short trail section. These can't be auto-generated — they test each app's specific GPX dialect.

---

## Per-Part Test Checklists

Each section below defines the **specific tests required** before that part is considered complete. Tests marked with `[auto]` can be run by Claude Code or CI. Tests marked with `[human]` need a person.

---

### Part 0: Foundation

**Scope:** Project setup, shared library extraction, data architecture, navigation shell.

#### Unit Tests

| File | What It Tests | Status |
|------|---------------|--------|
| `distance.test.ts` | Haversine, waypoint distance, edge cases | Exists — extend |
| `gpx-optimizer.test.ts` | Douglas-Peucker, elevation smoothing, truncation | Exists — extend |
| `track-classification.test.ts` | Main/alternate/side-trip classification | Exists — extend |
| `waypoint-classifier.test.ts` | 14 waypoint types, prefix rules, known towns | Exists — extend |

**New unit tests to add:**

```
distance.test.ts additions:
  - antipodal points (max distance ~20,000 km)
  - points on the date line (lon 180/-180)
  - points at poles (lat 90/-90)
  - zero-length segment (same point twice)

gpx-optimizer.test.ts additions:
  - single point input to douglasPeucker
  - empty array input to all functions
  - very large tolerance (should reduce to 2 points)
  - zero tolerance (should keep all points)

track-classification.test.ts additions:
  - GPX with 10+ tracks (complex multi-track)
  - all tracks matching "alternate" pattern (no main)
  - track names with unicode characters

waypoint-classifier.test.ts additions:
  - all 14 types explicitly tested with canonical examples
  - waypoint with empty name
  - waypoint with no matching pattern (should default to 'poi')
  - case insensitivity in prefix matching
```

#### Mobile Test Infrastructure

| Task | Verification Command | Pass Criteria |
|------|---------------------|---------------|
| Install Jest + RNTL | `cd mobile && npm test -- --passWithNoTests` | Exits 0 |
| Create jest.config.js | `cat jest.config.js` | File exists with jest-expo preset |
| Create smoke test | `npm test` | At least 1 test passes |
| TypeScript compiles | `npm run typecheck` | Exits 0, no errors |

**Smoke test (`__tests__/smoke.test.tsx`):**
```typescript
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

describe('Test infrastructure', () => {
  it('renders a component', () => {
    render(<Text>Hello</Text>);
    expect(screen.getByText('Hello')).toBeTruthy();
  });
});
```

#### Data Architecture Tests

When SQLite data layer is built:

```typescript
// src/services/__tests__/trail-data-service.test.ts

describe('TrailDataService', () => {
  it('stores and retrieves a trail');
  it('stores and retrieves waypoints for a trail');
  it('returns empty array for unknown trail');
  it('handles concurrent reads');
  it('updates existing trail data');
  it('deletes trail and associated waypoints');
});

// src/services/__tests__/plan-service.test.ts

describe('PlanService', () => {
  it('creates a new plan for a trail');
  it('loads a saved plan');
  it('lists all plans for a trail');
  it('deletes a plan');
  it('handles plan with no stops');
});
```

#### Part 0 Verification Checklist

```bash
# [auto] Run all these from repo root — all must exit 0
npm test -- --run                                          # Web unit tests
cd mobile && npm test -- --ci          # Mobile unit tests
cd mobile && npm run typecheck         # Mobile typecheck
cd mobile && npx expo config --json    # App config valid

# [human] Visual verification
# - App launches on iOS simulator
# - App launches on Android emulator
# - Three-mode navigation (Plan/Hike/Contribute) tabs visible
# - Tapping each mode switches the active tab
```

---

### Part 1: Design System

**Scope:** Color system, core components, dashboard layout, dark mode.

#### Component Tests

```typescript
// src/components/__tests__/ModeSelector.test.tsx
describe('ModeSelector', () => {
  it('renders three mode buttons (Plan, Hike, Contribute)');
  it('highlights the active mode');
  it('calls onModeChange when tapped');
  it('applies correct color for each mode');
});

// src/components/__tests__/DayCard.test.tsx
describe('DayCard', () => {
  it('renders day number, date, and destination');
  it('shows distance, ascent, and descent');
  it('shows water source count');
  it('shows warning icon when day exceeds threshold');
  it('renders without crashing when data is minimal');
});

// src/components/__tests__/BottomSheet.test.tsx
describe('BottomSheet', () => {
  it('renders children content');
  it('renders in collapsed state by default');
  // Gesture tests need Maestro (human)
});

// src/components/__tests__/WaypointList.test.tsx
describe('WaypointList', () => {
  it('renders list of waypoints with emoji icons');
  it('renders waypoint type correctly for all 14 types');
  it('highlights selected waypoint');
  it('calls onSelect when waypoint tapped');
  it('shows distance from current position');
});

// src/components/__tests__/HikeDashboard.test.tsx
describe('HikeDashboard', () => {
  it('renders trail name and progress bar');
  it('shows next campsite, water, town, shelter cards');
  it('shows "No data" state when trail has no waypoints');
  it('renders today section with plan data');
  it('renders today section without plan (flexible hiker mode)');
});
```

#### Accessibility Tests

```typescript
// src/components/__tests__/accessibility.test.tsx
describe('Accessibility', () => {
  it('all interactive elements have accessibilityLabel');
  it('all buttons meet 44x44pt minimum touch target');
  it('high contrast mode increases text contrast ratio');
  // Screen reader testing needs a human with VoiceOver/TalkBack
});
```

#### Part 1 Verification Checklist

```bash
# [auto]
cd mobile && npm test -- --ci
cd mobile && npm run typecheck

# [human] Visual verification on device/simulator
# - Mode selector switches color scheme (Plan=blue, Hike=green, Contribute=orange)
# - Dark mode toggle works, all components readable
# - Dashboard layout matches wireframe with mock data
# - Bottom sheet slides up/down, mode selector visible underneath
# - Day cards render with realistic trail data
# - All text readable in bright light (take phone outside)
```

---

### Part 2: Offline Viewer

**Scope:** MapLibre integration, offline tiles, GPS, distance calculations, elevation profile.

#### Unit Tests (Location Logic)

These test the **pure logic** of location services, not the native GPS integration:

```typescript
// src/services/__tests__/track-snapping.test.ts
describe('snapToTrack', () => {
  // Use a known track segment for all tests
  const trackPoints = [/* predefined points with known distances */];

  it('snaps to nearest point when close to track');
  it('returns correct km position for snapped point');
  it('prefers forward direction when equidistant from two segments');
  it('uses recent movement direction to resolve ambiguity');
  it('returns low confidence when GPS accuracy > 100m');
  it('handles position exactly on a track point');
  it('handles position between two track points (interpolation)');
  it('handles position beyond end of track');
  it('handles position before start of track');
});

// src/services/__tests__/distance-to-waypoint.test.ts
describe('distanceToNextWaypoint', () => {
  it('calculates trail distance (not straight line) to next campsite');
  it('calculates elevation gain/loss to next waypoint');
  it('returns null when no waypoint of type exists ahead');
  it('handles direction reversal (SOBO)');
  it('returns correct waypoint when multiple of same type exist');
  it('updates correctly as position advances');
});
```

#### Integration Tests (Offline Data)

```typescript
// src/services/__tests__/offline-trail-loading.test.ts
describe('Offline Trail Loading', () => {
  // Uses mocked SQLite with pre-loaded test data
  it('loads trail metadata from local storage');
  it('loads waypoints for a trail');
  it('loads track points for rendering');
  it('returns error for non-downloaded trail');
  it('handles corrupted local data gracefully');
});
```

#### E2E Tests (Maestro — Human Only)

```yaml
# e2e/trail-browsing.yaml
appId: com.trailcompanion.app
---
- launchApp
- assertVisible: "Bibbulmun Track"
- tapOn: "Bibbulmun Track"
- assertVisible:
    id: "map-view"
- assertVisible:
    id: "elevation-profile"

# e2e/offline-mode.yaml
appId: com.trailcompanion.app
---
- launchApp
- tapOn: "Bibbulmun Track"
- tapOn:
    id: "download-offline"
- assertVisible: "Download complete"
# Toggle airplane mode manually, then:
- assertVisible:
    id: "map-view"

# e2e/direction-reversal.yaml
appId: com.trailcompanion.app
---
- launchApp
- tapOn: "Bibbulmun Track"
- tapOn:
    id: "direction-toggle"
- assertVisible: "SOBO"
```

#### Part 2 Verification Checklist

```bash
# [auto]
cd mobile && npm test -- --ci
cd mobile && npm run typecheck
npm test -- --run  # Web tests still pass (no regressions)

# [human] Maestro E2E
maestro test e2e/trail-browsing.yaml
maestro test e2e/offline-mode.yaml
maestro test e2e/direction-reversal.yaml

# [human] Manual verification
# - Map displays trail polyline on real device
# - Blue dot shows current GPS position
# - Accuracy circle visible when GPS accuracy > 20m
# - Offline: toggle airplane mode, map still renders cached tiles
# - Elevation profile syncs with map pan
# - Tapping waypoint on map opens bottom sheet with details
# - Distance to next campsite updates as you walk
```

---

### Part 3: Planning Tools

**Scope:** Campsite planner, section hiking, resupply/water distances, measure tool.

#### Unit Tests (Planning Logic)

These are the **core differentiating feature** — test exhaustively:

```typescript
// src/services/__tests__/campsite-planner.test.ts
describe('CampsitePlanner', () => {
  // Setup: load Bibbulmun trail data fixture

  describe('Day Statistics', () => {
    it('calculates distance for single-day plan (start to first stop)');
    it('calculates distance for multi-day plan');
    it('calculates ascent and descent per day');
    it('calculates estimated hiking time per day');
    it('recalculates all stats when stop added');
    it('recalculates all stats when stop removed');
    it('recalculates all stats when stop reordered');
    it('handles zero-distance day (rest day at same campsite)');
    it('total of all day distances equals total trail distance (for thru-hike)');
  });

  describe('Water Sources', () => {
    it('counts water sources between each pair of stops');
    it('flags days with no water sources as warnings');
    it('calculates max water carry distance per day');
  });

  describe('Section Hiking', () => {
    it('restricts waypoints to selected section');
    it('restricts campsites to selected section');
    it('calculates correct distances within section');
    it('handles section that starts/ends mid-segment');
  });

  describe('Direction', () => {
    it('reverses all km positions when direction changes');
    it('preserves stop selections after direction change');
    it('day stats are correct after reversal');
  });

  describe('Persistence', () => {
    it('saves plan to storage and loads it back identically');
    it('handles loading a plan for a trail that has been updated');
    it('lists all saved plans for a trail');
    it('deletes a plan');
  });
});

// src/services/__tests__/resupply-calculator.test.ts
describe('ResupplyCalculator', () => {
  it('identifies resupply points (towns) along trail');
  it('calculates distance between resupply points');
  it('calculates days of food needed between resupply points');
  it('handles custom daily distance for food calculations');
});

// src/services/__tests__/measure-tool.test.ts
describe('MeasureTool', () => {
  it('calculates trail distance between two selected points');
  it('calculates elevation gain/loss between two points');
  it('handles points selected in reverse order');
  it('handles points on different track segments');
});
```

#### Component Tests

```typescript
// src/components/__tests__/DayPlanList.test.tsx
describe('DayPlanList', () => {
  it('renders list of day cards from plan data');
  it('shows add-campsite button');
  it('shows warning badges on days exceeding distance threshold');
  it('shows total trip summary');
});
```

#### Part 3 Verification Checklist

```bash
# [auto]
cd mobile && npm test -- --ci
cd mobile && npm run typecheck

# [human] Maestro E2E
maestro test e2e/campsite-planning.yaml

# [human] Manual verification
# - Add 3+ campsites to a plan, verify day distances sum to total
# - Remove middle campsite, verify adjacent days recalculate
# - Drag to reorder campsites, verify all stats update
# - Switch direction (NOBO→SOBO), verify distances recalculate
# - Set section (e.g. km 100-200), verify only relevant campsites shown
# - Save plan, close app, reopen, load plan — verify identical
# - Measure tool: tap two points, verify trail distance (not straight line)
```

---

### Part 4: Custom Trails

**Scope:** GPX upload, client-side processing, auto-datasheet, custom trail storage.

#### Unit Tests (GPX Parsing for React Native)

When `gpx-parser.ts` is adapted for React Native (using `fast-xml-parser` instead of DOMParser):

```typescript
// src/services/__tests__/gpx-parser-rn.test.ts
describe('parseGpx (React Native)', () => {
  it('parses valid GPX with tracks and waypoints');
  it('handles GPX with no elevation data');
  it('handles GPX with no waypoints');
  it('handles GPX with multiple track segments');
  it('handles GPX with routes (<rte>) instead of tracks');
  it('extracts waypoint names and descriptions');
  it('preserves coordinate precision');
  it('throws descriptive error for invalid XML');
  it('throws descriptive error for non-GPX XML');
  it('throws descriptive error for empty file');
  it('throws descriptive error for file > 50MB');
  it('handles GPX from Gaia GPS format');
  it('handles GPX from AllTrails format');
  it('handles GPX from Strava format');
  it('handles GPX from Garmin Connect format');
});
```

#### Integration Tests (Processing Pipeline)

```typescript
// src/services/__tests__/gpx-processing-pipeline.test.ts
describe('GPX Processing Pipeline', () => {
  it('processes simple GPX to trail data structure');
  it('produces same output as web build pipeline for same input');
  it('generates correct waypoint km positions');
  it('generates correct cumulative distances');
  it('generates correct elevation statistics');
  it('handles GPX with no elevation (skips elevation stats)');
  it('completes in < 30s for 10MB file', { timeout: 60000 });
  it('produces deterministic output');
});
```

#### Part 4 Verification Checklist

```bash
# [auto]
cd mobile && npm test -- --ci
cd mobile && npm run typecheck

# [human] Manual verification
# - Upload GPX from each supported app (Gaia, AllTrails, Strava, Garmin)
# - Verify trail appears in list alongside built-in trails
# - Verify waypoints display on map
# - Verify auto-generated datasheet has correct distances
# - Verify campsite planner works on custom trail
# - Upload malformed GPX → verify helpful error message (not crash)
# - Upload GPX with no waypoints → verify trail still usable
# - Upload GPX with no elevation → verify distance-only datasheet
# - Close app, reopen → verify custom trail persists
```

---

### Part 5a: On-Trail Safety

**Scope:** Off-trail alerts, sunrise/sunset, today's progress.

#### Unit Tests (Safety Logic)

```typescript
// src/services/__tests__/off-trail-detection.test.ts
describe('OffTrailDetection', () => {
  // Use a known trail segment

  describe('Trail Status Classification', () => {
    it('returns "on-trail" for positions within 50m');
    it('returns "drifting" for positions 50-200m from trail');
    it('returns "warning" for positions 200-500m from trail');
    it('returns "off-trail" for positions > 500m from trail');
    it('returns "unknown" when GPS accuracy > threshold');
  });

  describe('Off-Trail Bearing', () => {
    it('calculates correct bearing to nearest trail point');
    it('bearing points toward trail (not away)');
  });

  describe('False Positive Prevention', () => {
    it('debounces: single off-trail reading does not trigger alert');
    it('sustained off-trail readings trigger alert after N consecutive');
    it('returns to on-trail state immediately when back on trail');
    it('suppresses alerts when GPS accuracy is poor (> 100m)');
    it('does not alert when on known alternate/variant track');
  });

  describe('User Configuration', () => {
    it('respects custom distance thresholds');
    it('alerts disabled when user turns off');
    it('snooze suppresses alerts for specified duration');
  });
});

// src/services/__tests__/sunrise-sunset.test.ts
describe('SunriseSunset', () => {
  it('calculates sunrise for Perth in winter (known value)');
  it('calculates sunset for Perth in summer (known value)');
  it('handles southern hemisphere correctly');
  it('accounts for daylight saving time');
  it('calculates civil twilight times');
  it('updates as trail position changes (different longitude)');
  it('returns "sunset in Xh Xm" countdown format');
});

// src/services/__tests__/todays-progress.test.ts
describe('TodaysProgress', () => {
  it('calculates distance hiked today from start position');
  it('calculates distance remaining to today destination');
  it('calculates percentage complete');
  it('estimates arrival time based on average speed');
  it('handles "no plan" mode (shows total trail progress instead)');
  it('resets at midnight or when plan changes');
});
```

#### Part 5a Verification Checklist

```bash
# [auto]
cd mobile && npm test -- --ci
cd mobile && npm run typecheck

# [human] Maestro E2E (basic)
maestro test e2e/off-trail-alert.yaml

# [human] Field testing (CRITICAL for this part)
# See Field Testing Protocol below — this is where off-trail
# detection is validated against real GPS behavior
```

---

## Performance Benchmarks

### Thresholds

| Metric | Target | Maximum | How to Measure |
|--------|--------|---------|----------------|
| App cold start (empty cache) | < 2s | < 3s | Maestro timing / stopwatch |
| App cold start (500MB cache) | < 2s | < 3s | Maestro timing / stopwatch |
| Trail data load from SQLite | < 200ms | < 500ms | `console.time()` in service |
| Distance calculation (single) | < 1ms | < 5ms | Vitest bench |
| Douglas-Peucker on 10k points | < 100ms | < 500ms | Vitest bench |
| GPX processing (1MB file) | < 5s | < 10s | Jest timer |
| GPX processing (10MB file) | < 15s | < 30s | Jest timer |
| Memory usage (idle, no trail) | < 100MB | < 150MB | Xcode/Android Studio profiler |
| Memory usage (with map + trail) | < 200MB | < 300MB | Xcode/Android Studio profiler |
| Map pan/zoom frame rate | 60 fps | > 30 fps | React Native profiler |
| Tile cache read | < 20ms | < 50ms | SQLite benchmark |

### Benchmark Test Suite

Run benchmarks using Vitest's `bench` feature (for pure logic) and manual timing (for device metrics):

```typescript
// packages/trail-core/src/benchmarks/performance.bench.ts
import { bench, describe } from 'vitest';

describe('Distance Calculations', () => {
  bench('haversineDistance3D single call', () => {
    haversineDistance3D(-37.8136, 144.9631, 100, -33.8688, 151.2093, 50);
  });

  bench('findCloseWaypoints with 200 waypoints', () => {
    findCloseWaypoints(trackWith1000Points, waypointSet200, 5);
  });
});

describe('GPX Processing', () => {
  bench('Douglas-Peucker on 10k points', () => {
    douglasPeucker(generatedPoints10k, 10);
  });

  bench('Douglas-Peucker on 50k points', () => {
    douglasPeucker(generatedPoints50k, 10);
  });
});
```

**Run:** `npx vitest bench` (from trail-core package)

### Device Performance (Human Only)

Device-level benchmarks require a human with a profiler:

| What | Tool | How |
|------|------|-----|
| Cold start time | Stopwatch / Maestro `timeTaken` | Launch app, time until interactive |
| Memory usage | Xcode Instruments / Android Studio Profiler | Monitor during typical session |
| Frame rate during map pan | React Native Perf Monitor | Enable in dev menu, pan map |
| Battery drain | Device battery stats | 1-hour controlled test |

---

## Field Testing Protocol

Field testing validates what automated tests cannot: real GPS behavior, battery life, usability with tired minds and dirty hands, and edge cases that only appear in nature.

### When to Field Test

- Before every release that touches GPS, maps, or offline functionality
- Before the first App Store / Play Store submission
- After any change to off-trail detection thresholds

### Pre-Release Field Test Checklist

**Equipment:**
- [ ] Primary test device (target iPhone model)
- [ ] Secondary test device (Android, different manufacturer)
- [ ] External battery pack
- [ ] Notepad and pen (for observations when hands are dirty)
- [ ] Known trail section, 2-4 hours, with good and poor GPS sections

**Test Scenarios (v1.0):**

| # | Scenario | Duration | What to Validate | Version |
|---|----------|----------|------------------|---------|
| 1 | Basic hike with GPS | 2-4 hrs | Battery drain, GPS accuracy, position tracking | Part 2+ |
| 2 | Airplane mode hike | 2-4 hrs | Offline tiles, cached trail data, all features work | Part 2+ |
| 3 | Off-trail detection | 30 min | Walk deliberately off trail, verify alerts | Part 5a |
| 4 | Dense canopy section | 1 hr | GPS behavior, false positive rate | Part 5a |
| 5 | Plan modification mid-hike | 30 min | Add/remove campsites, stats recalculate | Part 3+ |
| 6 | Custom trail upload | 30 min | Upload GPX, verify it works like built-in trail | Part 4 |

**Measurements to Record:**

```
Trail: ___________________
Date: ___________________
Device: _________________ (model, OS version)
App Version: _____________

BATTERY
  Start Time: _____ Battery: _____%
  End Time: _____   Battery: _____%
  GPS Active Time: _____ hours
  Screen On Time: _____ hours
  Drain Rate: _____% / hour

GPS ACCURACY
  [ ] Consistent lock throughout
  [ ] Occasional dropouts (count: _____, duration: _____)
  [ ] Long time to first fix (> 30s)
  [ ] Poor accuracy under canopy (estimated: ____m)
  [ ] Position jumped unexpectedly (count: _____)

OFF-TRAIL ALERTS (Part 5a)
  [ ] No false positives
  [ ] False positives (count: _____, describe: _______________)
  [ ] Correctly alerted when deliberately off trail (Y/N)
  [ ] Alert dismissed correctly with snooze (Y/N)
  [ ] GPS accuracy suppression worked (Y/N)

OFFLINE FUNCTIONALITY
  [ ] Map tiles loaded correctly in airplane mode
  [ ] Trail data loaded correctly
  [ ] Distance calculations updated
  [ ] No crashes or blank screens

USABILITY
  Text readable in bright sunlight?  [ ] Yes  [ ] No (which screens: ___)
  Touch targets easy to hit?         [ ] Yes  [ ] No (which buttons: ___)
  App responsive after 2+ hours?     [ ] Yes  [ ] No (describe: ___)

BUGS FOUND
  1. _______________________________________________
  2. _______________________________________________
  3. _______________________________________________
```

### Battery Drain Targets

| Scenario | Target | Maximum | Notes |
|----------|--------|---------|-------|
| GPS active, screen on | 12%/hour | 18%/hour | Typical hiking usage |
| GPS active, screen off | 4%/hour | 7%/hour | Phone in pocket |
| Planning mode (no GPS) | 2%/hour | 4%/hour | Evening in tent |
| Overnight, backgrounded | < 2% total | < 5% total | App not killed |

---

## Golden File Testing

Golden files are the **primary regression defense** for the data processing pipeline. When a test fails, it means the build output changed — which could be intentional (pipeline improvement) or a bug.

```typescript
// src/integration/golden-files.test.ts

describe('Golden File Validation', () => {
  const trails = ['bibbulmun', 'larapinta'];  // Add as trails are built

  for (const trailId of trails) {
    describe(trailId, () => {
      it('waypoint count matches snapshot', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);
        expect(result.waypoints.length).toBe(golden.waypoints.length);
      });

      it('total distance within 0.5% of snapshot', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);
        const tolerance = golden.totalDistance * 0.005;
        expect(Math.abs(result.totalDistance - golden.totalDistance))
          .toBeLessThan(tolerance);
      });

      it('waypoint km positions within 0.1 km of snapshot', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);
        for (let i = 0; i < result.waypoints.length; i++) {
          expect(result.waypoints[i].kmPosition)
            .toBeCloseTo(golden.waypoints[i].kmPosition, 1);
        }
      });

      it('track point count within 5% of snapshot', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);
        const tolerance = golden.trackPointCount * 0.05;
        expect(Math.abs(result.trackPointCount - golden.trackPointCount))
          .toBeLessThan(tolerance);
      });
    });
  }
});
```

**Updating golden files (intentional changes only):**
```bash
# Rebuild trails and update golden files
npm run build:trails
cp public/data/generated/bibbulmun.json tests/fixtures/expected/bibbulmun.json
# Review the diff carefully before committing
git diff tests/fixtures/expected/
```

---

## GPX Source Compatibility Tests

Test with real GPX exports from popular apps (fixture files must be collected by hand):

```typescript
// src/integration/gpx-compatibility.test.ts

describe('GPX Source Compatibility', () => {
  const sources = [
    { name: 'Gaia GPS', file: 'fixtures/gpx/gaia-export.gpx' },
    { name: 'AllTrails', file: 'fixtures/gpx/alltrails-export.gpx' },
    { name: 'Strava', file: 'fixtures/gpx/strava-export.gpx' },
    { name: 'Garmin Connect', file: 'fixtures/gpx/garmin-export.gpx' },
  ];

  for (const source of sources) {
    describe(source.name, () => {
      it('parses without error');
      it('extracts at least one track with points');
      it('extracts elevation data if present');
      it('produces valid trail data after full processing');
    });
  }
});

describe('Malformed GPX Handling', () => {
  it('missing elevation → continues without elevation stats');
  it('empty waypoints → trail usable, no POI markers');
  it('invalid XML → descriptive error message');
  it('non-GPX XML → descriptive error message');
  it('file > 50MB → rejects with size error');
  it('empty file → descriptive error message');
  it('single track point → handles gracefully');
});
```

---

## Summary: Verification Commands by Part

Quick reference for what to run after completing each part:

| Part | Auto-Verifiable Commands | Human Verification |
|------|--------------------------|-------------------|
| **0** | `npm test -- --run` (web), `cd mobile && npm test -- --ci`, `npm run typecheck` | App launches on both platforms |
| **1** | `cd mobile && npm test -- --ci` | Visual: mode colors, dark mode, dashboard layout |
| **2** | All Part 0 commands + `npm run test:integration -- --run` | Maestro E2E, map renders, GPS works, offline tiles load |
| **3** | All Part 2 commands | Maestro E2E, campsite planner manual testing |
| **4** | All Part 3 commands | Upload GPX from 4 apps, verify processing |
| **5a** | All Part 4 commands | Field testing protocol (2-4 hours on trail) |
| **Pre-release** | All commands from all parts | Field test on 2 devices, battery drain measurement |

---

## Implementation Priority

1. **Immediate (Part 0)**
   - Set up Jest for mobile app (smoke test passes)
   - Set up GitHub Actions CI pipeline
   - Extend existing unit tests with edge cases
   - Create test fixture directory structure
   - Generate golden files from current build output

2. **Part 1 (Design System)**
   - Component tests for each new UI component
   - Accessibility test helpers

3. **Part 2 (Offline Viewer)**
   - Track snapping and distance calculation unit tests
   - Offline data loading integration tests
   - Maestro E2E flows for core navigation
   - Initial performance benchmarks

4. **Part 3 (Planning Tools)**
   - Campsite planner test suite (the most critical test suite in the app)
   - Plan persistence tests
   - Section hiking tests

5. **Part 4 (Custom Trails)**
   - GPX parser tests (React Native variant)
   - Processing pipeline integration tests
   - GPX compatibility test suite (requires fixture files from you)

6. **Part 5a (On-Trail Safety)**
   - Off-trail detection unit tests
   - Sunrise/sunset calculation tests
   - **First field testing session**

---

## Dependencies

- **Part 0**: Foundation (test infrastructure is part of foundation)
- **All other parts**: This testing strategy
- **GPX compatibility tests**: Require manually exported GPX fixture files
- **Field testing**: Requires physical trail access, real devices, 2-4 hours
- **Maestro E2E**: Requires macOS with Xcode or Android Studio

## Notes

- Tests are written alongside feature code, not after
- Golden files should be updated intentionally, with careful diff review
- Performance benchmarks should be re-run after major changes
- Field testing should happen before each milestone release
- The campsite planner (Part 3) is the most algorithmically complex feature and deserves the most thorough test coverage
