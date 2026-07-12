import {
  findNearestByDistance,
  getMinMax,
  niceAxisTicks,
  reverseTrackPoints,
  reverseWaypoints,
  reverseAlternates,
  transformSideTrips,
  createReversedTrail,
  trailJsonToTrail,
  findVariantByKey,
  nearestTrackPointToLatLon,
  type TrackPoint,
  type Trail,
  type RouteVariant,
} from '../trail-utils';
import type { TrailJson } from '../../services/trail-loader';

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
      { id: 'wp-0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0, ascent: 0, descent: 0, trackIndex: 0 },
      { id: 'wp-1', name: 'Camp', lat: 1, lon: 1, type: 'campsite', totalDistance: 50, ascent: 200, descent: 100, trackIndex: 100 },
      { id: 'wp-2', name: 'End', lat: 2, lon: 2, type: 'trailhead', totalDistance: 100, ascent: 150, descent: 300, trackIndex: 200 },
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

  it('handles single waypoint (no arriving segment in the reversed walk)', () => {
    const waypoints = [
      { id: 'wp-0', name: 'Only', lat: 0, lon: 0, type: 'trailhead', totalDistance: 50, ascent: 100, descent: 50, trackIndex: 250 },
    ];
    const reversed = reverseWaypoints(waypoints, 100, 500);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].name).toBe('Only');
    expect(reversed[0].totalDistance).toBe(50);
    // Per-waypoint ascent/descent describe the ARRIVING segment; the first
    // waypoint of the reversed walk has none.
    expect(reversed[0].ascent).toBe(0);
    expect(reversed[0].descent).toBe(0);
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

  it('recomputes waypoint absolute km for the reversed walk', () => {
    // 15km-long alternate branching at km 10, rejoining at km 30 of a 100km trail.
    // Waypoint sits 5km along the variant → absolute km 15.
    const alts = [{
      name: 'Alt 1',
      type: 'alternate' as const,
      distance: 15,
      startDistance: 10,
      endDistance: 30,
      points: [
        { lat: 0, lon: 0, ele: 0, dist: 0 },
        { lat: 1, lon: 1, ele: 0, dist: 0 },
        { lat: 2, lon: 2, ele: 0, dist: 0 },
      ],
      waypoints: [
        {
          name: 'Hut', type: 'hut', lat: 1, lon: 1, elevation: 100,
          distance: 5, totalDistance: 15, ascent: 120, descent: 30,
          totalAscent: 120, totalDescent: 30, variantTrackIndex: 1,
        },
      ],
    }];
    const reversed = reverseAlternates(alts, 100);

    // Reversed: variant now branches at 100-30=70; waypoint is 15-5=10km
    // along the reversed variant → absolute km 80.
    const wp = reversed[0].waypoints![0];
    expect(reversed[0].startDistance).toBe(70);
    expect(wp.totalDistance).toBe(80);
    expect(wp.distance).toBe(10); // gap from the (new) variant start
    expect(wp.ascent).toBe(30);   // swapped
    expect(wp.descent).toBe(120); // swapped
    expect(wp.variantTrackIndex).toBe(1); // 3 points: 2 - 1
  });

  it('reverses waypoint order for multi-waypoint alternates', () => {
    const alts = [{
      name: 'Alt', type: 'alternate' as const, distance: 10,
      startDistance: 20, endDistance: 32,
      points: [],
      waypoints: [
        { name: 'First', type: 'poi', lat: 0, lon: 0, elevation: 0, distance: 2, totalDistance: 22, ascent: 0, descent: 0, totalAscent: 0, totalDescent: 0, variantTrackIndex: 0 },
        { name: 'Second', type: 'poi', lat: 0, lon: 0, elevation: 0, distance: 6, totalDistance: 28, ascent: 0, descent: 0, totalAscent: 0, totalDescent: 0, variantTrackIndex: 0 },
      ],
    }];
    const reversed = reverseAlternates(alts, 100);
    // New branch at 100-32=68. 'Second' (8km along old) is 2km along new → 70;
    // 'First' (2km along old) is 8km along new → 76.
    expect(reversed[0].waypoints!.map(w => w.name)).toEqual(['Second', 'First']);
    expect(reversed[0].waypoints![0].totalDistance).toBe(70);
    expect(reversed[0].waypoints![1].totalDistance).toBe(76);
    expect(reversed[0].waypoints![1].distance).toBe(6); // gap from Second
  });
});

describe('transformSideTrips', () => {
  it('mirrors start distance', () => {
    const trips = [{ name: 'Trip 1', type: 'side-trip' as const, startDistance: 25 }];
    const transformed = transformSideTrips(trips, 100);

    expect(transformed[0].startDistance).toBe(75);
  });

  it('leaves unattached side trips untouched (no junction to mirror)', () => {
    // Regression: AAWT spurs starting >500m off-track have no startDistance;
    // their waypoint km are variant-relative and must not be transformed.
    const spur: RouteVariant = {
      name: 'Detached spur',
      type: 'side-trip' as const,
      distance: 2.8,
      waypoints: [{
        name: 'Homestead', type: 'poi', lat: 0, lon: 0, elevation: 100,
        distance: 0.34, totalDistance: 0.34, ascent: 5, descent: 0,
        totalAscent: 5, totalDescent: 0, variantTrackIndex: 3,
      }],
    };
    const transformed = transformSideTrips([spur], 688.3);
    expect(transformed[0].startDistance).toBeUndefined();
    expect(transformed[0].waypoints![0].totalDistance).toBe(0.34);
  });

  it('shifts waypoint absolute km with the junction, keeping variant-relative stats', () => {
    // Spur at km 25 with a campsite 3km up it → absolute km 28.
    const trips = [{
      name: 'Spur',
      type: 'side-trip' as const,
      distance: 4,
      startDistance: 25,
      waypoints: [
        {
          name: 'Camp', type: 'campsite', lat: 0, lon: 0, elevation: 200,
          distance: 3, totalDistance: 28, ascent: 50, descent: 10,
          totalAscent: 50, totalDescent: 10, variantTrackIndex: 7,
        },
      ],
    }];
    const transformed = transformSideTrips(trips, 100);

    // Junction mirrors to km 75; camp is still 3km up the spur → 78.
    const wp = transformed[0].waypoints![0];
    expect(transformed[0].startDistance).toBe(75);
    expect(wp.totalDistance).toBe(78);
    expect(wp.distance).toBe(3);   // unchanged — spur walked the same way
    expect(wp.ascent).toBe(50);    // unchanged
    expect(wp.variantTrackIndex).toBe(7); // unchanged
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
        { id: 'wp-0', name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { id: 'wp-1', name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 100 },
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
        { id: 'wp-0', name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { id: 'wp-1', name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 25 },
        { id: 'wp-2', name: 'C', lat: 2, lon: 2, type: 'trailhead', totalDistance: 50 },
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
// waypoint id stability
// ---------------------------------------------------------------------------

describe('trailJsonToTrail', () => {
  it('assigns a stable id to every waypoint', () => {
    const json: TrailJson = {
      config: {
        id: 'test',
        name: 'Test',
        shortName: 'T',
        region: 'AU',
        lengthKm: 100,
        direction: { default: 'N', reversed: 'S' },
      },
      track: { points: [], displayPoints: [], totalDistance: 100, totalAscent: 0, totalDescent: 0 },
      waypoints: [
        { name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 50 },
        { name: 'C', lat: 2, lon: 2, type: 'trailhead', totalDistance: 100 },
      ],
    };
    const trail = trailJsonToTrail(json);
    expect(trail.waypoints[0].id).toBe('wp-0');
    expect(trail.waypoints[1].id).toBe('wp-1');
    expect(trail.waypoints[2].id).toBe('wp-2');
  });
});

describe('createReversedTrail — id preservation', () => {
  it('preserves waypoint ids through reversal', () => {
    const trail: Trail = {
      config: { id: 'test', name: 'Test', shortName: 'T', region: 'AU', lengthKm: 50, direction: { default: 'N', reversed: 'S' } },
      track: {
        points: makePoints([0, 25, 50]),
        totalDistance: 50,
        totalAscent: 100,
        totalDescent: 50,
      },
      waypoints: [
        { id: 'wp-0', name: 'A', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { id: 'wp-1', name: 'B', lat: 1, lon: 1, type: 'campsite', totalDistance: 25 },
        { id: 'wp-2', name: 'C', lat: 2, lon: 2, type: 'trailhead', totalDistance: 50 },
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

describe('nearestTrackPointToLatLon', () => {
  const points: TrackPoint[] = [];
  // Straight north-south track along lon 138, from -35.0 to -35.9
  for (let i = 0; i < 100; i++) {
    points.push({ lat: -35 - i * 0.009, lon: 138, ele: 100 + i, dist: i });
  }

  it('finds the nearest point for an on-track location', () => {
    const result = nearestTrackPointToLatLon(points, -35.045, 138);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(5);
    expect(result!.distanceM).toBeLessThan(10);
  });

  it('reports the distance for an off-track location', () => {
    // ~0.01° of longitude at -35° ≈ 910 m
    const result = nearestTrackPointToLatLon(points, -35.045, 138.01);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(5);
    expect(result!.distanceM).toBeGreaterThan(800);
    expect(result!.distanceM).toBeLessThan(1000);
  });

  it('returns null for an empty track', () => {
    expect(nearestTrackPointToLatLon([], -35, 138)).toBeNull();
  });

  it('snaps to the true-nearest branch on an out-and-back (not the coarsely-closer one)', () => {
    // 1000 points → coarse step = floor(1000/500) = 2, so odd indices are
    // never sampled. Everything sits far away except a crafted hairpin near
    // the query where two branches run close together.
    const query = { lat: -35.0, lon: 138.001 };
    const track: TrackPoint[] = [];
    for (let i = 0; i < 1000; i++) {
      track.push({ lat: -40, lon: 130, ele: 0, dist: i }); // far filler
    }
    // Branch A: an EVEN coarse sample that is the single closest sample (~91 m).
    track[100] = { lat: -35.0, lon: 138.0, ele: 0, dist: 100 };
    // Branch B (the true-nearest branch): its closest point is at an ODD index
    // (~46 m) that the coarse scan skips; its neighbouring EVEN samples (~96 m)
    // are farther than branch A's sample, so the old "refine around the single
    // best sample" logic would miss it entirely and return index 100.
    track[699] = { lat: -35.0, lon: 138.0015, ele: 0, dist: 699 };
    track[698] = { lat: -35.0, lon: 138.00205, ele: 0, dist: 698 };
    track[700] = { lat: -35.0, lon: 138.00205, ele: 0, dist: 700 };

    const result = nearestTrackPointToLatLon(track, query.lat, query.lon);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(699);
    expect(result!.distanceM).toBeLessThan(60); // ~46 m; branch A would be ~91 m
  });
});
