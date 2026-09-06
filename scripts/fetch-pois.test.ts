import { describe, it, expect } from 'vitest';
import type { POI, POIType, OverpassArea } from 'gpx-tools/lib/osm-poi';
import type { POIFetcher } from 'gpx-tools/lib/overpass-client';

import * as path from 'path';

import {
  positionalArgs,
  processTrailData,
  resolveEndpoint,
  resolveTimeoutSeconds,
  trailDirsById,
  type TrailDirIO,
} from './fetch-pois.js';
import type { ProcessedTrail, RouteVariant, TrackPoint } from '../src/lib/trail-types.js';

const START_LAT = -34;
const LON = 115;
/** Latitude step between track points (~1.11 km on the ground). */
const LAT_STEP = 0.01;
/**
 * Trail km per point, deliberately unrelated to the geographic spacing: if the
 * script recomputed distances itself instead of reading `TrackPoint.dist`, the
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
      id: 'test',
      name: 'Test Trail',
      shortName: 'Test',
      region: 'Nowhere',
      lengthKm: 90,
      gpxFile: 'test.gpx',
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

/** A fetcher that answers every corridor chunk with the same fixed POIs. */
function fixedFetcher(
  pois: POI[],
  seen?: { areas: OverpassArea[]; types: POIType[][] }
): POIFetcher {
  return async (area, types) => {
    seen?.areas.push(area);
    seen?.types.push(types);
    return pois;
  };
}

describe('processTrailData', () => {
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

    const result = await processTrailData(makeTrail(), fixedFetcher([onPoint, midSegment]));

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

  it('drops POIs further than the search radius from the trail', async () => {
    // ~9 km east of the track at this latitude — well outside the 2 km radius.
    const far = node(3, START_LAT + 2 * LAT_STEP, LON + 0.1, {
      amenity: 'cafe',
    });
    const near = node(4, START_LAT + 2 * LAT_STEP, LON + 0.005, {
      amenity: 'cafe',
    });

    const result = await processTrailData(makeTrail(), fixedFetcher([far, near]));

    expect(result.pois.map(p => p.id)).toEqual([4]);
    expect(result.pois[0].distanceFromTrail).toBeGreaterThan(0);
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

    const result = await processTrailData(makeTrail([alternate]), fixedFetcher([beside]));

    expect(result.pois).toHaveLength(1);
    expect(result.pois[0].distanceFromTrail).toBeCloseTo(0, 3);
    // Junction km plus distance along the alternate, not the main-track km (20).
    expect(result.pois[0].distanceAlongTrail).toBeGreaterThan(21);
    expect(result.pois[0].distanceAlongTrail).toBeLessThan(22);
  });

  it('queries a corridor for all six POI types', async () => {
    const seen = { areas: [] as OverpassArea[], types: [] as POIType[][] };
    const result = await processTrailData(makeTrail(), fixedFetcher([], seen));

    expect(result.queryChunks).toBe(1);
    expect(seen.areas).toHaveLength(1);
    expect(seen.areas[0]).toHaveProperty('corridor');
    expect(seen.types[0].sort()).toEqual(
      ['camping', 'emergency', 'restaurant', 'resupply', 'transport', 'water'].sort()
    );
  });

  it('returns nothing for a trail with no track points', async () => {
    const trail = makeTrail();
    trail.track.points = [];

    const result = await processTrailData(trail, fixedFetcher([]));

    expect(result.pois).toEqual([]);
    expect(result.queryChunks).toBe(0);
  });
});

/** A TrailDirIO over a plain map of path -> file contents; keys ending in '/' are directories. */
function fakeIO(entries: Record<string, string>): TrailDirIO {
  const isDir = (p: string) => Object.keys(entries).some(k => k.startsWith(`${p}/`));
  return {
    existsSync: p => p in entries || isDir(p),
    readFileSync: p => entries[p],
    readdirSync: dir => {
      const names = new Set<string>();
      for (const key of Object.keys(entries)) {
        if (!key.startsWith(`${dir}/`)) continue;
        names.add(key.slice(dir.length + 1).split('/')[0]);
      }
      return [...names].map(name => ({
        name,
        isDirectory: () => isDir(path.join(dir, name)),
      }));
    },
  };
}

describe('trailDirsById', () => {
  const DATA = '/repo/data/trails';

  it('maps the trail id from trail.json, not the directory name', () => {
    const io = fakeIO({
      [`${DATA}/AAWT/trail.json`]: JSON.stringify({ id: 'aawt' }),
      [`${DATA}/Hume_and_Hovell/trail.json`]: JSON.stringify({ id: 'hume-and-hovell' }),
      [`${DATA}/cape_to_cape/trail.json`]: JSON.stringify({ id: 'cape_to_cape' }),
    });

    const dirs = trailDirsById(DATA, io);

    expect(dirs.get('aawt')).toBe(`${DATA}/AAWT`);
    expect(dirs.get('hume-and-hovell')).toBe(`${DATA}/Hume_and_Hovell`);
    expect(dirs.get('cape_to_cape')).toBe(`${DATA}/cape_to_cape`);
    expect(dirs.get('AAWT')).toBeUndefined();
  });

  it('skips directories without a trail.json and configs that will not parse', () => {
    const io = fakeIO({
      [`${DATA}/heysen/trail.json`]: JSON.stringify({ id: 'heysen' }),
      [`${DATA}/scratch/notes.txt`]: 'nothing here',
      [`${DATA}/broken/trail.json`]: '{ not json',
      [`${DATA}/nameless/trail.json`]: JSON.stringify({ name: 'no id' }),
    });

    expect([...trailDirsById(DATA, io).keys()]).toEqual(['heysen']);
  });

  it('returns an empty map when the data directory is missing', () => {
    expect(trailDirsById(DATA, fakeIO({})).size).toBe(0);
  });
});

describe('resolveEndpoint', () => {
  const DEFAULT = 'https://overpass-api.de/api/interpreter';

  it('defaults to the gpx-tools endpoint', () => {
    expect(resolveEndpoint([], {})).toBe(DEFAULT);
  });

  it('reads OVERPASS_ENDPOINT', () => {
    expect(resolveEndpoint([], { OVERPASS_ENDPOINT: 'https://kumi.example/api' })).toBe(
      'https://kumi.example/api'
    );
  });

  it('lets --endpoint beat the environment', () => {
    expect(
      resolveEndpoint(['--endpoint', 'https://flag.example/api'], {
        OVERPASS_ENDPOINT: 'https://env.example/api',
      })
    ).toBe('https://flag.example/api');
  });

  it('accepts --endpoint=<url>', () => {
    expect(resolveEndpoint(['--endpoint=https://inline.example/api'], {})).toBe(
      'https://inline.example/api'
    );
  });

  it('throws when --endpoint has no value', () => {
    expect(() => resolveEndpoint(['--endpoint'], {})).toThrow(/--endpoint requires a URL/);
    expect(() => resolveEndpoint(['--endpoint', '--dry-run'], {})).toThrow(
      /--endpoint requires a URL/
    );
  });
});

describe('resolveTimeoutSeconds', () => {
  it('defaults to the gpx-tools [timeout:]', () => {
    expect(resolveTimeoutSeconds([])).toBe(22);
  });

  it('reads --timeout and --timeout=', () => {
    expect(resolveTimeoutSeconds(['--timeout', '120'])).toBe(120);
    expect(resolveTimeoutSeconds(['--timeout=120'])).toBe(120);
  });

  it('rejects a non-positive or non-numeric timeout', () => {
    expect(() => resolveTimeoutSeconds(['--timeout', 'soon'])).toThrow(/positive number/);
    expect(() => resolveTimeoutSeconds(['--timeout', '0'])).toThrow(/positive number/);
    expect(() => resolveTimeoutSeconds(['--timeout'])).toThrow(
      /--timeout requires a number of seconds/
    );
  });
});

describe('positionalArgs', () => {
  it('does not mistake a flag value for a trail id', () => {
    expect(
      positionalArgs(['--endpoint', 'https://kumi.example/api', '--timeout', '120', 'heysen'])
    ).toEqual(['heysen']);
  });

  it('drops flags', () => {
    expect(positionalArgs(['heysen', '--dry-run'])).toEqual(['heysen']);
  });
});
