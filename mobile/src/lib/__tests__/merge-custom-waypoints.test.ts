import {
  mergeCustomWaypoints,
  createReversedTrail,
  type CustomWaypointLike,
  type Trail,
  type TrackPoint,
} from '../trail-utils';

function makePoints(distances: number[]): TrackPoint[] {
  return distances.map((d, i) => ({ lat: -33 + i * 0.01, lon: 115 + i * 0.01, ele: 100 + i * 10, dist: d }));
}

function makeTrail(): Trail {
  return {
    config: {
      id: 'test',
      name: 'Test Trail',
      shortName: 'T',
      region: 'AU',
      lengthKm: 100,
      direction: { default: 'NOBO', reversed: 'SOBO' },
    },
    track: {
      points: makePoints([0, 20, 40, 60, 80, 100]),
      totalDistance: 100,
      totalAscent: 500,
      totalDescent: 300,
    },
    waypoints: [
      { id: 'wp-0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0, distance: 0, ascent: 0, descent: 0, trackIndex: 0 },
      { id: 'wp-1', name: 'Camp', lat: 1, lon: 1, type: 'campsite', totalDistance: 40, distance: 40, ascent: 200, descent: 100, trackIndex: 2 },
      { id: 'wp-2', name: 'End', lat: 2, lon: 2, type: 'trailhead', totalDistance: 100, distance: 60, ascent: 300, descent: 200, trackIndex: 5 },
    ],
  };
}

function makeCustom(overrides: Partial<CustomWaypointLike> = {}): CustomWaypointLike {
  return {
    id: 'abc123',
    name: 'My spring',
    type: 'water',
    lat: -33.05,
    lon: 115.05,
    ele: null,
    kmPosition: 60,
    description: null,
    ...overrides,
  };
}

describe('mergeCustomWaypoints', () => {
  it('returns the trail unchanged for an empty custom list', () => {
    const trail = makeTrail();
    expect(mergeCustomWaypoints(trail, [])).toBe(trail);
  });

  it('does not mutate the input trail', () => {
    const trail = makeTrail();
    const before = JSON.parse(JSON.stringify(trail));
    mergeCustomWaypoints(trail, [makeCustom()]);
    expect(trail).toEqual(before);
  });

  it('inserts custom waypoints sorted by totalDistance', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [
      makeCustom({ id: 'a', name: 'Late spring', kmPosition: 60 }),
      makeCustom({ id: 'b', name: 'Early tank', type: 'water-tank', kmPosition: 15 }),
    ]);

    expect(merged.waypoints.map(wp => wp.name)).toEqual([
      'Start', 'Early tank', 'Camp', 'Late spring', 'End',
    ]);
    expect(merged.waypoints.map(wp => wp.totalDistance)).toEqual([0, 15, 40, 60, 100]);
  });

  it('assigns stable custom-prefixed ids', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ id: 'abc123' })]);
    const custom = merged.waypoints.find(wp => wp.name === 'My spring');
    expect(custom!.id).toBe('custom-abc123');
    // Bundled ids untouched
    expect(merged.waypoints[0].id).toBe('wp-0');
  });

  it('recomputes segment distance deltas for ALL waypoints', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ kmPosition: 60 })]);

    // Start(0), Camp(40), My spring(60), End(100)
    expect(merged.waypoints.map(wp => wp.distance)).toEqual([0, 40, 20, 40]);
  });

  it('sets ascent/descent 0 on custom rows and resolves trackIndex + elevation from the track', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ kmPosition: 60 })]);
    const custom = merged.waypoints.find(wp => wp.id === 'custom-abc123')!;

    expect(custom.ascent).toBe(0);
    expect(custom.descent).toBe(0);
    // Track point at km 60 is index 3 (ele 130)
    expect(custom.trackIndex).toBe(3);
    expect(custom.elevation).toBe(130);
  });

  it('keeps a provided elevation instead of the track elevation', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ ele: 412 })]);
    const custom = merged.waypoints.find(wp => wp.id === 'custom-abc123')!;
    expect(custom.elevation).toBe(412);
  });

  it('keeps the raw off-track lat/lon (marker renders where the water is)', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ lat: -33.5, lon: 115.5 })]);
    const custom = merged.waypoints.find(wp => wp.id === 'custom-abc123')!;
    expect(custom.lat).toBe(-33.5);
    expect(custom.lon).toBe(115.5);
  });

  it('survives createReversedTrail (merge → reverse round trip)', () => {
    const merged = mergeCustomWaypoints(makeTrail(), [makeCustom({ kmPosition: 60 })]);
    const reversed = createReversedTrail(merged);

    // Order flips; custom waypoint mirrors to km 100 - 60 = 40
    expect(reversed.waypoints.map(wp => wp.name)).toEqual([
      'End', 'My spring', 'Camp', 'Start',
    ]);
    const custom = reversed.waypoints.find(wp => wp.id === 'custom-abc123')!;
    expect(custom.totalDistance).toBe(40);
    // trackIndex mirrors: 6 points → 6 - 1 - 3 = 2
    expect(custom.trackIndex).toBe(2);
    // Custom rows contribute no elevation to the reversed running totals
    expect(custom.ascent).toBe(0);
    expect(custom.descent).toBe(0);

    // Double reversal restores the merged ordering and km positions
    const roundTrip = createReversedTrail(reversed);
    expect(roundTrip.waypoints.map(wp => wp.id)).toEqual(merged.waypoints.map(wp => wp.id));
    expect(roundTrip.waypoints.map(wp => wp.totalDistance)).toEqual(
      merged.waypoints.map(wp => wp.totalDistance),
    );
  });

  it('handles a custom waypoint before the first bundled waypoint', () => {
    const trail = makeTrail();
    // Remove the km-0 trailhead so the custom row becomes first
    trail.waypoints = trail.waypoints.slice(1);
    const merged = mergeCustomWaypoints(trail, [makeCustom({ kmPosition: 10 })]);

    expect(merged.waypoints[0].id).toBe('custom-abc123');
    expect(merged.waypoints[0].distance).toBe(10); // measured from trail start
    expect(merged.waypoints[1].distance).toBe(30); // Camp: 40 - 10
  });
});
