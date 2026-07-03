import type { Trail, TrackPoint, TrailWaypoint } from '../../lib/trail-utils';
import { measureBetweenPoints } from '../measure-service';

// ---------------------------------------------------------------------------
// Helpers: build a synthetic trail for testing
// ---------------------------------------------------------------------------

function makeTrackPoints(totalKm: number, count: number): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    points.push({
      lat: -33 + frac * 0.1,
      lon: 115 + frac * 0.1,
      ele: 200 + Math.sin(frac * Math.PI * 10) * 100,
      dist: frac * totalKm,
    });
  }
  return points;
}

function makeWaypoints(stops: { name: string; type: string; km: number }[]): TrailWaypoint[] {
  return stops.map((s, i) => ({
    id: `wp-${i}`,
    name: s.name,
    lat: -33,
    lon: 115,
    type: s.type,
    totalDistance: s.km,
  }));
}

function makeTrail(totalKm: number, waypoints: TrailWaypoint[]): Trail {
  const points = makeTrackPoints(totalKm, 500);
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
      totalAscent: 5000,
      totalDescent: 5000,
    },
    waypoints,
  };
}

// ---------------------------------------------------------------------------
// measureBetweenPoints
// ---------------------------------------------------------------------------

describe('measureBetweenPoints', () => {
  const waypoints = makeWaypoints([
    { name: 'Trailhead', type: 'trailhead', km: 0 },
    { name: 'Creek', type: 'water', km: 10 },
    { name: 'Camp A', type: 'campsite', km: 20 },
    { name: 'River', type: 'water', km: 30 },
    { name: 'Tank', type: 'water-tank', km: 40 },
    { name: 'Town End', type: 'town', km: 50 },
  ]);

  const trail = makeTrail(50, waypoints);

  it('computes correct distance', () => {
    const result = measureBetweenPoints(trail, 10, 30);
    expect(result.distanceKm).toBe(20);
  });

  it('handles reversed order (endKm < startKm) — normalizes', () => {
    const result = measureBetweenPoints(trail, 30, 10);
    expect(result.startKm).toBe(10);
    expect(result.endKm).toBe(30);
    expect(result.distanceKm).toBe(20);
  });

  it('returns correct waypoints between two points', () => {
    const result = measureBetweenPoints(trail, 5, 35);
    const names = result.waypointsBetween.map(wp => wp.name);
    expect(names).toContain('Creek');
    expect(names).toContain('Camp A');
    expect(names).toContain('River');
    // Boundary waypoints should not be included (only strictly between)
    expect(names).not.toContain('Trailhead');
    expect(names).not.toContain('Tank');
  });

  it('finds nearest waypoint names for start/end', () => {
    const result = measureBetweenPoints(trail, 10, 40);
    expect(result.startName).toBe('Creek');
    expect(result.endName).toBe('Tank');
  });

  it('returns 0 distance when startKm === endKm', () => {
    const result = measureBetweenPoints(trail, 25, 25);
    expect(result.distanceKm).toBe(0);
  });

  it('counts water sources in range', () => {
    // Creek at 10, River at 30, Tank at 40
    const result = measureBetweenPoints(trail, 5, 45);
    expect(result.waterSourceCount).toBe(3);
  });

  it('computes elevation gain and loss (non-negative values)', () => {
    const result = measureBetweenPoints(trail, 0, 50);
    expect(result.ascentM).toBeGreaterThanOrEqual(0);
    expect(result.descentM).toBeGreaterThanOrEqual(0);
  });

  it('computes estimated hours (positive value)', () => {
    const result = measureBetweenPoints(trail, 10, 30);
    // 20 km at minimum → 5h flat; with elevation it should be at least that
    expect(result.estimatedHours).toBeGreaterThan(0);
  });

  it('returns empty waypointsBetween when no waypoints in range', () => {
    // Range 21-29 has no waypoints (Camp A at 20, River at 30 are boundaries)
    const result = measureBetweenPoints(trail, 21, 29);
    expect(result.waypointsBetween).toEqual([]);
  });

  it('finds nearest name even when first waypoint is far away', () => {
    // First waypoint (Trailhead at km 0) is >2km from start (km 5).
    // Creek at km 10 is also >2km from start (km 5) — but should still find Creek within 2km? No, 5km away.
    // Let's measure from km 9 to km 31 — Creek at 10 is within 2km of 9, River at 30 is within 2km of 31.
    const result = measureBetweenPoints(trail, 9, 31);
    expect(result.startName).toBe('Creek');
    expect(result.endName).toBe('River');
  });

  it('returns undefined names when no waypoints within 2km', () => {
    // Sparse trail with waypoints far apart
    const sparseWaypoints = makeWaypoints([
      { name: 'Start', type: 'trailhead', km: 0 },
      { name: 'End', type: 'trailhead', km: 50 },
    ]);
    const sparseTrail = makeTrail(50, sparseWaypoints);
    // Measure from km 20 to km 30 — no waypoint within 2km of either
    const result = measureBetweenPoints(sparseTrail, 20, 30);
    expect(result.startName).toBeUndefined();
    expect(result.endName).toBeUndefined();
  });

  it('handles measurement at trail boundaries (0 to totalDistance)', () => {
    const result = measureBetweenPoints(trail, 0, 50);
    expect(result.startKm).toBe(0);
    expect(result.endKm).toBe(50);
    expect(result.distanceKm).toBe(50);
    expect(result.startName).toBe('Trailhead');
    expect(result.endName).toBe('Town End');
    // All internal waypoints should be between
    expect(result.waypointsBetween.length).toBe(4); // Creek, Camp A, River, Tank
  });
});
