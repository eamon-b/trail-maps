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
  it('moves a junction residual to the other end without leaving an undefined key behind', () => {
    const [reversed] = reverseAlternates<ReversibleVariant>([{ startDistance: 10, endDistance: 30, startOffsetMeters: 700 }], 100);
    expect(reversed.endOffsetMeters).toBe(700);
    expect(reversed).not.toHaveProperty('startOffsetMeters');

    const [other] = reverseAlternates<ReversibleVariant>([{ startDistance: 10, endDistance: 30, endOffsetMeters: 900 }], 100);
    expect(other.startOffsetMeters).toBe(900);
    expect(other).not.toHaveProperty('endOffsetMeters');
  });

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

  it('flips a parent-attached alternate like any other, keeping the parent', () => {
    // An alternate off an alternate carries absolute trail km (the parent's
    // junction plus the walk along it), so there is nothing special to do —
    // the regression this guards is someone deciding there is.
    const child: ReversibleVariant & { parent?: { name: string; index: number } } = {
      distance: 3,
      startDistance: 17.8,
      endDistance: 20,
      parent: { name: 'Parent Alternate', index: 0 },
      points: [{}, {}],
      waypoints: [makeWaypoint({ distance: 1.2, totalDistance: 19 })],
    };
    const reversed = reverseAlternates([child], 100);

    expect(reversed[0].startDistance).toBe(80);
    expect(reversed[0].endDistance).toBe(82.2);
    expect(reversed[0].parent).toEqual({ name: 'Parent Alternate', index: 0 });
    expect(reversed[0].waypoints![0].totalDistance).toBe(81.8); // 80 + (3 - 1.2)
  });

  it('moves a junction residual to the end it now belongs to', () => {
    const loose: ReversibleVariant = {
      distance: 5,
      startDistance: 10,
      endDistance: 30,
      startOffsetMeters: 900,
    };
    const reversed = reverseAlternates([loose], 100);
    expect(reversed[0].startOffsetMeters).toBeUndefined();
    expect(reversed[0].endOffsetMeters).toBe(900);
  });

  it('mirrors an alternate attached at its start only, still read from that junction', () => {
    // The Bibbulmun's "Alt: hitch into Denmark": leaves at km 909.53 of
    // 981.6 and never rejoins. Reversal used to leave it at 909.53.
    const hitch: ReversibleVariant = {
      distance: 12,
      startDistance: 909.53,
      startOffsetMeters: 600,
      points: [{ i: 0 }, { i: 1 }, { i: 2 }],
      waypoints: [makeWaypoint({ distance: 12, totalDistance: 921.53, variantTrackIndex: 2 })],
    };
    const [reversed] = reverseAlternates([hitch], 981.6);

    expect(reversed.startDistance).toBe(72.07);
    expect(reversed).not.toHaveProperty('endDistance');
    // The junction is still the branch point, so nothing about the walk out
    // from it changes.
    expect(reversed.points).toEqual(hitch.points);
    expect(reversed.startOffsetMeters).toBe(600);
    expect(reversed.waypoints![0].totalDistance).toBe(84.07);
    expect(reversed.waypoints![0].variantTrackIndex).toBe(2);
  });

  it('turns an alternate attached at its end only into one read from that junction', () => {
    // Written by an ingest from before such variants were turned round: the
    // junction is the last point, and the waypoint km count from points[0].
    const dangling: ReversibleVariant = {
      distance: 8,
      endDistance: 1122.77,
      endOffsetMeters: 900,
      points: [{ i: 0 }, { i: 1 }, { i: 2 }],
      waypoints: [
        makeWaypoint({ name: 'Free end', distance: 0, totalDistance: 0, ascent: 0, descent: 0, variantTrackIndex: 0 }),
        makeWaypoint({ name: 'Near junction', distance: 7.5, totalDistance: 7.5, ascent: 300, descent: 20, variantTrackIndex: 2 }),
      ],
    };
    const [reversed] = reverseAlternates([dangling], 4800);

    expect(reversed.startDistance).toBe(3677.23);
    expect(reversed).not.toHaveProperty('endDistance');
    expect(reversed.startOffsetMeters).toBe(900);
    expect(reversed).not.toHaveProperty('endOffsetMeters');
    expect(reversed.points).toEqual([{ i: 2 }, { i: 1 }, { i: 0 }]);
    const names = reversed.waypoints!.map(w => (w as TestWaypoint).name);
    expect(names).toEqual(['Near junction', 'Free end']);
    expect(reversed.waypoints![0].totalDistance).toBe(3677.73); // 0.5 km out
    expect(reversed.waypoints![1].totalDistance).toBe(3685.23); // the whole 8 km
    expect(reversed.waypoints![1].distance).toBe(7.5);
    expect(reversed.waypoints![0].variantTrackIndex).toBe(0);
  });

  it('rounds the mirrored junctions to the 10 m every other km is', () => {
    // 100.1 - 30.7 is 69.39999999999999 in floating point.
    const [reversed] = reverseAlternates([{ startDistance: 10.3, endDistance: 30.7 }], 100.1);
    expect(reversed.startDistance).toBe(69.4);
    expect(reversed.endDistance).toBe(89.8);
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

  it('rounds the mirrored junction', () => {
    // 981.6 - 909.53 is 72.07000000000005 in floating point.
    const [transformed] = transformSideTrips([{ startDistance: 909.53 }], 981.6);
    expect(transformed.startDistance).toBe(72.07);
  });

  it('turns a side trip attached at its end only round, like an alternate', () => {
    const spur: ReversibleVariant = {
      distance: 3,
      endDistance: 903.01,
      points: [{ i: 0 }, { i: 1 }],
      waypoints: [makeWaypoint({ distance: 0, totalDistance: 0, variantTrackIndex: 0 })],
    };
    const [transformed] = transformSideTrips([spur], 1200);
    expect(transformed.startDistance).toBe(296.99);
    expect(transformed).not.toHaveProperty('endDistance');
    expect(transformed.points).toEqual([{ i: 1 }, { i: 0 }]);
    expect(transformed.waypoints![0].totalDistance).toBe(299.99);
  });

  it('mirrors a parent-attached side trip the same way', () => {
    const spur: ReversibleVariant & { parent?: { name: string } } = {
      distance: 2,
      startDistance: 17.8,
      parent: { name: 'Parent Alternate' },
      waypoints: [makeWaypoint({ distance: 1, totalDistance: 18.8 })],
    };
    const transformed = transformSideTrips([spur], 100);

    expect(transformed[0].startDistance).toBe(82.2);
    expect(transformed[0].parent).toEqual({ name: 'Parent Alternate' });
    expect(transformed[0].waypoints![0].totalDistance).toBe(83.2);
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
