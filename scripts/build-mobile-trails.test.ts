/**
 * `processTrail` — the point-budget pass that produces `mobile/assets/trails/*`.
 *
 * Two things are pinned here. First, route breaks: simplifying the whole point
 * array at once lets Douglas-Peucker drop the points either side of a break and
 * join them with a line across the water; on Te Araroa a single pass to 5,000
 * points loses a boundary point at three of its six breaks. So each stretch is
 * simplified alone and the breaks are re-anchored. Second, the POI pass, which
 * decides how much OSM data every phone carries.
 *
 * The rest of `processTrail` (plain track simplification, coordinate
 * truncation) is covered by `src/lib/track-simplify.test.ts`.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { processTrail, type TrailJson } from './build-mobile-trails.js';
import { calculateElevationBetween } from '../src/lib/track-geometry.js';
import { routeBreakStarts } from '../src/lib/route-breaks.js';
import type { RouteBreak, TrackPoint, TrailPOI } from '../src/lib/trail-types.js';

/** Seeded LCG in [0, 1), so every run sees the same track. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/**
 * A stretch of `count` points running south from `startLat`, 11 m apart, made
 * to wander so Douglas-Peucker cannot collapse it to its two endpoints the way
 * it would a straight line.
 *
 * The wander is a random walk, not a sine. A constant-amplitude wiggle on a
 * straight line is Douglas-Peucker's worst case: every peak is equally far
 * from the chord, the first one wins, and each split peels a handful of points
 * off one end — quadratic per pass, times the twenty passes of the tolerance
 * search. That took 5–8 s per `processTrail` on a CI runner (a 5 s timeout)
 * against 0.4 s locally. A random walk's farthest point lands mid-segment, so
 * the recursion stays balanced and one call is ~30× cheaper.
 */
function stretch(
  startLat: number,
  count: number,
  startDist: number
): TrackPoint[] {
  const rand = seeded(count + Math.round(startLat * 1000));
  let lon = 174;
  return Array.from({ length: count }, (_, i) => {
    lon += (rand() - 0.5) * 0.0004;
    return {
      lat: startLat - i * 0.0001,
      lon,
      ele: 100 + (i % 7),
      dist: startDist + i * 0.011,
    };
  });
}

/** Two 8,000-point stretches with a 50 km jump between them. */
function brokenTrail() {
  const first = stretch(-41, 8000, 0);
  const second = stretch(-41.5, 8000, first[first.length - 1].dist);
  const points = [...first, ...second];
  const breaks: RouteBreak[] = [
    {
      index: first.length,
      displayIndex: 2,
      km: first[first.length - 1].dist,
      straightLineKm: 52.7,
      fromTrack: 'Stretch 1',
      toTrack: 'Stretch 2',
    },
  ];
  return {
    config: { id: 'test', name: 'Test', shortName: 'Test', lengthKm: 176 },
    track: {
      points,
      displayPoints: [
        points[0],
        points[1],
        points[first.length],
        points[points.length - 1],
      ],
      totalDistance: 176,
      totalAscent: 100,
      totalDescent: 100,
      breaks,
    },
    waypoints: [],
  };
}

function poi(over: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'water',
    lat: -34.1234567891,
    lon: 138.9876543219,
    name: 'Tank',
    tags: {},
    distanceAlongTrail: 12.3456,
    distanceFromTrail: 0.056789,
    ...over,
  };
}

function trailJson(pois?: TrailPOI[]): TrailJson {
  const points = [
    { lat: -34, lon: 138, ele: 100, dist: 0 },
    { lat: -34.05, lon: 138.05, ele: 150, dist: 5 },
    { lat: -34.1, lon: 138.1, ele: 120, dist: 10 },
  ];
  return {
    config: { id: 'test', name: 'Test Trail' },
    track: {
      points,
      displayPoints: points,
      totalDistance: 10.04,
      totalAscent: 50.4,
      totalDescent: 30.6,
    },
    waypoints: [],
    ...(pois ? { pois } : {}),
  };
}

describe('processTrail route breaks', () => {
  it('carries the breaks onto the phone', () => {
    const out = processTrail(brokenTrail());

    expect(out.track.breaks).toHaveLength(1);
    expect(out.track.breaks?.[0]).toMatchObject({
      straightLineKm: 52.7,
      fromTrack: 'Stretch 1',
      toTrack: 'Stretch 2',
    });
  });

  it('re-anchors index onto the simplified array, at the same place', () => {
    const source = brokenTrail();
    const firstPointAfterBreak =
      source.track.points[source.track.breaks[0].index];

    const out = processTrail(source);
    const rebuilt = out.track.points[out.track.breaks![0].index];

    // Coordinates are rounded to 6dp by truncatePoints, so compare rounded.
    expect(rebuilt.lat).toBeCloseTo(firstPointAfterBreak.lat, 6);
    expect(rebuilt.lon).toBeCloseTo(firstPointAfterBreak.lon, 6);
    // And the point before it is still the last one walked, 0.5 degrees north.
    expect(out.track.points[out.track.breaks![0].index - 1].lat).toBeCloseTo(
      -41.7999,
      3
    );
  });

  it('simplifies to roughly the point budget despite the extra pass', () => {
    const out = processTrail(brokenTrail());

    // simplifyToTarget stops once within 10% of its target, and each of the two
    // stretches is given half the budget, so the sum can land anywhere in that
    // band either side of 5,000.
    expect(out.track.points.length).toBeLessThanOrEqual(5500);
    expect(out.track.points.length).toBeGreaterThan(4500);
  });

  it('leaves displayIndex alone — displayPoints are not re-simplified', () => {
    const out = processTrail(brokenTrail());

    expect(out.track.displayPoints).toHaveLength(4);
    expect(out.track.breaks?.[0].displayIndex).toBe(2);
  });

  it('emits no breaks field for a continuous trail', () => {
    const trail = brokenTrail();
    const continuous = {
      ...trail,
      track: { ...trail.track, breaks: undefined },
    };

    const out = processTrail(continuous);

    expect(out.track.breaks).toBeUndefined();
    expect(out.track.points.length).toBeGreaterThan(1000);
  });
});

describe('processTrail POIs', () => {
  it('ships a POI with only the tag keys the app reads', () => {
    const fat = poi({
      tags: {
        amenity: 'drinking_water',
        description: 'Rainwater tank',
        operator: 'DBCA',
        source: 'survey',
        'source:date': '2024-01-01',
        check_date: '2024-01-01',
        note: 'behind the shelter',
        fixme: 'position approximate',
        material: 'steel',
        colour: 'green',
        wheelchair: 'limited',
        indoor: 'no',
        bottle: 'yes',
        seasonal: 'no',
        'ref:water': 'W-1',
        survey: 'yes',
        'addr:city': 'Hawker',
        'addr:street': 'Elder Terrace',
        image: 'https://example.com/tank.jpg',
        website: 'https://example.com',
      },
    });

    const [shipped] = processTrail(trailJson([fat])).pois!;
    expect(Object.keys(shipped.tags).sort()).toEqual([
      'amenity',
      'description',
      'operator',
      'website',
    ]);
    expect(shipped.lat).toBe(-34.123457);
    expect(shipped.distanceAlongTrail).toBe(12.3);
    expect(shipped.distanceFromTrail).toBe(0.06);
  });

  it('keeps the duplicate flag and drops the review-only distance', () => {
    const [shipped] = processTrail(
      trailJson([poi({ duplicateOf: 'w_abc', duplicateDistanceM: 11.7 })])
    ).pois!;
    expect(shipped.duplicateOf).toBe('w_abc');
    expect('duplicateDistanceM' in shipped).toBe(false);
  });

  it('omits the pois key entirely for a trail that was never enriched', () => {
    // Not `[]`: the app reads an absent `pois` as "never fetched", which the
    // app shows differently from "found nothing".
    const built = processTrail(trailJson());
    expect('pois' in built).toBe(false);
  });

  it('leaves everything but the POIs alone when a trail has them', () => {
    const withPois = processTrail(trailJson([poi()]));
    const without = processTrail(trailJson());
    const { pois: _pois, ...rest } = withPois;
    expect(rest).toEqual(without);
  });
});

/**
 * The other half of the phone's point budget: thinning the track throws away
 * most of its small climbs, so the climb has to be measured before the thinning
 * and carried on the points that survive it (issue #69).
 */
describe('processTrail cumulative climb', () => {
  /**
   * Within half a percent. Not exact, because a query km lands between two kept
   * points and snaps to the nearer one — a metre or two of climb either side of
   * the boundary — which is the whole of what thinning still costs.
   */
  function expectNearly(actual: number, expected: number) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
      Math.max(3, expected * 0.005)
    );
  }

  /** Gain summed the old way: point-to-point over the thinned track. */
  function walkGain(points: TrackPoint[]): number {
    let gain = 0;
    for (let i = 1; i < points.length; i++) {
      const diff = points[i].ele - points[i - 1].ele;
      if (diff > 0) gain += diff;
    }
    return Math.round(gain);
  }

  /**
   * A wandering 12,000-point trail — two and a half times the phone's budget —
   * whose elevation carries the metre-scale jitter a real GPS track has on top
   * of its hills. That jitter is most of the climb and none of the shape, so
   * Douglas-Peucker drops it: exactly the loss issue #69 measured. The line
   * itself is a random walk, for the reason given on `stretch`.
   */
  function bumpyTrail() {
    const rand = seeded(13579);
    let lon = 115;
    const points: TrackPoint[] = Array.from({ length: 12000 }, (_, i) => {
      lon += (rand() - 0.5) * 0.0004;
      return {
        lat: -33 - i * 0.0001,
        lon,
        ele: 300 + Math.sin(i / 400) * 120 + (rand() - 0.5) * 8,
        dist: i * 0.01,
      };
    });
    return {
      config: { id: 'test', name: 'Test', shortName: 'Test', lengthKm: 120 },
      track: {
        points,
        // Every 3rd point, so displayPoints is a genuine subsequence, as
        // Douglas-Peucker leaves it.
        displayPoints: points.filter((_, i) => i % 3 === 0 || i === points.length - 1),
        totalDistance: points[points.length - 1].dist,
        totalAscent: 0,
        totalDescent: 0,
      },
      waypoints: [],
    };
  }

  // The unmodified trail is thinned once and read by every test that does not
  // change it: `processTrail` is the expensive part of this file.
  let bumpy: ReturnType<typeof bumpyTrail>;
  let thinnedBumpy: ReturnType<typeof processTrail>;
  beforeAll(() => {
    bumpy = bumpyTrail();
    thinnedBumpy = processTrail(bumpy);
  });

  it('reports the full-resolution climb off the thinned points', () => {
    const endKm = bumpy.track.totalDistance;
    const full = calculateElevationBetween(0, endKm, bumpy.track.points);

    expect(thinnedBumpy.track.points.length).toBeLessThan(bumpy.track.points.length);
    // The bug: walking the thinned points loses most of the small climbs.
    expect(walkGain(thinnedBumpy.track.points)).toBeLessThan(full.gain * 0.9);
    // The fix: the carried sums still have all of it.
    const climb = calculateElevationBetween(0, endKm, thinnedBumpy.track.points);
    expectNearly(climb.gain, full.gain);
    expectNearly(climb.loss, full.loss);
  });

  it('gives displayPoints the same numbers — custom routes are measured on them', () => {
    const endKm = bumpy.track.totalDistance;
    const full = calculateElevationBetween(0, endKm, bumpy.track.points);

    expect(walkGain(thinnedBumpy.track.displayPoints)).toBeLessThan(full.gain * 0.95);
    const climb = calculateElevationBetween(0, endKm, thinnedBumpy.track.displayPoints);
    expectNearly(climb.gain, full.gain);
    expectNearly(climb.loss, full.loss);
  });

  it('agrees with the full-resolution walk over an interior span too', () => {
    const full = calculateElevationBetween(30, 70, bumpy.track.points);

    const climb = calculateElevationBetween(30, 70, thinnedBumpy.track.points);
    expectNearly(climb.gain, full.gain);
    expectNearly(climb.loss, full.loss);
  });

  it('rounds the pair to whole metres', () => {
    for (const point of [thinnedBumpy.track.points[10], thinnedBumpy.track.displayPoints[10]]) {
      expect(point.cumAscent).toBe(Math.round(point.cumAscent as number));
      expect(point.cumDescent).toBe(Math.round(point.cumDescent as number));
    }
  });

  it('does not climb the step across a route break', () => {
    const source = brokenTrail();
    // Lift the second stretch 500 m: the jump across the water is not walked,
    // so it must not appear in the sums.
    source.track.points = source.track.points.map((p, i) =>
      i >= source.track.breaks[0].index ? { ...p, ele: p.ele + 500 } : p
    );
    source.track.displayPoints = [
      source.track.points[0],
      source.track.points[1],
      source.track.points[source.track.breaks[0].index],
      source.track.points[source.track.points.length - 1],
    ];
    const full = calculateElevationBetween(
      0,
      source.track.totalDistance,
      source.track.points,
      routeBreakStarts(source.track.breaks, 'points')
    );

    const out = processTrail(source);

    const climb = calculateElevationBetween(0, source.track.totalDistance, out.track.points);
    expectNearly(climb.gain, full.gain);
    // Not the 500 m jump: counting it would add a third again.
    expect(climb.gain).toBeLessThan(full.gain + 100);
    expect(out.track.points[out.track.breaks![0].index].cumAscent).toBe(
      out.track.points[out.track.breaks![0].index - 1].cumAscent
    );
  });

  it('falls back to the nearest point by km when displayPoints is not a subsequence', () => {
    const source = bumpyTrail();
    const endKm = source.track.totalDistance;
    const full = calculateElevationBetween(0, endKm, source.track.points);
    // Coordinates nudged off the full-resolution ones, so the coordinate walk
    // cannot match a single point.
    source.track.displayPoints = source.track.points
      .filter((_, i) => i % 3 === 0 || i === source.track.points.length - 1)
      .map(p => ({ ...p, lat: p.lat + 1e-9 }));

    const out = processTrail(source);

    const climb = calculateElevationBetween(0, endKm, out.track.displayPoints);
    expectNearly(climb.gain, full.gain);
    expectNearly(climb.loss, full.loss);
  });

  it('leaves a trail alone when it has no elevation to speak of', () => {
    const source = bumpyTrail();
    source.track.points = source.track.points.map(p => ({ ...p, ele: 0 }));
    source.track.displayPoints = source.track.points.filter((_, i) => i % 3 === 0);

    const out = processTrail(source);

    expect(out.track.points.every(p => p.cumAscent === 0 && p.cumDescent === 0)).toBe(true);
  });
});
