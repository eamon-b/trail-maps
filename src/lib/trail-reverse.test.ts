/**
 * Tests for shared trail direction reversal.
 *
 * The fixtures are ported from the mobile suite
 * (mobile/src/lib/__tests__/trail-utils.test.ts) so the shared module is
 * locked to the behaviour the mobile app already ships; the mobile suite
 * keeps running against its re-exports as integration insurance.
 */

import { describe, it, expect } from 'vitest';
import {
  reverseTrackPoints,
  reverseWaypoints,
  createReversedTrail,
  type ReversibleTrail,
  type ReversibleWaypoint,
} from './trail-reverse';

interface TestPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
}

function makePoints(distances: number[]): TestPoint[] {
  return distances.map((d, i) => ({
    lat: -33 + i * 0.01,
    lon: 115 + i * 0.01,
    ele: 100 + i * 10,
    dist: d,
  }));
}

describe('reverseTrackPoints', () => {
  it('reverses points and recalculates distances', () => {
    const points = makePoints([0, 10, 30, 50]);
    const reversed = reverseTrackPoints(points, 50);

    expect(reversed).toHaveLength(4);
    expect(reversed[0].dist).toBe(0);
    expect(reversed[1].dist).toBe(20);
    expect(reversed[2].dist).toBe(40);
    expect(reversed[3].dist).toBe(50);
    // Lat/lon should be reversed order
    expect(reversed[0].lat).toBe(points[3].lat);
  });

  it('handles empty array', () => {
    expect(reverseTrackPoints([], 0)).toEqual([]);
  });

  it('handles single point', () => {
    const points = makePoints([0]);
    const reversed = reverseTrackPoints(points, 0);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].dist).toBe(0);
  });
});

describe('reverseWaypoints', () => {
  it('reverses waypoints and maps endpoints 0 <-> total', () => {
    const waypoints = [
      { id: 'wp-0', name: 'Start', type: 'trailhead', totalDistance: 0, ascent: 0, descent: 0, trackIndex: 0 },
      { id: 'wp-1', name: 'Camp', type: 'campsite', totalDistance: 50, ascent: 200, descent: 100, trackIndex: 100 },
      { id: 'wp-2', name: 'End', type: 'trailhead', totalDistance: 100, ascent: 150, descent: 300, trackIndex: 200 },
    ];
    const reversed = reverseWaypoints(waypoints, 100, 201);

    expect(reversed[0].name).toBe('End');
    expect(reversed[0].totalDistance).toBe(0);
    expect(reversed[1].name).toBe('Camp');
    expect(reversed[1].totalDistance).toBe(50);
    expect(reversed[2].name).toBe('Start');
    expect(reversed[2].totalDistance).toBe(100);
  });

  it('handles empty waypoints array', () => {
    expect(reverseWaypoints([], 100, 500)).toEqual([]);
  });

  it('swaps ascent/descent and mirrors trackIndex', () => {
    const waypoints = [
      { id: 'wp-0', name: 'Only', type: 'trailhead', totalDistance: 50, ascent: 100, descent: 50, trackIndex: 250 },
    ];
    const reversed = reverseWaypoints(waypoints, 100, 500);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].name).toBe('Only');
    expect(reversed[0].totalDistance).toBe(50);
    expect(reversed[0].ascent).toBe(50);  // original descent becomes new ascent
    expect(reversed[0].descent).toBe(100); // original ascent becomes new descent
    expect(reversed[0].trackIndex).toBe(249); // trackLength - 1 - 250
  });

  it('recomputes segment distances and cumulative totals in the new walk order', () => {
    const waypoints = [
      { name: 'A', totalDistance: 0, ascent: 0, descent: 0, trackIndex: 0 },
      { name: 'B', totalDistance: 30, ascent: 120, descent: 40, trackIndex: 3 },
      { name: 'C', totalDistance: 100, ascent: 60, descent: 200, trackIndex: 10 },
    ];
    const reversed = reverseWaypoints(waypoints, 100, 11);

    // New order C(0) -> B(70) -> A(100)
    expect(reversed.map(w => w.name)).toEqual(['C', 'B', 'A']);
    expect(reversed[0].distance).toBe(0);
    expect(reversed[1].distance).toBe(70);
    expect(reversed[2].distance).toBe(30);
    // Cumulative ascent walks the swapped per-segment values
    expect(reversed[0].totalAscent).toBe(200);
    expect(reversed[1].totalAscent).toBe(240);
    expect(reversed[2].totalAscent).toBe(240);
    expect(reversed[2].totalDescent).toBe(180);
  });

  it('accepts waypoints with all km fields absent (?? 0 guards)', () => {
    const bare: Array<ReversibleWaypoint & { name: string }> = [{ name: 'Bare' }];
    const reversed = reverseWaypoints(bare, 100, 50);
    expect(reversed[0].totalDistance).toBe(100);
    expect(reversed[0].ascent).toBe(0);
    expect(reversed[0].descent).toBe(0);
    expect(reversed[0].trackIndex).toBe(49);
  });
});

describe('createReversedTrail', () => {
  it('creates a fully reversed trail', () => {
    const trail = {
      config: { id: 'test', name: 'Test Trail' },
      track: {
        points: makePoints([0, 25, 50, 75, 100]),
        displayPoints: makePoints([0, 50, 100]),
        totalDistance: 100,
        totalAscent: 500,
        totalDescent: 300,
      },
      waypoints: [
        { id: 'wp-0', name: 'A', type: 'trailhead', totalDistance: 0 },
        { id: 'wp-1', name: 'B', type: 'campsite', totalDistance: 100 },
      ],
    };

    const reversed = createReversedTrail(trail);

    expect(reversed.track.totalAscent).toBe(300);
    expect(reversed.track.totalDescent).toBe(500);
    expect(reversed.track.points[0].dist).toBe(0);
    expect(reversed.track.points[4].dist).toBe(100);
    expect(reversed.track.displayPoints?.[0].dist).toBe(0);
    expect(reversed.track.displayPoints?.[2].dist).toBe(100);
    expect(reversed.waypoints?.[0].name).toBe('B');
    expect(reversed.waypoints?.[1].name).toBe('A');
    // Extra fields pass through untouched
    expect(reversed.config).toEqual(trail.config);
  });

  it('handles trail with no alternates or side trips', () => {
    const trail: ReversibleTrail<TestPoint> = {
      track: {
        points: makePoints([0, 5, 10]),
        totalDistance: 10,
        totalAscent: 100,
        totalDescent: 50,
      },
      waypoints: [],
    };

    const reversed = createReversedTrail(trail);

    expect(reversed.track.totalAscent).toBe(50);
    expect(reversed.track.totalDescent).toBe(100);
    expect(reversed.waypoints).toEqual([]);
    expect(reversed.alternates).toEqual([]);
    expect(reversed.sideTrips).toEqual([]);
  });

  it('double-reverse restores original distances', () => {
    const trail = {
      track: {
        points: makePoints([0, 10, 20, 30, 40, 50]),
        totalDistance: 50,
        totalAscent: 200,
        totalDescent: 150,
      },
      waypoints: [
        { id: 'wp-0', name: 'A', type: 'trailhead', totalDistance: 0, ascent: 0, descent: 0, trackIndex: 0 },
        { id: 'wp-1', name: 'B', type: 'campsite', totalDistance: 25, ascent: 80, descent: 20, trackIndex: 2 },
        { id: 'wp-2', name: 'C', type: 'trailhead', totalDistance: 50, ascent: 120, descent: 130, trackIndex: 5 },
      ],
    };

    const doubleReversed = createReversedTrail(createReversedTrail(trail));

    expect(doubleReversed.track.totalAscent).toBe(200);
    expect(doubleReversed.track.totalDescent).toBe(150);
    expect(doubleReversed.track.points[0].dist).toBeCloseTo(0);
    expect(doubleReversed.track.points[5].dist).toBeCloseTo(50);
    expect(doubleReversed.waypoints[0].name).toBe('A');
    expect(doubleReversed.waypoints[2].name).toBe('C');
    doubleReversed.waypoints.forEach((wp, i) => {
      expect(wp.totalDistance).toBeCloseTo(trail.waypoints[i].totalDistance);
      expect(wp.ascent).toBe(trail.waypoints[i].ascent);
      expect(wp.descent).toBe(trail.waypoints[i].descent);
      expect(wp.trackIndex).toBe(trail.waypoints[i].trackIndex);
    });
  });

  it('reverses attached alternates and side trips via variant-reverse', () => {
    const trail = {
      track: {
        points: makePoints([0, 50, 100]),
        totalDistance: 100,
        totalAscent: 0,
        totalDescent: 0,
      },
      waypoints: [],
      alternates: [
        { name: 'Alt 1', startDistance: 10, endDistance: 30, distance: 15, points: [] },
      ],
      sideTrips: [
        { name: 'Trip 1', startDistance: 25 },
      ],
    };

    const reversed = createReversedTrail(trail);

    expect(reversed.alternates?.[0].startDistance).toBe(70);
    expect(reversed.alternates?.[0].endDistance).toBe(90);
    expect(reversed.sideTrips?.[0].startDistance).toBe(75);
  });

  it('preserves waypoint ids through reversal', () => {
    const trail = {
      track: {
        points: makePoints([0, 25, 50]),
        totalDistance: 50,
        totalAscent: 100,
        totalDescent: 50,
      },
      waypoints: [
        { id: 'wp-0', name: 'A', totalDistance: 0 },
        { id: 'wp-1', name: 'B', totalDistance: 25 },
        { id: 'wp-2', name: 'C', totalDistance: 50 },
      ],
    };
    const reversed = createReversedTrail(trail);
    // Reversed order but ids stay stable with their original waypoints
    expect(reversed.waypoints[0].id).toBe('wp-2');
    expect(reversed.waypoints[0].name).toBe('C');
    expect(reversed.waypoints[1].id).toBe('wp-1');
    expect(reversed.waypoints[1].name).toBe('B');
    expect(reversed.waypoints[2].id).toBe('wp-0');
    expect(reversed.waypoints[2].name).toBe('A');
  });
});
