import {
  findNearestByDistance,
  findWaypointIndex,
  getMinMax,
  niceAxisTicks,
  reverseTrackPoints,
  reverseWaypoints,
  reverseAlternates,
  transformSideTrips,
  createReversedTrail,
  findVariantByKey,
  type TrackPoint,
  type TrailWaypoint,
  type Trail,
} from '../trail-utils';

function makePoints(distances: number[]): TrackPoint[] {
  return distances.map((d, i) => ({ lat: -33 + i * 0.01, lon: 115 + i * 0.01, ele: 100 + i * 10, dist: d }));
}

describe('findNearestByDistance', () => {
  const points = makePoints([0, 10, 20, 30, 40, 50]);

  it('finds exact match', () => {
    expect(findNearestByDistance(points, 20)).toBe(2);
  });

  it('finds nearest when between points', () => {
    expect(findNearestByDistance(points, 22)).toBe(2);
    expect(findNearestByDistance(points, 28)).toBe(3);
  });

  it('finds first point for distance 0', () => {
    expect(findNearestByDistance(points, 0)).toBe(0);
  });

  it('finds last point for distance beyond max', () => {
    expect(findNearestByDistance(points, 100)).toBe(5);
  });

  it('returns 0 for empty array', () => {
    expect(findNearestByDistance([], 10)).toBe(0);
  });
});

describe('getMinMax', () => {
  it('returns min and max of array', () => {
    expect(getMinMax([3, 1, 4, 1, 5, 9])).toEqual({ min: 1, max: 9 });
  });

  it('handles single element', () => {
    expect(getMinMax([42])).toEqual({ min: 42, max: 42 });
  });

  it('handles empty array', () => {
    expect(getMinMax([])).toEqual({ min: 0, max: 0 });
  });

  it('handles negative numbers', () => {
    expect(getMinMax([-5, -1, -10, 0, 3])).toEqual({ min: -10, max: 3 });
  });
});

describe('niceAxisTicks', () => {
  it('generates ticks for a typical elevation range', () => {
    const ticks = niceAxisTicks(100, 500, 4);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBeGreaterThanOrEqual(100);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(500);
    // All ticks should be round numbers
    ticks.forEach(t => expect(t % 100).toBe(0));
  });

  it('handles equal min and max', () => {
    expect(niceAxisTicks(100, 100, 4)).toEqual([100]);
  });

  it('generates ticks for a distance range', () => {
    const ticks = niceAxisTicks(0, 1000, 5);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
  });
});

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
    const reversed = reverseTrackPoints([], 0);
    expect(reversed).toEqual([]);
  });

  it('handles single point', () => {
    const points = makePoints([0]);
    const reversed = reverseTrackPoints(points, 0);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].dist).toBe(0);
  });
});

describe('reverseWaypoints', () => {
  it('reverses waypoints and swaps ascent/descent', () => {
    const waypoints = [
      { name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0, ascent: 0, descent: 0, trackIndex: 0 },
      { name: 'Camp', lat: 1, lon: 1, type: 'campsite', totalDistance: 50, ascent: 200, descent: 100, trackIndex: 100 },
      { name: 'End', lat: 2, lon: 2, type: 'trailhead', totalDistance: 100, ascent: 150, descent: 300, trackIndex: 200 },
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
    const reversed = reverseWaypoints([], 100, 500);
    expect(reversed).toEqual([]);
  });

  it('handles single waypoint', () => {
    const waypoints = [
      { name: 'Only', lat: 0, lon: 0, type: 'trailhead', totalDistance: 50, ascent: 100, descent: 50, trackIndex: 250 },
    ];
    const reversed = reverseWaypoints(waypoints, 100, 500);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].name).toBe('Only');
    expect(reversed[0].totalDistance).toBe(50);
    expect(reversed[0].ascent).toBe(50);  // original descent becomes new ascent
    expect(reversed[0].descent).toBe(100); // original ascent becomes new descent
    expect(reversed[0].trackIndex).toBe(249); // trackLength - 1 - 250
  });
});

describe('reverseAlternates', () => {
  it('swaps start and end distances', () => {
    const alts = [{ name: 'Alt 1', type: 'alternate' as const, startDistance: 10, endDistance: 30 }];
    const reversed = reverseAlternates(alts, 100);

    expect(reversed[0].startDistance).toBe(70);
    expect(reversed[0].endDistance).toBe(90);
  });
});

describe('transformSideTrips', () => {
  it('mirrors start distance', () => {
    const trips = [{ name: 'Trip 1', type: 'side-trip' as const, startDistance: 25 }];
    const transformed = transformSideTrips(trips, 100);

    expect(transformed[0].startDistance).toBe(75);
  });
});

describe('createReversedTrail', () => {
  it('creates a fully reversed trail', () => {
    const trail: Trail = {
      config: { id: 'test', name: 'Test Trail', shortName: 'Test', region: 'AU', lengthKm: 100, direction: { default: 'Southbound', reversed: 'Northbound' } },
      track: {
        points: makePoints([0, 25, 50, 75, 100]),
        displayPoints: makePoints([0, 50, 100]),
        totalDistance: 100,
        totalAscent: 500,
        totalDescent: 300,
      },
      waypoints: [
        { name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 100 },
      ],
    };

    const reversed = createReversedTrail(trail);

    expect(reversed.track.totalAscent).toBe(300);
    expect(reversed.track.totalDescent).toBe(500);
    expect(reversed.track.points[0].dist).toBe(0);
    expect(reversed.track.points[4].dist).toBe(100);
    expect(reversed.waypoints?.[0].name).toBe('B');
    expect(reversed.waypoints?.[1].name).toBe('A');
  });

  it('handles trail with no alternates or side trips', () => {
    const trail: Trail = {
      config: { id: 'test', name: 'Test', shortName: 'T', region: 'AU', lengthKm: 10, direction: { default: 'N', reversed: 'S' } },
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
    const trail: Trail = {
      config: { id: 'test', name: 'Test', shortName: 'T', region: 'AU', lengthKm: 50, direction: { default: 'N', reversed: 'S' } },
      track: {
        points: makePoints([0, 10, 20, 30, 40, 50]),
        totalDistance: 50,
        totalAscent: 200,
        totalDescent: 150,
      },
      waypoints: [
        { name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 25 },
        { name: 'C', lat: 2, lon: 2, type: 'trailhead', totalDistance: 50 },
      ],
    };

    const doubleReversed = createReversedTrail(createReversedTrail(trail));

    expect(doubleReversed.track.totalAscent).toBe(200);
    expect(doubleReversed.track.totalDescent).toBe(150);
    expect(doubleReversed.track.points[0].dist).toBeCloseTo(0);
    expect(doubleReversed.track.points[5].dist).toBeCloseTo(50);
    expect(doubleReversed.waypoints[0].name).toBe('A');
    expect(doubleReversed.waypoints[2].name).toBe('C');
  });
});

describe('findVariantByKey', () => {
  const trail: Trail = {
    config: { id: 'test', name: 'Test', shortName: 'Test', region: 'AU', lengthKm: 100, direction: { default: 'Southbound', reversed: 'Northbound' } },
    track: { points: [], totalDistance: 100, totalAscent: 0, totalDescent: 0 },
    waypoints: [],
    alternates: [{ name: 'Road Bypass', type: 'alternate' }],
    sideTrips: [{ name: 'Peak Summit', type: 'side-trip' }],
  };

  it('finds alternate by key', () => {
    const result = findVariantByKey('alternate-road-bypass', trail);
    expect(result?.name).toBe('Road Bypass');
  });

  it('finds side trip by key', () => {
    const result = findVariantByKey('side-trip-peak-summit', trail);
    expect(result?.name).toBe('Peak Summit');
  });

  it('returns null for unknown key', () => {
    expect(findVariantByKey('alternate-unknown', trail)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findWaypointIndex
// ---------------------------------------------------------------------------

function makeWaypoint(overrides: Partial<TrailWaypoint>): TrailWaypoint {
  return { name: 'Waypoint', lat: -33.0, lon: 115.0, type: 'poi', ...overrides };
}

describe('findWaypointIndex', () => {
  const waypoints: TrailWaypoint[] = [
    makeWaypoint({ name: 'Start', lat: -33.0, lon: 115.0, totalDistance: 0 }),
    makeWaypoint({ name: 'Water Tank', lat: -33.1, lon: 115.1, totalDistance: 12.5 }),
    makeWaypoint({ name: 'Camp A', lat: -33.2, lon: 115.2, totalDistance: 25.0 }),
    makeWaypoint({ name: 'Lookout', lat: -33.3, lon: 115.3 }), // no totalDistance
    makeWaypoint({ name: 'Camp B', lat: -33.4, lon: 115.4, totalDistance: 50.0 }),
    makeWaypoint({ name: 'End', lat: -33.5, lon: 115.5, totalDistance: 75.0 }),
  ];

  it('finds waypoint by name and totalDistance', () => {
    const target = makeWaypoint({ name: 'Camp A', totalDistance: 25.0 });
    expect(findWaypointIndex(waypoints, target)).toBe(2);
  });

  it('matches totalDistance within 0.1km tolerance', () => {
    const target = makeWaypoint({ name: 'Water Tank', totalDistance: 12.45 });
    expect(findWaypointIndex(waypoints, target)).toBe(1);
  });

  it('does not match when totalDistance differs by more than tolerance', () => {
    const target = makeWaypoint({ name: 'Water Tank', totalDistance: 13.0 });
    expect(findWaypointIndex(waypoints, target)).toBe(-1);
  });

  it('falls back to coordinate match when target has no totalDistance', () => {
    const target = makeWaypoint({ name: 'Lookout', lat: -33.3, lon: 115.3 });
    expect(findWaypointIndex(waypoints, target)).toBe(3);
  });

  it('requires name match for coordinate fallback', () => {
    const target = makeWaypoint({ name: 'Wrong Name', lat: -33.3, lon: 115.3 });
    expect(findWaypointIndex(waypoints, target)).toBe(-1);
  });

  it('returns -1 for waypoint not in array', () => {
    const target = makeWaypoint({ name: 'Missing', totalDistance: 999 });
    expect(findWaypointIndex(waypoints, target)).toBe(-1);
  });

  it('returns -1 for empty waypoints array', () => {
    const target = makeWaypoint({ name: 'Start', totalDistance: 0 });
    expect(findWaypointIndex([], target)).toBe(-1);
  });

  it('distinguishes duplicate names by totalDistance', () => {
    const dupes: TrailWaypoint[] = [
      makeWaypoint({ name: 'Water', totalDistance: 10.0 }),
      makeWaypoint({ name: 'Water', totalDistance: 30.0 }),
      makeWaypoint({ name: 'Water', totalDistance: 55.0 }),
    ];
    expect(findWaypointIndex(dupes, makeWaypoint({ name: 'Water', totalDistance: 30.0 }))).toBe(1);
    expect(findWaypointIndex(dupes, makeWaypoint({ name: 'Water', totalDistance: 55.05 }))).toBe(2);
  });

  it('prefers name+distance match over coordinate fallback', () => {
    // Target has totalDistance — should use primary match, not coordinates
    const target = makeWaypoint({ name: 'Camp B', lat: -99, lon: -99, totalDistance: 50.0 });
    expect(findWaypointIndex(waypoints, target)).toBe(4);
  });

  it('corresponds correctly through datasheet filter', () => {
    // Simulate what the datasheet does: filter waypoints to those with totalDistance
    const filtered = waypoints.filter(wp => wp.totalDistance != null);
    // filtered indices: 0=Start, 1=WaterTank, 2=CampA, 3=CampB, 4=End
    // Original indices: 0=Start, 1=WaterTank, 2=CampA, 4=CampB, 5=End

    // Pick a waypoint from the filtered list (e.g., filtered index 3 = Camp B)
    const datasheetWp = filtered[3]; // Camp B
    expect(datasheetWp.name).toBe('Camp B');

    // findWaypointIndex should return the ORIGINAL index (4), not the filtered index (3)
    const originalIndex = findWaypointIndex(waypoints, datasheetWp);
    expect(originalIndex).toBe(4);
    expect(waypoints[originalIndex].name).toBe('Camp B');
  });

  it('maps every filtered waypoint back to its original index', () => {
    const filtered = waypoints.filter(wp => wp.totalDistance != null);
    const expectedOriginalIndices = [0, 1, 2, 4, 5]; // indices 3 (Lookout) is skipped

    filtered.forEach((wp, filteredIdx) => {
      const originalIdx = findWaypointIndex(waypoints, wp);
      expect(originalIdx).toBe(expectedOriginalIndices[filteredIdx]);
      expect(waypoints[originalIdx]).toBe(wp); // same object reference
    });
  });
});
