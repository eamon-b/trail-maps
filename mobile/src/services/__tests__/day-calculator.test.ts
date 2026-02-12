import type { Trail, TrackPoint, TrailWaypoint } from '../../lib/trail-utils';
import type { StopData } from '../plan-calculator-types';
import {
  estimateHikingTime,
  countWaterSources,
  addStop,
  removeStop,
  computeDays,
} from '../day-calculator';

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
      // Gentle hills: 200m of undulation per 100 km
      ele: 200 + Math.sin(frac * Math.PI * 10) * 100,
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
// estimateHikingTime
// ---------------------------------------------------------------------------

describe('estimateHikingTime', () => {
  it('returns distance/4 for flat terrain', () => {
    expect(estimateHikingTime(20, 0, 0)).toBe(5);
  });

  it('adds ascent/600', () => {
    // 20km flat = 5h, + 600m ascent = 1h → 6h
    expect(estimateHikingTime(20, 600, 0)).toBe(6);
  });

  it('adds descent penalty only above 300m', () => {
    // 20km = 5h, no ascent, 600m descent → (600-300)/600 = 0.5h → 5.5h
    expect(estimateHikingTime(20, 0, 600)).toBe(5.5);
  });

  it('no descent penalty for moderate descent', () => {
    expect(estimateHikingTime(20, 0, 200)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// countWaterSources
// ---------------------------------------------------------------------------

describe('countWaterSources', () => {
  const waypoints = makeWaypoints([
    { name: 'Camp A', type: 'campsite', km: 10 },
    { name: 'Creek', type: 'water', km: 15 },
    { name: 'Tank', type: 'water-tank', km: 20 },
    { name: 'Camp B', type: 'campsite', km: 25 },
    { name: 'River', type: 'water', km: 30 },
  ]);

  it('counts water and water-tank types in range', () => {
    expect(countWaterSources(10, 25, waypoints)).toBe(2);
  });

  it('excludes start boundary, includes end boundary', () => {
    // km 15 is exactly at Creek — should be counted when endKm=15
    expect(countWaterSources(10, 15, waypoints)).toBe(1);
    // km 15 start — Creek at 15 should NOT be counted (> start, not >=)
    expect(countWaterSources(15, 25, waypoints)).toBe(1);
  });

  it('returns 0 when no water in range', () => {
    expect(countWaterSources(0, 10, waypoints)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// addStop / removeStop
// ---------------------------------------------------------------------------

describe('addStop', () => {
  const existing: StopData[] = [
    { id: 'a', waypointName: 'A', waypointType: 'campsite', km: 10 },
    { id: 'c', waypointName: 'C', waypointType: 'campsite', km: 30 },
  ];

  it('inserts in km-sorted order', () => {
    const result = addStop(existing, { id: 'b2', waypointName: 'B', waypointType: 'hut', km: 20 });
    expect(result.map(s => s.waypointName)).toEqual(['A', 'B', 'C']);
  });

  it('appends if km is beyond all existing', () => {
    const result = addStop(existing, { id: 'd', waypointName: 'D', waypointType: 'town', km: 40 });
    expect(result.map(s => s.waypointName)).toEqual(['A', 'C', 'D']);
  });

  it('does not mutate the original array', () => {
    addStop(existing, { id: 'x', waypointName: 'X', waypointType: 'campsite', km: 5 });
    expect(existing).toHaveLength(2);
  });
});

describe('removeStop', () => {
  const stops: StopData[] = [
    { id: 'a', waypointName: 'A', waypointType: 'campsite', km: 10 },
    { id: 'b', waypointName: 'B', waypointType: 'campsite', km: 20 },
    { id: 'c', waypointName: 'C', waypointType: 'campsite', km: 30 },
  ];

  it('removes by index', () => {
    const result = removeStop(stops, 1);
    expect(result.map(s => s.waypointName)).toEqual(['A', 'C']);
  });

  it('does not mutate the original', () => {
    removeStop(stops, 0);
    expect(stops).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// computeDays
// ---------------------------------------------------------------------------

describe('computeDays', () => {
  const waypoints = makeWaypoints([
    { name: 'Trailhead', type: 'trailhead', km: 0 },
    { name: 'Creek', type: 'water', km: 8 },
    { name: 'Camp A', type: 'campsite', km: 15 },
    { name: 'River', type: 'water', km: 22 },
    { name: 'Camp B', type: 'campsite', km: 30 },
    { name: 'Tank', type: 'water-tank', km: 38 },
    { name: 'Town End', type: 'town', km: 50 },
  ]);

  const trail = makeTrail(50, waypoints);

  it('produces 1 day with no stops', () => {
    const days = computeDays(trail, []);
    expect(days).toHaveLength(1);
    expect(days[0].dayNumber).toBe(1);
    expect(days[0].startName).toBe('Trailhead');
    expect(days[0].endName).toBe('Town End');
    expect(days[0].distanceKm).toBe(50);
  });

  it('produces N+1 days for N stops', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
      { id: 'cb', waypointName: 'Camp B', waypointType: 'campsite', km: 30 },
    ];
    const days = computeDays(trail, stops);
    expect(days).toHaveLength(3);

    expect(days[0].startName).toBe('Trailhead');
    expect(days[0].endName).toBe('Camp A');
    expect(days[0].distanceKm).toBe(15);

    expect(days[1].startName).toBe('Camp A');
    expect(days[1].endName).toBe('Camp B');
    expect(days[1].distanceKm).toBe(15);

    expect(days[2].startName).toBe('Camp B');
    expect(days[2].endName).toBe('Town End');
    expect(days[2].distanceKm).toBe(20);
  });

  it('counts water sources per day', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
      { id: 'cb', waypointName: 'Camp B', waypointType: 'campsite', km: 30 },
    ];
    const days = computeDays(trail, stops);
    // Day 1 (0-15): Creek at 8 → 1 water
    expect(days[0].waterSources).toBe(1);
    // Day 2 (15-30): River at 22 → 1 water
    expect(days[1].waterSources).toBe(1);
    // Day 3 (30-50): Tank at 38 → 1 water
    expect(days[2].waterSources).toBe(1);
  });

  it('assigns dates when startDate is provided', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
    ];
    const days = computeDays(trail, stops, '2026-04-01');
    expect(days[0].date).toBe('2026-04-01');
    expect(days[1].date).toBe('2026-04-02');
  });

  it('has no dates when startDate is null', () => {
    const days = computeDays(trail, [], null);
    expect(days[0].date).toBeUndefined();
  });

  it('computes elevation gain and loss', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
    ];
    const days = computeDays(trail, stops);
    // Should have non-negative elevation values from the sine wave track
    expect(days[0].ascentM).toBeGreaterThanOrEqual(0);
    expect(days[0].descentM).toBeGreaterThanOrEqual(0);
  });

  it('computes estimated hours', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
    ];
    const days = computeDays(trail, stops);
    // 15km minimum → at least 3.75h even on flat terrain
    expect(days[0].estimatedHours).toBeGreaterThanOrEqual(3);
  });

  it('handles custom stops with null waypointName', () => {
    const stops: StopData[] = [
      {
        id: 'custom1',
        waypointName: null,
        waypointType: 'campsite',
        km: 20,
        customLocation: { lat: -33, lon: 115, name: 'My Spot' },
      },
    ];
    const days = computeDays(trail, stops);
    expect(days).toHaveLength(2);
    expect(days[0].endName).toBe('My Spot');
    expect(days[1].startName).toBe('My Spot');
  });

  it('uses trail config name as fallback for empty waypoint list', () => {
    const emptyWpTrail = makeTrail(50, []);
    const days = computeDays(emptyWpTrail, []);
    expect(days[0].startName).toBe('Test Trail Start');
    expect(days[0].endName).toBe('Test Trail End');
  });

  it('scopes to section when section config is provided', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
      { id: 'cb', waypointName: 'Camp B', waypointType: 'campsite', km: 30 },
    ];
    const section = { startKm: 10, endKm: 40, startName: 'Section Start', endName: 'Section End' };
    const days = computeDays(trail, stops, null, section);
    // Section includes Camp A (15) and Camp B (30)
    expect(days).toHaveLength(3);
    expect(days[0].startName).toBe('Section Start');
    expect(days[0].startKm).toBe(10);
    expect(days[0].endName).toBe('Camp A');
    expect(days[2].endName).toBe('Section End');
    expect(days[2].endKm).toBe(40);
  });

  it('filters stops outside section range', () => {
    const stops: StopData[] = [
      { id: 'ca', waypointName: 'Camp A', waypointType: 'campsite', km: 15 },
      { id: 'cb', waypointName: 'Camp B', waypointType: 'campsite', km: 30 },
    ];
    // Section only includes Camp A
    const section = { startKm: 10, endKm: 25, startName: 'S', endName: 'E' };
    const days = computeDays(trail, stops, null, section);
    expect(days).toHaveLength(2);
    expect(days[0].endName).toBe('Camp A');
    expect(days[1].endName).toBe('E');
  });
});
