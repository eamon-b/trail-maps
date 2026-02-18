import type { Trail, TrackPoint, TrailWaypoint } from '../../lib/trail-utils';
import {
  generateDatasheet,
  hasElevationData,
  datasheetToText,
  datasheetToCsv,
} from '../datasheet-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrackPoints(totalKm: number, count: number, withElevation = true): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    points.push({
      lat: -33 + frac * 0.1,
      lon: 115 + frac * 0.1,
      ele: withElevation ? 200 + Math.sin(frac * Math.PI * 4) * 100 : 0,
      dist: frac * totalKm,
    });
  }
  return points;
}

function makeWaypoints(stops: { name: string; type: string; km: number }[]): TrailWaypoint[] {
  return stops.map(s => ({
    name: s.name,
    lat: -33,
    lon: 115,
    type: s.type,
    totalDistance: s.km,
  }));
}

function makeTrail(
  totalKm: number,
  waypoints: TrailWaypoint[],
  withElevation = true,
): Trail {
  const points = makeTrackPoints(totalKm, 500, withElevation);
  const totalAscent = withElevation ? 3000 : 0;
  return {
    config: {
      id: 'test-trail',
      name: 'Test Trail',
      shortName: 'TT',
      region: 'Test',
      lengthKm: totalKm,
      direction: { default: 'NOBO', reversed: 'SOBO' },
    },
    track: {
      points,
      totalDistance: totalKm,
      totalAscent,
      totalDescent: totalAscent,
    },
    waypoints,
  };
}

// ---------------------------------------------------------------------------
// hasElevationData
// ---------------------------------------------------------------------------

describe('hasElevationData', () => {
  it('returns true when track points have non-zero elevations', () => {
    const points = makeTrackPoints(100, 10, true);
    expect(hasElevationData(points)).toBe(true);
  });

  it('returns false when all elevations are 0', () => {
    const points = makeTrackPoints(100, 10, false);
    expect(hasElevationData(points)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasElevationData([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateDatasheet
// ---------------------------------------------------------------------------

describe('generateDatasheet', () => {
  const waypoints = makeWaypoints([
    { name: 'Trailhead A', type: 'trailhead', km: 0.2 },
    { name: 'Camp 1', type: 'campsite', km: 15 },
    { name: 'Water Creek', type: 'water', km: 25 },
    { name: 'Town B', type: 'town', km: 40 },
    { name: 'Shelter C', type: 'shelter', km: 60 },
    { name: 'Camp 2', type: 'campsite', km: 80 },
    { name: 'End Point', type: 'trailhead', km: 99.5 },
  ]);

  it('generates sections between significant waypoints', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    expect(ds.sections.length).toBeGreaterThan(0);
    expect(ds.summary.sectionCount).toBe(ds.sections.length);
  });

  it('summary has correct total distance', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    expect(ds.summary.totalDistanceKm).toBe(100);
  });

  it('cumulative distance of last section matches total', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    const lastSection = ds.sections[ds.sections.length - 1];
    expect(lastSection.cumulativeKm).toBeCloseTo(100, 0);
  });

  it('section distances sum to approximately total distance', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    const sumDistance = ds.sections.reduce((sum, s) => sum + s.distanceKm, 0);
    expect(sumDistance).toBeCloseTo(100, 0);
  });

  it('has elevation data flag set correctly', () => {
    const trail = makeTrail(100, waypoints, true);
    const ds = generateDatasheet(trail);
    expect(ds.summary.hasElevation).toBe(true);

    const trailNoEle = makeTrail(100, waypoints, false);
    const dsNoEle = generateDatasheet(trailNoEle);
    expect(dsNoEle.summary.hasElevation).toBe(false);
  });

  it('identifies resupply points (town waypoints)', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    expect(ds.summary.resupplyPoints).toEqual([
      { name: 'Town B', km: 40 },
    ]);
  });

  it('estimates days based on pace', () => {
    const trail = makeTrail(100, waypoints);
    const ds20 = generateDatasheet(trail, 20);
    expect(ds20.summary.estimatedDays).toBe(5); // 100 / 20 = 5

    const ds25 = generateDatasheet(trail, 25);
    expect(ds25.summary.estimatedDays).toBe(4); // ceil(100 / 25) = 4
  });

  it('works with no waypoints', () => {
    const trail = makeTrail(100, []);
    const ds = generateDatasheet(trail);
    // With no waypoints, only start→end section exists
    expect(ds.sections.length).toBe(1);
    expect(ds.sections[0].distanceKm).toBeCloseTo(100, 0);
  });

  it('generates distance-only time estimates when no elevation', () => {
    const trail = makeTrail(100, waypoints, false);
    const ds = generateDatasheet(trail);

    // With no elevation, time should be distance / 4 km/h
    for (const section of ds.sections) {
      expect(section.ascentM).toBe(0);
      expect(section.descentM).toBe(0);
      const expectedHours = Math.round((section.distanceKm / 4) * 10) / 10;
      expect(section.estimatedHours).toBe(expectedHours);
    }
  });

  it('each section has positive distance', () => {
    const trail = makeTrail(100, waypoints);
    const ds = generateDatasheet(trail);

    for (const section of ds.sections) {
      expect(section.distanceKm).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// datasheetToText
// ---------------------------------------------------------------------------

describe('datasheetToText', () => {
  it('includes trail name and section count', () => {
    const trail = makeTrail(100, makeWaypoints([
      { name: 'Camp A', type: 'campsite', km: 30 },
      { name: 'Camp B', type: 'campsite', km: 70 },
    ]));
    const ds = generateDatasheet(trail);
    const text = datasheetToText(ds);

    expect(text).toContain('Test Trail');
    expect(text).toContain('100 km');
    expect(text).toContain('Sections:');
  });

  it('includes resupply points', () => {
    const trail = makeTrail(100, makeWaypoints([
      { name: 'Springfield', type: 'town', km: 50 },
    ]));
    const ds = generateDatasheet(trail);
    const text = datasheetToText(ds);

    expect(text).toContain('Springfield');
    expect(text).toContain('Resupply');
  });
});

// ---------------------------------------------------------------------------
// datasheetToCsv
// ---------------------------------------------------------------------------

describe('datasheetToCsv', () => {
  it('produces valid CSV with header row', () => {
    const trail = makeTrail(100, makeWaypoints([
      { name: 'Camp A', type: 'campsite', km: 30 },
      { name: 'Camp B', type: 'campsite', km: 70 },
    ]));
    const ds = generateDatasheet(trail);
    const csv = datasheetToCsv(ds);

    const lines = csv.split('\n');
    expect(lines.length).toBeGreaterThan(1); // header + data rows
    expect(lines[0]).toContain('Section');
    expect(lines[0]).toContain('Distance');
  });

  it('escapes names with commas', () => {
    const trail = makeTrail(100, makeWaypoints([
      { name: 'Camp A, North', type: 'campsite', km: 50 },
    ]));
    const ds = generateDatasheet(trail);
    const csv = datasheetToCsv(ds);

    expect(csv).toContain('"Camp A, North"');
  });

  it('omits elevation columns when no elevation data', () => {
    const trail = makeTrail(100, makeWaypoints([
      { name: 'Camp A', type: 'campsite', km: 50 },
    ]), false);
    const ds = generateDatasheet(trail);
    const csv = datasheetToCsv(ds);

    expect(csv).not.toContain('Ascent');
    expect(csv).not.toContain('Descent');
  });
});
