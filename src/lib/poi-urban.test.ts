import { describe, it, expect } from 'vitest';

import {
  ANCHOR_SPACING_KM,
  DENSE_POIS_PER_KM,
  MIN_STRETCH_POIS,
  anchorKind,
  findDenseStretches,
  thinUrbanPois,
} from './poi-urban.js';
import type { TrailPOI, TrailPOICategory } from './trail-types.js';

let nextId = 1;

function poi(
  km: number,
  category: TrailPOICategory = 'restaurant',
  tags: Record<string, string> = { amenity: 'cafe' },
  overrides: Partial<TrailPOI> = {}
): TrailPOI {
  return {
    id: nextId++,
    type: 'node',
    category,
    lat: -36.8,
    lon: 174.7,
    name: null,
    tags,
    distanceAlongTrail: km,
    distanceFromTrail: 0.5,
    ...overrides,
  };
}

/** `perKm` cafés on every km from `fromKm` up to (not including) `toKm`. */
function cafes(fromKm: number, toKm: number, perKm: number): TrailPOI[] {
  const out: TrailPOI[] = [];
  for (let km = fromKm; km < toKm; km++) {
    for (let i = 0; i < perKm; i++) out.push(poi(km + (i + 0.5) / perKm));
  }
  return out;
}

const keys = (pois: TrailPOI[] | undefined) => new Set((pois ?? []).map(p => `${p.type}/${p.id}`));

describe('anchorKind', () => {
  it('names the services a walker looks for in a city', () => {
    expect(anchorKind(poi(0, 'resupply', { shop: 'supermarket' }))).toBe('supermarket');
    expect(anchorKind(poi(0, 'resupply', { shop: 'outdoor' }))).toBe('outdoor');
    expect(anchorKind(poi(0, 'resupply', { amenity: 'post_office' }))).toBe('post-office');
    expect(anchorKind(poi(0, 'camping', { tourism: 'camp_site' }))).toBe('campground');
    expect(anchorKind(poi(0, 'camping', { tourism: 'caravan_site' }))).toBe('campground');
    expect(anchorKind(poi(0, 'transport', { railway: 'station' }))).toBe('station');
    expect(anchorKind(poi(0, 'transport', { amenity: 'ferry_terminal' }))).toBe('ferry');
  });

  it('counts a hospital only when it has an emergency department', () => {
    expect(anchorKind(poi(0, 'emergency', { amenity: 'hospital', emergency: 'yes' }))).toBe('hospital');
    // Untagged "hospitals" are rest homes and day-surgery clinics.
    expect(anchorKind(poi(0, 'emergency', { amenity: 'hospital' }))).toBeNull();
  });

  it('is not an anchor for the clutter', () => {
    const clutter: Record<string, string>[] = [
      { amenity: 'cafe' },
      { shop: 'convenience' },
      { amenity: 'drinking_water' },
    ];
    for (const tags of clutter) {
      expect(anchorKind(poi(0, 'restaurant', tags))).toBeNull();
    }
  });
});

describe('findDenseStretches', () => {
  it('finds nothing on a quiet trail', () => {
    expect(findDenseStretches(cafes(0, 100, 1))).toEqual([]);
  });

  it('finds a city and leaves a main-street town alone', () => {
    const town = cafes(20, 22, 10); // 20 POIs: dense over a km, but a town
    const city = cafes(50, 60, 30);
    const stretches = findDenseStretches([...cafes(0, 100, 1), ...town, ...city]);
    expect(stretches).toHaveLength(1);
    expect(stretches[0].fromKm).toBeLessThanOrEqual(50);
    expect(stretches[0].toKm).toBeGreaterThanOrEqual(60);
  });

  it('does not call a busy corner a city', () => {
    // Dense enough for one km, but fewer POIs than a city holds.
    const corner = cafes(10, 11, MIN_STRETCH_POIS - 1);
    expect(MIN_STRETCH_POIS - 1).toBeGreaterThan(DENSE_POIS_PER_KM);
    expect(findDenseStretches(corner)).toEqual([]);
  });

  it('grows a city out into its suburbs', () => {
    const suburb = cafes(40, 45, 10); // under the seed threshold, over half of it
    const city = cafes(45, 55, 40);
    const [stretch] = findDenseStretches([...suburb, ...city]);
    // The seed starts at 45; the suburb (bar its outermost km, which the
    // window half-averages with empty trail) comes with it.
    expect(stretch.fromKm).toBeLessThanOrEqual(41);
  });

  it('ignores POIs with no km', () => {
    expect(findDenseStretches([poi(NaN)])).toEqual([]);
  });
});

describe('thinUrbanPois', () => {
  it('passes undefined through and leaves a quiet trail alone', () => {
    expect(thinUrbanPois(undefined)).toBeUndefined();
    const quiet = cafes(0, 100, 1);
    expect(thinUrbanPois(quiet)).toEqual(quiet);
  });

  it('keeps the first and last of each category through the city and drops the middle', () => {
    const city = cafes(50, 60, 30);
    const kept = thinUrbanPois(city)!;
    expect(kept.map(p => p.distanceAlongTrail)).toEqual([
      city[0].distanceAlongTrail,
      city[city.length - 1].distanceAlongTrail,
    ]);
  });

  it('keeps one anchor of each kind per spacing, preferring a brand, then the nearest', () => {
    const city = cafes(50, 60, 30);
    // First and last of each category, so the anchors below are all mid-city.
    const edges = [
      poi(50.05, 'resupply', { shop: 'convenience' }),
      poi(59.95, 'resupply', { shop: 'convenience' }),
      poi(50.05, 'transport', { amenity: 'ferry_terminal' }),
      poi(59.95, 'transport', { amenity: 'ferry_terminal' }),
    ];
    const grocer = poi(52.1, 'resupply', { shop: 'supermarket' }, { distanceFromTrail: 0.1 });
    const chain = poi(52.2, 'resupply', { shop: 'supermarket', brand: 'Woolworths' }, { distanceFromTrail: 0.9 });
    const near = poi(55.1, 'transport', { railway: 'station' }, { distanceFromTrail: 0.2 });
    const far = poi(55.2, 'transport', { railway: 'station' }, { distanceFromTrail: 1.5 });
    const kept = keys(thinUrbanPois([...city, ...edges, grocer, chain, near, far]));

    expect(kept.has(`node/${chain.id}`)).toBe(true);
    expect(kept.has(`node/${grocer.id}`)).toBe(false);
    expect(kept.has(`node/${near.id}`)).toBe(true);
    expect(kept.has(`node/${far.id}`)).toBe(false);
    for (const edge of edges) expect(kept.has(`node/${edge.id}`)).toBe(true);
  });

  it('spaces anchors of a kind by ANCHOR_SPACING_KM', () => {
    const city = cafes(50, 70, 30);
    const shops = Array.from({ length: 20 }, (_, i) =>
      poi(50 + i + 0.5, 'resupply', { shop: 'supermarket', brand: 'Woolworths' })
    );
    const kept = thinUrbanPois([...city, ...shops])!.filter(p => p.tags.shop === 'supermarket');
    expect(kept.length).toBeLessThanOrEqual(Math.ceil(20 / ANCHOR_SPACING_KM) + 2);
    expect(kept.length).toBeGreaterThanOrEqual(Math.floor(20 / ANCHOR_SPACING_KM));
  });

  it('never drops a POI that stands in for a curated waypoint', () => {
    const city = cafes(50, 60, 30);
    const dup = poi(55, 'restaurant', { amenity: 'cafe' }, { duplicateOf: 'wp-1' });
    expect(keys(thinUrbanPois([...city, dup])).has(`node/${dup.id}`)).toBe(true);
  });

  it('does not touch POIs outside the city', () => {
    const town = cafes(10, 12, 5);
    const city = cafes(50, 60, 30);
    const kept = keys(thinUrbanPois([...town, ...city]));
    for (const p of town) expect(kept.has(`node/${p.id}`)).toBe(true);
  });
});
