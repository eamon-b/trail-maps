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

import { describe, it, expect } from 'vitest';
import { processTrail, type TrailJson } from './build-mobile-trails.js';
import type { RouteBreak, TrackPoint, TrailPOI } from '../src/lib/trail-types.js';

/**
 * A stretch of `count` points running south from `startLat`, 11 m apart, made
 * to wander so Douglas-Peucker cannot collapse it to its two endpoints the way
 * it would a straight line.
 */
function stretch(
  startLat: number,
  count: number,
  startDist: number
): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: startLat - i * 0.0001,
    lon: 174 + Math.sin(i / 3) * 0.002,
    ele: 100 + (i % 7),
    dist: startDist + i * 0.011,
  }));
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

    expect(out.track.points.length).toBeLessThanOrEqual(5200);
    expect(out.track.points.length).toBeGreaterThan(1000);
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
