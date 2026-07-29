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
