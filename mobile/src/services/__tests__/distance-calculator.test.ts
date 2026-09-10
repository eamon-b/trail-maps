import {
  calculateDistancesToWaypoints,
  getNextWaypointsByType,
  formatEtaMinutes,
  type DistanceWaypoint,
} from '../distance-calculator';
import type { ElevationPoint } from '@lib/track-geometry';

// Flat 10 km track (no elevation change → ETA is pure distance / 4 km/h).
const TRACK: ElevationPoint[] = Array.from({ length: 11 }, (_, i) => ({
  dist: i,
  ele: 100,
}));

const WAYPOINTS: DistanceWaypoint[] = [
  { id: 'a', name: 'Trailhead', type: 'trailhead', totalDistance: 0 },
  { id: 'b', name: 'Spring', type: 'water', totalDistance: 2 },
  { id: 'c', name: 'Camp One', type: 'campsite', totalDistance: 4 },
  { id: 'd', name: 'Township', type: 'town', totalDistance: 6 },
  { id: 'e', name: 'Old Hut', type: 'hut', totalDistance: 8 },
];

describe('calculateDistancesToWaypoints', () => {
  it('keeps only waypoints ahead of the current position', () => {
    const result = calculateDistancesToWaypoints(3, WAYPOINTS, TRACK);
    expect(result.map((r) => r.waypoint.name)).toEqual(['Camp One', 'Township', 'Old Hut']);
    expect(result[0].trailDistanceKm).toBeCloseTo(1, 5);
  });

  it('computes a Naismith ETA (flat → distance / 4 km/h)', () => {
    const [first] = calculateDistancesToWaypoints(0, [WAYPOINTS[1]], TRACK);
    // 2 km / 4 km/h = 0.5 h = 30 min.
    expect(first.etaMinutes).toBeCloseTo(30, 0);
  });

  it('scales the ETA by the base speed (pace preference)', () => {
    // Same flat 2 km segment at slow (3 km/h) and fast (5 km/h) bases.
    const [slow] = calculateDistancesToWaypoints(0, [WAYPOINTS[1]], TRACK, 3);
    const [fast] = calculateDistancesToWaypoints(0, [WAYPOINTS[1]], TRACK, 5);
    // 2 km / 3 km/h = 0.667 h → rounded to 0.7 h = 42 min;
    // 2 km / 5 km/h = 0.4 h = 24 min (estimateHikingTime rounds to 0.1 h).
    expect(slow.etaMinutes).toBeCloseTo(42, 0);
    expect(fast.etaMinutes).toBeCloseTo(24, 0);
    // Slower pace is always the longer ETA.
    expect(slow.etaMinutes).toBeGreaterThan(fast.etaMinutes);
  });

  it('defaults to 4 km/h when no base speed is passed', () => {
    const [withDefault] = calculateDistancesToWaypoints(0, [WAYPOINTS[1]], TRACK);
    const [explicit] = calculateDistancesToWaypoints(0, [WAYPOINTS[1]], TRACK, 4);
    expect(withDefault.etaMinutes).toBeCloseTo(explicit.etaMinutes, 5);
  });
});

describe('getNextWaypointsByType', () => {
  it('picks the next of each important type ahead', () => {
    const next = getNextWaypointsByType(1, WAYPOINTS, TRACK);
    expect(next.water?.waypoint.name).toBe('Spring');
    expect(next.campsite?.waypoint.name).toBe('Camp One');
    expect(next.town?.waypoint.name).toBe('Township');
    // 'hut' maps to the shelter bucket.
    expect(next.shelter?.waypoint.name).toBe('Old Hut');
  });

  it('is direction-aware: reversed km ordering flips which waypoint is "next"', () => {
    // Emulate a reversed guide as the strip does: mirror each km about the 10 km
    // total, then feed the waypoints distance-sorted ascending.
    const reversed = WAYPOINTS.map((w) => ({
      ...w,
      totalDistance: 10 - (w.totalDistance ?? 0),
    })).sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));

    // Hiker at km 1 in the reversed frame: the next water is the mirrored Spring
    // (now at km 8, i.e. 7 km ahead).
    const next = getNextWaypointsByType(1, reversed, TRACK);
    expect(next.water?.waypoint.name).toBe('Spring');
    expect(next.water?.trailDistanceKm).toBeCloseTo(7, 5);

    // Travelling reversed, the hut (km 2) then town (km 4) come before the camp.
    const ahead = calculateDistancesToWaypoints(1, reversed, TRACK).map((r) => r.waypoint.name);
    expect(ahead).toEqual(['Old Hut', 'Township', 'Camp One', 'Spring', 'Trailhead']);
  });
});

describe('formatEtaMinutes', () => {
  it('formats sub-hour and multi-hour ETAs', () => {
    expect(formatEtaMinutes(2)).toBe('~5 min');
    expect(formatEtaMinutes(50)).toBe('~50 min');
    expect(formatEtaMinutes(130)).toBe('~2 h 10 min');
    expect(formatEtaMinutes(120)).toBe('~2 h');
  });
});

describe('getNextWaypointsByType — turn-offs', () => {
  const at = (km: number, name: string, type: string): DistanceWaypoint => ({
    id: name,
    name,
    type,
    totalDistance: km,
  });

  it('counts a turn-off to somewhere you can buy food as the next town', () => {
    for (const type of ['town-access', 'food-access', 'resupply-access']) {
      const next = getNextWaypointsByType(0, [at(2, 'Te Anau turnoff', type)], TRACK);
      expect(next.town?.waypoint.name).toBe('Te Anau turnoff');
    }
  });

  it('does not offer a hut or campsite turn-off as the next shelter or camp', () => {
    const next = getNextWaypointsByType(
      0,
      [
        at(1, 'Blyth Hut turnoff', 'hut-access'),
        at(2, 'Camp turnoff', 'campsite-access'),
        at(3, 'Blyth Hut', 'hut'),
        at(4, 'Camp', 'campsite'),
      ],
      TRACK,
    );
    expect(next.shelter?.waypoint.name).toBe('Blyth Hut');
    expect(next.campsite?.waypoint.name).toBe('Camp');
  });

  it('never reads a water turn-off as water on the route', () => {
    const next = getNextWaypointsByType(0, [at(2, 'Spring turnoff', 'water-access')], TRACK);
    expect(next.water).toBeUndefined();
  });
});

describe('calculateDistancesToWaypoints across a route break', () => {
  // Flat 9 km with a ferry at km 4 (points[5] is the far landing, 600 m
  // higher). km does not advance across it and the climb is not walked.
  const FERRY_TRACK: ElevationPoint[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ dist: i, ele: 100 })),
    ...Array.from({ length: 6 }, (_, i) => ({ dist: 4 + i, ele: 700 })),
  ];
  const END: DistanceWaypoint = { id: 'z', name: 'Far end', type: 'trailhead', totalDistance: 9 };

  it('leaves the climb across the break out of the ETA', () => {
    const [withBreak] = calculateDistancesToWaypoints(0, [END], FERRY_TRACK, 4, new Set([5]));
    expect(withBreak.elevationGain).toBe(0);
    // 9 km / 4 km/h = 2.25 h → 2.3 h after estimateHikingTime's rounding.
    expect(withBreak.etaMinutes).toBeCloseTo(138, 0);

    const [unaware] = calculateDistancesToWaypoints(0, [END], FERRY_TRACK, 4);
    expect(unaware.elevationGain).toBe(600);
  });
});
