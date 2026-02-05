# Part 0b: Testing Strategy

## Goal

Establish a comprehensive testing strategy that ensures reliability across all parts of the Trail Companion app. This document defines test infrastructure, integration test scenarios, performance benchmarks, and field testing protocols.

## Why This Matters

The TODO.md emphasizes "very strong reliability. No gaps or missing points, considerations overlooked." A hiking app used in remote areas with no connectivity cannot fail silently. Users depend on accurate distance calculations, working offline maps, and reliable GPS tracking. Testing is not optional—it's a safety concern.

---

## Test Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Field Testing                        │
│  Real devices, real trails, multi-hour sessions         │
│  Validates: battery, GPS accuracy, offline resilience   │
├─────────────────────────────────────────────────────────┤
│              E2E / Integration Tests                    │
│  Full workflows across multiple components              │
│  Validates: data flows correctly through system         │
├─────────────────────────────────────────────────────────┤
│                  Component Tests                        │
│  UI components with mock data                           │
│  Validates: rendering, interactions, state management   │
├─────────────────────────────────────────────────────────┤
│                    Unit Tests                           │
│  Pure functions in isolation                            │
│  Validates: algorithms, calculations, data transforms   │
└─────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Speed | Scope | When to Run |
|-------|-------|-------|-------------|
| Unit | <1s each | Single function | Every commit, pre-push hook |
| Component | <5s each | Single component with mocks | Every commit |
| Integration | <30s each | Multi-component workflows | Pre-merge, CI pipeline |
| E2E | <5min total | Full app workflows | Nightly, pre-release |
| Field | Hours | Real-world scenarios | Pre-release milestone |

---

## Test Infrastructure Setup (Part 0 Addition)

### Web App (Existing trail-maps)

Current state:
- Vitest with jsdom for unit tests
- 4 test files covering core library functions

Add:
```bash
npm install -D @testing-library/dom playwright
```

New scripts in package.json:
```json
{
  "test": "vitest",
  "test:unit": "vitest run src/lib",
  "test:integration": "vitest run src/integration",
  "test:e2e": "playwright test",
  "test:all": "npm run test:unit && npm run test:integration && npm run test:e2e"
}
```

Directory structure:
```
src/
  lib/
    *.ts
    *.test.ts          # Unit tests (existing)
  integration/
    build-pipeline.test.ts
    trail-viewer.test.ts
tests/
  e2e/
    trail-browsing.spec.ts
    trail-viewing.spec.ts
  fixtures/
    gpx/               # Test GPX files
    expected/          # Golden file outputs
```

### React Native App (New)

```bash
# Testing libraries
npm install -D jest @testing-library/react-native detox

# For component testing
npm install -D @storybook/react-native
```

Directory structure:
```
packages/
  trail-core/
    src/
      *.ts
      *.test.ts        # Unit tests (shared library)
  app/
    src/
      components/
        *.tsx
        *.test.tsx     # Component tests
      screens/
        *.tsx
        *.test.tsx
    e2e/
      *.e2e.ts         # Detox E2E tests
```

### CI Pipeline

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:unit

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install
      - run: npm run test:e2e

  mobile-tests:
    runs-on: macos-latest  # Required for iOS simulator
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:mobile:ios
```

---

## Unit Tests

### Existing Coverage (Keep and Extend)

| Module | Current Tests | Additional Tests Needed |
|--------|--------------|------------------------|
| `distance.ts` | Haversine, waypoint distance | Edge cases: antipodal points, poles, date line crossing |
| `gpx-optimizer.ts` | Douglas-Peucker | Tolerance edge cases, empty input, single point |
| `track-classification.ts` | Basic classification | Multi-track files, ambiguous cases |
| `waypoint-classifier.ts` | Type detection | All 14 types, unknown types, edge names |

### New Unit Tests Required

**gpx-parser.ts** (currently untested):
```typescript
describe('parseGpx', () => {
  it('parses valid GPX with tracks and waypoints');
  it('handles GPX with no elevation data');
  it('handles GPX with no waypoints');
  it('handles GPX with multiple track segments');
  it('throws descriptive error for invalid XML');
  it('throws descriptive error for non-GPX XML');
  it('handles empty file');
  it('handles very large files (10MB+) without memory issues');
});
```

**Shared library (trail-core) for React Native:**
```typescript
// All pure functions must have unit tests before extraction
// Tests should run identically in Node and React Native environments
describe('distance calculations', () => {
  // Same tests, different runtime
});
```

---

## Integration Tests

### Build Pipeline Integration

Test the complete flow: GPX file → processed trail JSON

```typescript
// src/integration/build-pipeline.test.ts

describe('Build Pipeline', () => {
  describe('GPX to Trail JSON', () => {
    it('processes Bibbulmun GPX to expected output', async () => {
      const input = await readFile('fixtures/gpx/bibbulmun.gpx');
      const result = await processTrail(input);
      const expected = await readFile('fixtures/expected/bibbulmun.json');

      expect(result.waypoints.length).toBe(expected.waypoints.length);
      expect(result.tracks[0].points.length).toBeGreaterThan(0);
      // Check specific waypoints match
      expect(result.waypoints[0]).toMatchObject(expected.waypoints[0]);
    });

    it('handles multi-track GPX with variants', async () => {
      const input = await readFile('fixtures/gpx/trail-with-variants.gpx');
      const result = await processTrail(input);

      expect(result.tracks.filter(t => t.type === 'main')).toHaveLength(1);
      expect(result.tracks.filter(t => t.type === 'alternate')).toHaveLength(2);
    });

    it('produces deterministic output (no timestamp drift)', async () => {
      const input = await readFile('fixtures/gpx/simple-trail.gpx');
      const result1 = await processTrail(input);
      const result2 = await processTrail(input);

      expect(result1).toEqual(result2);
    });
  });

  describe('Waypoint Matching', () => {
    it('matches waypoints to nearest track points', async () => {
      const result = await processTrail(simpleGpx);

      for (const waypoint of result.waypoints) {
        expect(waypoint.kmPosition).toBeDefined();
        expect(waypoint.kmPosition).toBeGreaterThanOrEqual(0);
      }
    });

    it('assigns correct km positions in both directions', async () => {
      const result = await processTrail(simpleGpx);
      const reversed = reverseDirection(result);

      const totalDistance = result.totalDistance;
      expect(reversed.waypoints[0].kmPosition)
        .toBeCloseTo(totalDistance - result.waypoints[0].kmPosition, 1);
    });
  });

  describe('Distance Calculations', () => {
    it('cumulative distances match total trail length', async () => {
      const result = await processTrail(simpleGpx);
      const lastPoint = result.tracks[0].points.at(-1);

      expect(lastPoint.cumulativeDistance).toBeCloseTo(result.totalDistance, 0);
    });

    it('elevation gain/loss sum correctly', async () => {
      const result = await processTrail(simpleGpx);

      // Net elevation change should equal end elevation - start elevation
      const netChange = result.totalAscent - result.totalDescent;
      const actualChange = result.endElevation - result.startElevation;
      expect(netChange).toBeCloseTo(actualChange, 0);
    });
  });
});
```

### Trail Viewer Integration (Web)

```typescript
// src/integration/trail-viewer.test.ts

describe('Trail Viewer', () => {
  let viewer: TrailViewer;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="map"></div><div id="profile"></div>';
    viewer = await createTrailViewer('bibbulmun');
  });

  describe('Map-Profile Sync', () => {
    it('clicking map updates elevation profile marker', () => {
      const point = { lat: -34.05, lon: 115.85, km: 50 };
      viewer.handleMapClick(point);

      expect(viewer.getProfileMarkerPosition()).toBe(50);
    });

    it('clicking profile pans map to location', () => {
      viewer.handleProfileClick(100); // km 100

      const center = viewer.getMapCenter();
      expect(center.lat).toBeCloseTo(-34.2, 1);
    });

    it('sync works after direction reversal', () => {
      viewer.reverseDirection();
      viewer.handleProfileClick(50);

      // Should now be at (total - 50) km from original start
      expect(viewer.getCurrentKm()).toBeCloseTo(viewer.totalDistance - 50, 1);
    });
  });

  describe('Waypoint Selection', () => {
    it('selecting waypoint in table highlights on map', () => {
      viewer.selectWaypoint('waypoint-123');

      expect(viewer.getHighlightedMapMarker()).toBe('waypoint-123');
    });

    it('selecting waypoint scrolls table to row', () => {
      viewer.selectWaypointOnMap('waypoint-456');

      expect(viewer.getSelectedTableRow()).toBe('waypoint-456');
    });
  });

  describe('Offline Data Loading', () => {
    it('loads trail from cached JSON', async () => {
      // Simulate offline by blocking network
      await viewer.loadTrail('bibbulmun');

      expect(viewer.waypoints.length).toBeGreaterThan(0);
      expect(viewer.tracks.length).toBeGreaterThan(0);
    });
  });
});
```

### Planning Tools Integration (Part 3)

```typescript
// packages/app/src/integration/planning.test.ts

describe('Campsite Planner', () => {
  let planner: CampsitePlanner;
  let trail: Trail;

  beforeEach(async () => {
    trail = await loadTrail('bibbulmun');
    planner = new CampsitePlanner(trail);
  });

  describe('Day Plan Calculations', () => {
    it('calculates correct stats for each day', () => {
      planner.addStop('campsite-1', 0);  // Night 1
      planner.addStop('campsite-2', 1);  // Night 2

      const days = planner.getDayStats();

      expect(days[0].distance).toBeCloseTo(
        trail.getDistanceBetween('start', 'campsite-1'),
        0.1
      );
      expect(days[0].ascent).toBeGreaterThanOrEqual(0);
    });

    it('recalculates when stops are reordered', () => {
      planner.addStop('campsite-1', 0);
      planner.addStop('campsite-2', 1);
      const originalDay1 = planner.getDayStats()[0].distance;

      planner.moveStop('campsite-2', 0);  // Swap order

      expect(planner.getDayStats()[0].distance).not.toBe(originalDay1);
    });

    it('handles custom stops (non-campsite locations)', () => {
      planner.addCustomStop({ lat: -34.1, lon: 115.9, name: 'Wild camp' }, 0);

      const days = planner.getDayStats();
      expect(days[0]).toBeDefined();
      expect(days[0].destination).toBe('Wild camp');
    });
  });

  describe('Section Hiking', () => {
    it('scopes all calculations to selected section', () => {
      planner.setSection(100, 200);  // km 100 to 200

      const waypoints = planner.getWaypoints();
      expect(waypoints.every(w => w.km >= 100 && w.km <= 200)).toBe(true);
    });

    it('water sources only count within section', () => {
      planner.setSection(100, 200);

      const waterSources = planner.getWaterSources();
      expect(waterSources.every(w => w.km >= 100 && w.km <= 200)).toBe(true);
    });
  });

  describe('Data Persistence', () => {
    it('saves plan to local storage', async () => {
      planner.addStop('campsite-1', 0);
      await planner.save('My Trip');

      const loaded = await CampsitePlanner.load('My Trip');
      expect(loaded.getStops()).toHaveLength(1);
    });

    it('handles multiple plans per trail', async () => {
      await planner.save('Plan A');
      planner.addStop('campsite-1', 0);
      await planner.save('Plan B');

      const plans = await CampsitePlanner.listPlans('bibbulmun');
      expect(plans).toHaveLength(2);
    });
  });
});
```

### GPS and Location Integration (Part 2 & 5)

```typescript
// packages/app/src/integration/location.test.ts

describe('GPS Location', () => {
  let locationService: LocationService;
  let trail: Trail;

  beforeEach(async () => {
    trail = await loadTrail('bibbulmun');
    locationService = new LocationService(trail);
  });

  describe('Track Snapping', () => {
    it('snaps GPS position to nearest track point', () => {
      const gpsPosition = { lat: -34.051, lon: 115.852, accuracy: 10 };
      const snapped = locationService.snapToTrack(gpsPosition);

      expect(snapped.km).toBeDefined();
      expect(snapped.distanceFromTrack).toBeLessThan(50);
    });

    it('prefers forward direction when equidistant', () => {
      // Trail doubles back, user is between two segments
      locationService.setLastKnownDirection('forward');
      const position = { lat: -34.1, lon: 115.9, accuracy: 10 };

      const snapped = locationService.snapToTrack(position);
      expect(snapped.km).toBeGreaterThan(locationService.lastKm);
    });

    it('handles low GPS accuracy gracefully', () => {
      const position = { lat: -34.05, lon: 115.85, accuracy: 150 };
      const snapped = locationService.snapToTrack(position);

      expect(snapped.confidence).toBe('low');
      expect(snapped.km).toBeDefined();  // Still provides best guess
    });
  });

  describe('Off-Trail Detection', () => {
    it('returns on-trail for positions within 50m', () => {
      const position = { lat: -34.0501, lon: 115.8501, accuracy: 10 };
      const status = locationService.getTrailStatus(position);

      expect(status.state).toBe('on-trail');
    });

    it('returns warning for positions 200-500m from trail', () => {
      const position = { lat: -34.055, lon: 115.855, accuracy: 10 };  // ~400m off
      const status = locationService.getTrailStatus(position);

      expect(status.state).toBe('warning');
      expect(status.distanceFromTrail).toBeGreaterThan(200);
    });

    it('returns off-trail with bearing for positions >500m', () => {
      const position = { lat: -34.06, lon: 115.86, accuracy: 10 };  // >500m off
      const status = locationService.getTrailStatus(position);

      expect(status.state).toBe('off-trail');
      expect(status.bearingToTrail).toBeDefined();
    });

    it('suppresses alerts when GPS accuracy is poor', () => {
      const position = { lat: -34.06, lon: 115.86, accuracy: 500 };
      const status = locationService.getTrailStatus(position);

      expect(status.state).toBe('unknown');
      expect(status.message).toContain('GPS accuracy');
    });

    it('debounces to prevent false positives', () => {
      // Momentary spike shouldn't trigger alert
      locationService.updatePosition({ lat: -34.05, lon: 115.85, accuracy: 10 });
      locationService.updatePosition({ lat: -34.08, lon: 115.88, accuracy: 10 });  // Far
      locationService.updatePosition({ lat: -34.05, lon: 115.85, accuracy: 10 });

      expect(locationService.shouldShowAlert()).toBe(false);
    });
  });

  describe('Distance to Waypoints', () => {
    it('calculates distance to next campsite', () => {
      locationService.setCurrentPosition({ km: 50 });

      const next = locationService.getNextWaypoint('campsite');
      expect(next.distance).toBeGreaterThan(0);
      expect(next.name).toBeDefined();
    });

    it('updates in real-time as position changes', () => {
      locationService.setCurrentPosition({ km: 50 });
      const distance1 = locationService.getNextWaypoint('campsite').distance;

      locationService.setCurrentPosition({ km: 55 });
      const distance2 = locationService.getNextWaypoint('campsite').distance;

      expect(distance2).toBe(distance1 - 5);
    });
  });
});
```

---

## E2E Tests

### Web App (Playwright)

```typescript
// tests/e2e/trail-browsing.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Trail Browsing', () => {
  test('homepage shows trail list', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Trail Maps' })).toBeVisible();
    await expect(page.getByText('Bibbulmun Track')).toBeVisible();
  });

  test('clicking trail opens viewer', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Bibbulmun Track');

    await expect(page).toHaveURL(/\/trails\/bibbulmun/);
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('#elevation-profile')).toBeVisible();
  });

  test('waypoint table loads with data', async ({ page }) => {
    await page.goto('/trails/bibbulmun');

    const rows = page.locator('.waypoint-row');
    await expect(rows).toHaveCount({ greaterThan: 10 });
  });
});

test.describe('Trail Viewer Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trails/bibbulmun');
    await page.waitForSelector('#map .leaflet-container');
  });

  test('clicking waypoint in table highlights on map', async ({ page }) => {
    await page.click('.waypoint-row:first-child');

    await expect(page.locator('.leaflet-marker-icon.highlighted')).toBeVisible();
  });

  test('direction reversal updates distances', async ({ page }) => {
    const firstDistance = await page.textContent('.waypoint-row:first-child .distance');

    await page.click('button:has-text("Reverse")');

    const newDistance = await page.textContent('.waypoint-row:first-child .distance');
    expect(newDistance).not.toBe(firstDistance);
  });

  test('expand/collapse variant works', async ({ page }) => {
    const variantRow = page.locator('.waypoint-row.variant');
    if (await variantRow.count() > 0) {
      await variantRow.first().click();
      await expect(page.locator('.variant-details')).toBeVisible();
    }
  });
});
```

### Mobile App (Detox)

```typescript
// packages/app/e2e/trail-viewing.e2e.ts

describe('Trail Viewing', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('shows trail list on launch', async () => {
    await expect(element(by.text('Bibbulmun Track'))).toBeVisible();
  });

  it('opens trail viewer when trail is tapped', async () => {
    await element(by.text('Bibbulmun Track')).tap();

    await expect(element(by.id('map-view'))).toBeVisible();
    await expect(element(by.id('dashboard'))).toBeVisible();
  });

  it('shows distance to next campsite', async () => {
    await element(by.text('Bibbulmun Track')).tap();

    await expect(element(by.id('next-campsite-distance'))).toBeVisible();
    await expect(element(by.id('next-campsite-distance'))).toHaveText(/\d+\.?\d* km/);
  });
});

describe('Offline Mode', () => {
  beforeAll(async () => {
    await device.launchApp();
    // Download trail for offline
    await element(by.text('Bibbulmun Track')).tap();
    await element(by.id('download-offline')).tap();
    await waitFor(element(by.text('Download complete'))).toBeVisible().withTimeout(60000);
  });

  it('trail loads without network', async () => {
    await device.setNetworkConditions({ offline: true });
    await device.reloadReactNative();

    await element(by.text('Bibbulmun Track')).tap();
    await expect(element(by.id('map-view'))).toBeVisible();
  });

  afterAll(async () => {
    await device.setNetworkConditions({ offline: false });
  });
});

describe('Campsite Planning', () => {
  beforeEach(async () => {
    await device.reloadReactNative();
    await element(by.text('Bibbulmun Track')).tap();
    await element(by.id('mode-plan')).tap();
    await element(by.id('tab-day-plan')).tap();
  });

  it('can add campsite stops', async () => {
    await element(by.id('add-campsite')).tap();
    await element(by.text('Helena Campsite')).tap();

    await expect(element(by.id('day-card-1'))).toBeVisible();
  });

  it('shows correct distance for day', async () => {
    await element(by.id('add-campsite')).tap();
    await element(by.text('Helena Campsite')).tap();

    const distanceText = await element(by.id('day-card-1-distance')).getText();
    expect(parseFloat(distanceText)).toBeGreaterThan(0);
  });

  it('updates stats when campsite removed', async () => {
    await element(by.id('add-campsite')).tap();
    await element(by.text('Helena Campsite')).tap();
    await element(by.id('add-campsite')).tap();
    await element(by.text('Chadoora Campsite')).tap();

    const originalDistance = await element(by.id('day-card-1-distance')).getText();

    await element(by.id('day-card-1')).swipe('left');
    await element(by.text('Remove')).tap();

    const newDistance = await element(by.id('day-card-1-distance')).getText();
    expect(newDistance).not.toBe(originalDistance);
  });
});
```

---

## Performance Benchmarks

### Defined Thresholds

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| GPX processing (10MB file) | < 30s | Timer in test |
| App cold start (empty cache) | < 3s | Detox measurement |
| App cold start (500MB cache) | < 3s | Detox measurement |
| Map pan/zoom frame rate | 60 fps | React Native profiler |
| Trail data load | < 500ms | Performance API |
| Distance calculation | < 10ms | Benchmark suite |
| Memory usage (idle) | < 150MB | Device profiler |
| Memory usage (with map) | < 300MB | Device profiler |
| Tile cache read | < 50ms | SQLite benchmark |

### Performance Test Suite

```typescript
// packages/app/src/benchmarks/performance.bench.ts

import { bench, describe } from 'vitest';

describe('Distance Calculations', () => {
  const trail = loadTrailSync('bibbulmun');

  bench('calculate distance between two points', () => {
    haversineDistance3D(
      trail.waypoints[0].lat, trail.waypoints[0].lon, trail.waypoints[0].ele,
      trail.waypoints[50].lat, trail.waypoints[50].lon, trail.waypoints[50].ele
    );
  });

  bench('find next waypoint by type', () => {
    findNextWaypoint(trail, 100, 'campsite');
  });

  bench('calculate all day stats for 30-day plan', () => {
    const planner = new CampsitePlanner(trail);
    for (let i = 0; i < 30; i++) {
      planner.addStop(trail.campsites[i].id, i);
    }
    planner.getDayStats();
  });
});

describe('GPX Processing', () => {
  bench('parse 1MB GPX file', async () => {
    const gpx = await readFile('fixtures/gpx/1mb-trail.gpx');
    await parseGpx(gpx);
  });

  bench('parse 10MB GPX file', async () => {
    const gpx = await readFile('fixtures/gpx/10mb-trail.gpx');
    await parseGpx(gpx);
  }, { timeout: 60000 });

  bench('Douglas-Peucker on 10k points', () => {
    const points = generatePoints(10000);
    simplifyTrack(points, 0.0001);
  });
});

describe('Data Loading', () => {
  bench('load trail JSON from disk', async () => {
    await loadTrail('bibbulmun');
  });

  bench('query waypoints in range', async () => {
    const trail = await loadTrail('bibbulmun');
    trail.getWaypointsInRange(100, 200);
  });
});
```

### Memory Profiling

```typescript
// packages/app/src/benchmarks/memory.test.ts

describe('Memory Usage', () => {
  it('does not leak memory on repeated trail loads', async () => {
    const initialMemory = await getMemoryUsage();

    for (let i = 0; i < 10; i++) {
      await loadTrail('bibbulmun');
      await unloadTrail();
    }

    // Force GC if available
    if (global.gc) global.gc();

    const finalMemory = await getMemoryUsage();
    expect(finalMemory - initialMemory).toBeLessThan(10 * 1024 * 1024); // <10MB growth
  });

  it('handles 500MB tile cache without crash', async () => {
    await populateTileCache(500); // 500MB of tiles

    await loadTrail('bibbulmun');
    await navigateToMap();

    expect(await isAppResponsive()).toBe(true);
  });
});
```

---

## Data Validation Tests

### Golden File Testing

Ensure build output doesn't regress unexpectedly.

```typescript
// src/integration/golden-files.test.ts

describe('Golden File Validation', () => {
  const trails = ['bibbulmun', 'larapinta', 'overland'];

  for (const trailId of trails) {
    describe(trailId, () => {
      it('waypoint count matches expected', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);

        expect(result.waypoints.length).toBe(golden.waypoints.length);
      });

      it('total distance within 1% of expected', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);

        const diff = Math.abs(result.totalDistance - golden.totalDistance);
        const tolerance = golden.totalDistance * 0.01;
        expect(diff).toBeLessThan(tolerance);
      });

      it('waypoint positions match expected', async () => {
        const result = await buildTrail(trailId);
        const golden = await readGolden(`${trailId}.json`);

        for (let i = 0; i < result.waypoints.length; i++) {
          expect(result.waypoints[i].kmPosition)
            .toBeCloseTo(golden.waypoints[i].kmPosition, 1);
        }
      });
    });
  }
});
```

### GPX Source Compatibility

Test with real GPX exports from popular apps.

```typescript
// src/integration/gpx-compatibility.test.ts

describe('GPX Source Compatibility', () => {
  const sources = [
    { name: 'Gaia GPS', file: 'fixtures/gpx/gaia-export.gpx' },
    { name: 'AllTrails', file: 'fixtures/gpx/alltrails-export.gpx' },
    { name: 'Strava', file: 'fixtures/gpx/strava-export.gpx' },
    { name: 'Garmin Connect', file: 'fixtures/gpx/garmin-export.gpx' },
    { name: 'CalTopo', file: 'fixtures/gpx/caltopo-export.gpx' },
  ];

  for (const source of sources) {
    describe(source.name, () => {
      it('parses without error', async () => {
        const gpx = await readFile(source.file);
        await expect(parseGpx(gpx)).resolves.toBeDefined();
      });

      it('extracts track points', async () => {
        const gpx = await readFile(source.file);
        const result = await parseGpx(gpx);

        expect(result.tracks.length).toBeGreaterThan(0);
        expect(result.tracks[0].points.length).toBeGreaterThan(0);
      });

      it('extracts elevation if present', async () => {
        const gpx = await readFile(source.file);
        const result = await parseGpx(gpx);

        // Some exports don't have elevation
        if (result.hasElevation) {
          expect(result.tracks[0].points[0].ele).toBeDefined();
        }
      });
    });
  }
});

describe('Malformed GPX Handling', () => {
  it('handles missing elevation gracefully', async () => {
    const gpx = await readFile('fixtures/gpx/no-elevation.gpx');
    const result = await parseGpx(gpx);

    expect(result.hasElevation).toBe(false);
    expect(result.tracks[0].points[0].ele).toBeNull();
  });

  it('handles empty waypoints array', async () => {
    const gpx = await readFile('fixtures/gpx/no-waypoints.gpx');
    const result = await parseGpx(gpx);

    expect(result.waypoints).toEqual([]);
    expect(result.tracks.length).toBeGreaterThan(0);
  });

  it('rejects invalid XML with clear error', async () => {
    const invalidXml = '<gpx><trk><incomplete>';

    await expect(parseGpx(invalidXml)).rejects.toThrow(/invalid xml/i);
  });

  it('rejects non-GPX XML with clear error', async () => {
    const notGpx = '<html><body>Not a GPX file</body></html>';

    await expect(parseGpx(notGpx)).rejects.toThrow(/not a valid gpx/i);
  });

  it('handles file size limit', async () => {
    const hugeGpx = generateLargeGpx(100); // 100MB

    await expect(parseGpx(hugeGpx)).rejects.toThrow(/file too large/i);
  });
});
```

---

## Field Testing Protocol

Field testing validates what automated tests cannot: real-world conditions, battery life, GPS behavior under canopy, and usability with tired minds and dirty hands.

### Pre-Release Field Test Checklist

**Equipment:**
- [ ] Primary test device (target phone model)
- [ ] Secondary test device (different OS/manufacturer)
- [ ] External battery pack
- [ ] Notepad for observations
- [ ] Known trail section (2-4 hours)

**Test Scenarios:**

| Scenario | Duration | What to Validate |
|----------|----------|-----------------|
| Basic hike with GPS tracking | 2-4 hours | Battery drain, GPS accuracy, off-trail alerts |
| Airplane mode hike | 2-4 hours | Offline functionality, cached tiles work |
| Plan modification mid-hike | 30 min | Can adjust plan, stats recalculate correctly |
| Photo and journal entries | 30 min | Photos geo-tagged correctly, notes save |
| Dense canopy section | 1 hour | GPS behavior, false off-trail alerts |
| Town stop with connectivity | 30 min | Sync behavior, weather update, plan save |

**Measurements to Record:**

```
Trail: ___________________
Date: ___________________
Device: _________________
OS Version: ______________
App Version: _____________

Start Time: _____ Battery: _____%
End Time: _____   Battery: _____%
GPS Active Time: _____ hours
Screen On Time: _____ hours

GPS Issues:
[ ] Consistent lock
[ ] Occasional dropouts (describe: _____________)
[ ] Long time to first fix
[ ] Poor accuracy under canopy

Off-Trail Alerts:
[ ] No false positives
[ ] False positives (count: _____, describe: _____________)
[ ] Missed alerts when actually off trail

Usability Notes:
_______________________________________________
_______________________________________________

Bugs Found:
_______________________________________________
_______________________________________________
```

### Battery Drain Targets

| Scenario | Target | Maximum |
|----------|--------|---------|
| GPS active, screen on | 15%/hour | 20%/hour |
| GPS active, screen off | 5%/hour | 8%/hour |
| GPS inactive (planning mode) | 3%/hour | 5%/hour |
| Overnight (app backgrounded) | <2% | 5% |

---

## Platform-Specific Testing

### iOS Considerations

```typescript
// e2e/ios-specific.e2e.ts

describe('iOS-Specific', () => {
  it('requests location permission correctly', async () => {
    await device.launchApp({ permissions: { location: 'unset' } });
    await element(by.text('Bibbulmun Track')).tap();
    await element(by.id('mode-hike')).tap();

    // Should see permission dialog
    await expect(element(by.text('Allow While Using App'))).toBeVisible();
  });

  it('handles location permission denial gracefully', async () => {
    await device.launchApp({ permissions: { location: 'never' } });
    await element(by.text('Bibbulmun Track')).tap();
    await element(by.id('mode-hike')).tap();

    // Should show helpful message, not crash
    await expect(element(by.text('Location access required'))).toBeVisible();
    await expect(element(by.id('open-settings-button'))).toBeVisible();
  });

  it('background location works with Always permission', async () => {
    await device.launchApp({ permissions: { location: 'always' } });
    // Start recording
    await element(by.id('start-recording')).tap();

    // Background the app
    await device.sendToHome();
    await sleep(60000); // 1 minute

    // Return to app
    await device.launchApp();

    // Should have recorded points while backgrounded
    const pointCount = await element(by.id('recorded-points-count')).getText();
    expect(parseInt(pointCount)).toBeGreaterThan(0);
  });
});
```

### Android Considerations

```typescript
// e2e/android-specific.e2e.ts

describe('Android-Specific', () => {
  it('handles Doze mode correctly', async () => {
    await device.launchApp();
    await element(by.id('start-recording')).tap();

    // Simulate Doze mode
    await device.executeShellCommand('dumpsys deviceidle force-idle');
    await sleep(120000); // 2 minutes
    await device.executeShellCommand('dumpsys deviceidle unforce');

    await device.launchApp();

    // Recording should have reasonable continuity
    const gaps = await element(by.id('recording-gaps')).getText();
    expect(parseInt(gaps)).toBeLessThan(3);
  });

  it('handles low storage gracefully', async () => {
    // Fill storage to near capacity
    await device.executeShellCommand('dd if=/dev/zero of=/sdcard/filler bs=1M count=100');

    await device.launchApp();
    await element(by.text('Bibbulmun Track')).tap();
    await element(by.id('download-offline')).tap();

    // Should warn, not crash
    await expect(element(by.text('Not enough storage'))).toBeVisible();

    // Cleanup
    await device.executeShellCommand('rm /sdcard/filler');
  });
});
```

---

## Test Fixtures

### Required GPX Test Files

Create or obtain these fixtures:

```
tests/fixtures/gpx/
  # Real exports from popular apps
  gaia-export.gpx          # Export from Gaia GPS
  alltrails-export.gpx     # Export from AllTrails
  strava-export.gpx        # Export from Strava
  garmin-export.gpx        # Export from Garmin Connect
  caltopo-export.gpx       # Export from CalTopo

  # Edge cases
  no-elevation.gpx         # Track without elevation data
  no-waypoints.gpx         # Track only, no waypoints
  multi-track.gpx          # Multiple track segments
  track-with-gaps.gpx      # Non-continuous track
  huge-file.gpx            # 10MB+ for performance testing
  malformed.gpx            # Invalid XML structure

  # Reference trails
  bibbulmun.gpx            # Known good trail data
  simple-trail.gpx         # Small trail for unit tests
  trail-with-variants.gpx  # Main + alternate tracks
```

### Expected Output Files

```
tests/fixtures/expected/
  bibbulmun.json           # Golden file for Bibbulmun build
  simple-trail.json        # Golden file for simple trail
```

---

## Success Criteria

### Part 0 Complete When:
- [ ] Test infrastructure set up (Vitest, Playwright, Detox)
- [ ] CI pipeline runs all test levels
- [ ] Fixture files collected
- [ ] Performance benchmark baseline established

### Each Part Complete When:
- [ ] All unit tests pass
- [ ] Integration tests for new features pass
- [ ] E2E tests updated if UI changed
- [ ] Performance benchmarks still meet targets
- [ ] No regression in golden file tests

### Pre-Release Checklist:
- [ ] All automated tests pass
- [ ] Field testing completed on at least 2 devices
- [ ] Battery drain within targets
- [ ] No false positive off-trail alerts during field test
- [ ] Memory usage stable over multi-hour session
- [ ] Performance benchmarks pass

---

## Implementation Priority

1. **Immediate (Part 0)**
   - Set up integration test infrastructure
   - Create golden files for existing trails
   - Add unit tests for `gpx-parser.ts`

2. **Part 2 (Offline Viewer)**
   - GPS accuracy handling tests
   - Track snapping tests
   - Offline tile caching tests

3. **Part 3 (Planning)**
   - Day calculation tests
   - Plan persistence tests
   - Section hiking tests

4. **Part 5 (On-Trail)**
   - Off-trail detection tests
   - Field testing protocol execution

---

## Dependencies

- Part 0: Foundation (test infrastructure is part of foundation)
- All other parts: This testing strategy

## Notes

- Tests should be written alongside feature code, not after
- Field testing should happen before each major release
- Performance benchmarks should be re-run after major changes
- Golden files should be updated intentionally, with review
