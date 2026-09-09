/**
 * What the mobile build does to a trail's points of interest.
 *
 * The rest of `processTrail` (track simplification, coordinate truncation) is
 * covered by `src/lib/track-simplify.test.ts`; these cases pin the POI pass,
 * because it is the one that decides how much OSM data every phone carries.
 */

import { describe, it, expect } from 'vitest';
import { processTrail, type TrailJson } from './build-mobile-trails.js';
import type { TrailPOI } from '../src/lib/trail-types.js';

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
    // Not `[]`: the app reads an absent `pois` as "never fetched" and shows no
    // POI control at all.
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
