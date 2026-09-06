import { describe, expect, it } from 'vitest';
import type { OverpassArea, POI, POIType } from 'gpx-tools/lib/osm-poi';
import type { POIFetcher } from 'gpx-tools/lib/overpass-client';

import { DEFAULT_OVERPASS_ENDPOINTS, enrichImportedTrail } from './poi-enrich';
import type { ProcessedTrail, RouteVariant, TrackPoint } from '@lib/trail-types';

const START_LAT = -34;
const LON = 115;
/** Latitude step between track points (~1.11 km on the ground). */
const LAT_STEP = 0.01;
/**
 * Trail km per point, deliberately unrelated to the geographic spacing: if the
 * module recomputed distances itself instead of reading `TrackPoint.dist`, the
 * assertions below would come out ~1.1 km apart rather than 10.
 */
const KM_PER_POINT = 10;

function trackPoint(index: number): TrackPoint {
  return {
    lat: START_LAT + index * LAT_STEP,
    lon: LON,
    ele: 0,
    dist: index * KM_PER_POINT,
  };
}

/** A due-north track of 10 points with a fabricated km scale. */
function makeTrail(variants: RouteVariant[] = []): ProcessedTrail {
  const points = Array.from({ length: 10 }, (_, i) => trackPoint(i));
  return {
    config: {
      id: 'u_test',
      name: 'Imported Trail',
      shortName: 'Imported',
      region: 'Imported',
      lengthKm: 90,
      gpxFile: '',
      source: 'imported',
    },
    track: {
      points,
      displayPoints: points,
      totalDistance: 90,
      totalAscent: 0,
      totalDescent: 0,
    },
    waypoints: [],
    offTrailWaypoints: [],
    alternates: variants,
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: null,
  };
}

function node(id: number, lat: number, lon: number, tags: Record<string, string>): POI {
  return { id, type: 'node', lat, lon, tags };
}

interface Seen {
  endpoints: string[];
  areas: OverpassArea[];
  types: POIType[][];
}

function newSeen(): Seen {
  return { endpoints: [], areas: [], types: [] };
}

/** A fetcher factory that answers every corridor chunk with the same fixed POIs. */
function fixedFetchers(pois: POI[], seen: Seen = newSeen()) {
  const createFetcher = (endpoint: string): POIFetcher => {
    seen.endpoints.push(endpoint);
    return async (area, types) => {
      seen.areas.push(area);
      seen.types.push(types);
      return pois;
    };
  };
  return { createFetcher, seen };
}

describe('enrichImportedTrail', () => {
  it('places POIs on the trail km scale and records cross-track distance', async () => {
    // Exactly on track point 2 (trail km 20), and half a segment past point 4.
    const onPoint = node(1, START_LAT + 2 * LAT_STEP, LON, {
      amenity: 'drinking_water',
      name: 'Tap',
    });
    const midSegment = node(2, START_LAT + 4.5 * LAT_STEP, LON, {
      tourism: 'camp_site',
      name: 'Camp',
    });
    const { createFetcher } = fixedFetchers([onPoint, midSegment]);

    const result = await enrichImportedTrail(makeTrail(), { createFetcher });

    expect(result.failedChunks).toEqual([]);
    expect(result.pois.map(p => p.id)).toEqual([1, 2]);

    const [tap, camp] = result.pois;
    expect(tap.category).toBe('water');
    expect(tap.name).toBe('Tap');
    expect(tap.distanceAlongTrail).toBeCloseTo(20, 6);
    expect(tap.distanceFromTrail).toBeCloseTo(0, 6);

    expect(camp.category).toBe('camping');
    // Halfway between points 4 (40 km) and 5 (50 km) on the trail's own scale.
    expect(camp.distanceAlongTrail).toBeCloseTo(45, 1);
  });

  it('drops POIs further than the 2 km search radius from the trail', async () => {
    // ~9 km east of the track at this latitude — well outside the radius.
    const far = node(3, START_LAT + 2 * LAT_STEP, LON + 0.1, {
      amenity: 'cafe',
    });
    const near = node(4, START_LAT + 2 * LAT_STEP, LON + 0.005, {
      amenity: 'cafe',
    });
    const { createFetcher } = fixedFetchers([far, near]);

    const result = await enrichImportedTrail(makeTrail(), { createFetcher });

    expect(result.pois.map(p => p.id)).toEqual([4]);
    expect(result.pois[0].distanceFromTrail).toBeLessThan(2);
  });

  it('measures a POI beside an alternate from the alternate junction km', async () => {
    const alternate: RouteVariant = {
      name: 'Alt',
      type: 'alternate',
      points: [0, 1, 2].map(i => ({
        lat: START_LAT + 2 * LAT_STEP,
        lon: LON + i * 0.01,
        ele: 0,
      })),
      distance: 1.8,
      elevation: { ascent: 0, descent: 0 },
      startDistance: 20,
    };
    // Sits on the alternate, ~1.4 km along it from the junction at km 20.
    const beside = node(5, START_LAT + 2 * LAT_STEP, LON + 0.015, {
      amenity: 'drinking_water',
    });
    const { createFetcher } = fixedFetchers([beside]);

    const result = await enrichImportedTrail(makeTrail([alternate]), {
      createFetcher,
    });

    expect(result.pois).toHaveLength(1);
    // Junction km plus distance along the alternate, not the main-track km (20).
    expect(result.pois[0].distanceAlongTrail).toBeGreaterThan(21);
    expect(result.pois[0].distanceAlongTrail).toBeLessThan(22);
  });

  it('queries one corridor for all five POI types and reports progress', async () => {
    const { createFetcher, seen } = fixedFetchers([]);
    const stages: string[] = [];

    const result = await enrichImportedTrail(makeTrail(), {
      createFetcher,
      onProgress: p => stages.push(p.stage),
    });

    expect(result.queryChunks).toBe(1);
    expect(result.endpoint).toBe(DEFAULT_OVERPASS_ENDPOINTS[0]);
    expect(seen.areas).toHaveLength(1);
    expect(seen.areas[0]).toHaveProperty('corridor');
    expect(seen.types[0].slice().sort()).toEqual(
      ['camping', 'emergency', 'resupply', 'transport', 'water'].sort()
    );
    expect(stages).toContain('fetch');
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('makes no request for a trail with no track points', async () => {
    const trail = makeTrail();
    trail.track.points = [];
    const { createFetcher, seen } = fixedFetchers([]);

    const result = await enrichImportedTrail(trail, { createFetcher });

    expect(result.pois).toEqual([]);
    expect(result.queryChunks).toBe(0);
    expect(seen.endpoints).toEqual([]);
  });

  it('falls back to the next endpoint when every query on the first one fails', async () => {
    const tried: string[] = [];
    const createFetcher = (endpoint: string): POIFetcher => {
      tried.push(endpoint);
      return async () => {
        if (endpoint === DEFAULT_OVERPASS_ENDPOINTS[0]) {
          throw new Error('fetch failed');
        }
        return [node(6, START_LAT + LAT_STEP, LON, { amenity: 'drinking_water' })];
      };
    };

    const result = await enrichImportedTrail(makeTrail(), { createFetcher });

    expect(tried).toEqual([...DEFAULT_OVERPASS_ENDPOINTS]);
    expect(result.endpoint).toBe(DEFAULT_OVERPASS_ENDPOINTS[1]);
    expect(result.pois.map(p => p.id)).toEqual([6]);
  });

  it('does not fall back when the caller named an endpoint, and reports the failure', async () => {
    const tried: string[] = [];
    const createFetcher = (endpoint: string): POIFetcher => {
      tried.push(endpoint);
      return async () => {
        throw new Error('fetch failed');
      };
    };

    await expect(
      enrichImportedTrail(makeTrail(), {
        createFetcher,
        endpoint: 'https://example.test/api',
      })
    ).rejects.toThrow(/fetch failed/);

    expect(tried).toEqual(['https://example.test/api']);
  });

  it('aborts without trying another endpoint', async () => {
    const controller = new AbortController();
    const tried: string[] = [];
    const createFetcher = (endpoint: string): POIFetcher => {
      tried.push(endpoint);
      return async () => {
        controller.abort();
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      };
    };

    await expect(
      enrichImportedTrail(makeTrail(), {
        createFetcher,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(tried).toEqual([DEFAULT_OVERPASS_ENDPOINTS[0]]);
  });
});
