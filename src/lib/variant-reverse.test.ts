import { describe, it, expect } from 'vitest';
import {
  reverseAlternates,
  transformSideTrips,
  type ReversibleVariant,
  type VariantWaypointKmFields,
} from './variant-reverse';

type TestWaypoint = VariantWaypointKmFields & { name?: string; type?: string; lat?: number; lon?: number; elevation?: number };

function makeWaypoint(overrides: Partial<TestWaypoint> = {}): TestWaypoint {
  return {
    name: 'WP',
    type: 'poi',
    distance: 0,
    totalDistance: 0,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    variantTrackIndex: 0,
    ...overrides,
  };
}

describe('reverseAlternates', () => {
  it('swaps start and end distances', () => {
    const reversed = reverseAlternates([{ startDistance: 10, endDistance: 30 }], 100);
    expect(reversed[0].startDistance).toBe(70);
    expect(reversed[0].endDistance).toBe(90);
  });

  it('recomputes waypoint absolute km for the reversed walk', () => {
    // 15km alternate branching at km 10, rejoining at km 30 of a 100km trail.
    // Waypoint 5km along the variant → absolute km 15.
    const reversed = reverseAlternates([{
      distance: 15,
      startDistance: 10,
      endDistance: 30,
      points: [{}, {}, {}],
      waypoints: [makeWaypoint({ distance: 5, totalDistance: 15, ascent: 120, descent: 30, totalAscent: 120, totalDescent: 30, variantTrackIndex: 1 })],
    }], 100);

    const wp = reversed[0].waypoints![0];
    expect(reversed[0].startDistance).toBe(70);
    expect(wp.totalDistance).toBe(80); // 70 + (15 - 5)
    expect(wp.distance).toBe(10);
    expect(wp.ascent).toBe(30);
    expect(wp.descent).toBe(120);
    expect(wp.variantTrackIndex).toBe(1); // 3 points: 2 - 1
  });

  it('reverses waypoint order for multi-waypoint alternates', () => {
    const reversed = reverseAlternates([{
      distance: 10,
      startDistance: 20,
      endDistance: 32,
      points: [],
      waypoints: [
        makeWaypoint({ name: 'First', distance: 2, totalDistance: 22 }),
        makeWaypoint({ name: 'Second', distance: 6, totalDistance: 28 }),
      ],
    }], 100);
    const names = reversed[0].waypoints!.map(w => (w as { name: string }).name);
    expect(names).toEqual(['Second', 'First']);
    expect(reversed[0].waypoints![0].totalDistance).toBe(70); // 68 + (10 - 8)
    expect(reversed[0].waypoints![1].totalDistance).toBe(76); // 68 + (10 - 2)
    expect(reversed[0].waypoints![1].distance).toBe(6);
  });

  it('leaves unattached alternates untouched (variant-relative km, no junction to mirror)', () => {
    const unattached: ReversibleVariant = {
      distance: 5,
      points: [{ a: 1 }, { a: 2 }],
      waypoints: [makeWaypoint({ distance: 1.2, totalDistance: 1.2 })],
    };
    const reversed = reverseAlternates([unattached], 100);
    expect(reversed[0]).toBe(unattached); // identity — nothing transformed
    expect(reversed[0].waypoints![0].totalDistance).toBe(1.2);
    expect(reversed[0].startDistance).toBeUndefined();
  });
});

describe('transformSideTrips', () => {
  it('mirrors start distance', () => {
    const transformed = transformSideTrips([{ startDistance: 25 }], 100);
    expect(transformed[0].startDistance).toBe(75);
  });

  it('shifts waypoint absolute km with the junction, keeping variant-relative stats', () => {
    const transformed = transformSideTrips([{
      distance: 4,
      startDistance: 25,
      waypoints: [makeWaypoint({ distance: 3, totalDistance: 28, ascent: 50, descent: 10, variantTrackIndex: 7 })],
    }], 100);
    const wp = transformed[0].waypoints![0];
    expect(transformed[0].startDistance).toBe(75);
    expect(wp.totalDistance).toBe(78); // 75 + 3
    expect(wp.distance).toBe(3);
    expect(wp.ascent).toBe(50);
    expect(wp.variantTrackIndex).toBe(7);
  });

  it('leaves unattached side trips untouched (regression: AAWT spurs >500m off-track)', () => {
    // Real shipped case: side trip starts >500m from the main track so
    // startDistance is undefined and waypoint km are variant-relative (0.34).
    // The old code computed newStart = 688.3 - 0 and produced waypoint km
    // beyond the end of a 688.3 km trail.
    const spur: ReversibleVariant = {
      distance: 2.8,
      waypoints: [makeWaypoint({ distance: 0.34, totalDistance: 0.34 })],
    };
    const transformed = transformSideTrips([spur], 688.3);
    expect(transformed[0]).toBe(spur); // identity — nothing transformed
    expect(transformed[0].startDistance).toBeUndefined();
    expect(transformed[0].waypoints![0].totalDistance).toBe(0.34);
  });
});
