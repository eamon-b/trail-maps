import { describe, it, expect } from 'vitest';

import {
  buildTrailPOIFile,
  parseTrailPOIFile,
  poisForBuild,
  readTrailPOIFile,
  readTrailPOIsForBuild,
  sortTrailPOIs,
  stringifyTrailPOIFile,
  trailPOIPath,
  type PoiFileIO,
  type TrailPOIFile,
} from './trail-pois-file.js';
import type { TrailPOI } from '../../src/lib/trail-types.js';

function poi(id: number, km: number, type = 'node'): TrailPOI {
  return {
    id,
    type,
    category: 'water',
    lat: -34,
    lon: 115,
    name: `POI ${type}/${id}`,
    tags: { amenity: 'drinking_water' },
    distanceAlongTrail: km,
    distanceFromTrail: 0.1,
  };
}

function file(overrides: Partial<TrailPOIFile> = {}): TrailPOIFile {
  return {
    source: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors (ODbL)',
    fetchedAt: '2026-09-06T00:00:00.000Z',
    searchRadiusKm: 2,
    endpoint: 'https://overpass-api.de/api/interpreter',
    rejected: [],
    pois: [],
    ...overrides,
  };
}

/** A PoiFileIO backed by a plain map of path → contents. */
function fakeIO(files: Record<string, string>): PoiFileIO {
  return {
    existsSync: p => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: p => files[p],
  };
}

describe('parseTrailPOIFile', () => {
  it('names the file in the error when the JSON will not parse', () => {
    expect(() => parseTrailPOIFile('{ not json', '/repo/data/trails/heysen/pois.json')).toThrow(
      /Invalid POI file \/repo\/data\/trails\/heysen\/pois\.json/
    );
  });

  it('names the file when the top level is not an object', () => {
    expect(() => parseTrailPOIFile('[]', '/x/pois.json')).toThrow(
      /Invalid POI file \/x\/pois\.json: expected a JSON object/
    );
  });

  it('rejects a file with no pois array', () => {
    expect(() => parseTrailPOIFile('{"rejected":[]}', '/x/pois.json')).toThrow(/"pois" array/);
  });

  it('rejects a malformed POI entry, naming its index', () => {
    const text = JSON.stringify(file({ pois: [{ id: 'nope' } as unknown as TrailPOI] }));
    expect(() => parseTrailPOIFile(text, '/x/pois.json')).toThrow(/pois\[0\] is not a POI/);
  });

  it('rejects a non-string entry in the hand-edited rejected list', () => {
    const text = JSON.stringify(file({ rejected: [123 as unknown as string] }));
    expect(() => parseTrailPOIFile(text, '/x/pois.json')).toThrow(/"rejected" to be an array/);
  });

  it('round-trips a well-formed file', () => {
    const original = file({ pois: [poi(1, 5)], rejected: ['node/9'] });
    expect(parseTrailPOIFile(stringifyTrailPOIFile(original), '/x/pois.json')).toEqual(original);
  });

  it('defaults missing provenance rather than failing', () => {
    const parsed = parseTrailPOIFile('{"pois":[]}', '/x/pois.json');
    expect(parsed.source).toBe('OpenStreetMap');
    expect(parsed.attribution).toContain('OpenStreetMap contributors');
    expect(parsed.rejected).toEqual([]);
  });
});

describe('sortTrailPOIs', () => {
  it('orders by distance along the trail, breaking ties by key', () => {
    const sorted = sortTrailPOIs([
      poi(2, 10, 'way'),
      poi(30, 10, 'node'),
      poi(4, 10, 'node'),
      poi(1, 3),
    ]);
    expect(sorted.map(p => `${p.type}/${p.id}@${p.distanceAlongTrail}`)).toEqual([
      'node/1@3',
      // Ties: "node/30" sorts before "node/4" as a string, and node before way.
      'node/30@10',
      'node/4@10',
      'way/2@10',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [poi(2, 10), poi(1, 3)];
    sortTrailPOIs(input);
    expect(input.map(p => p.id)).toEqual([2, 1]);
  });
});

describe('poisForBuild', () => {
  it('drops the rejected keys and sorts what is left', () => {
    const result = poisForBuild(
      file({
        pois: [poi(3, 30), poi(1, 10), poi(2, 20, 'way')],
        rejected: ['way/2'],
      })
    );
    expect(result.map(p => p.id)).toEqual([1, 3]);
  });

  it('matches on type as well as id — ids repeat across element types', () => {
    const result = poisForBuild(
      file({
        pois: [poi(7, 10, 'node'), poi(7, 20, 'way')],
        rejected: ['way/7'],
      })
    );
    expect(result.map(p => `${p.type}/${p.id}`)).toEqual(['node/7']);
  });

  it('keeps everything when nothing is rejected', () => {
    const result = poisForBuild(file({ pois: [poi(1, 10), poi(2, 20)] }));
    expect(result).toHaveLength(2);
  });
});

describe('readTrailPOIsForBuild', () => {
  const trailDir = '/repo/data/trails/heysen';

  it('returns null when the trail has no pois.json, so no `pois` key is emitted', () => {
    expect(readTrailPOIsForBuild(trailDir, fakeIO({}))).toBeNull();
  });

  it('reads and filters the file beside the trail config', () => {
    const io = fakeIO({
      [trailPOIPath(trailDir)]: stringifyTrailPOIFile(
        file({ pois: [poi(2, 20), poi(1, 10)], rejected: ['node/2'] })
      ),
    });
    expect(readTrailPOIsForBuild(trailDir, io)?.map(p => p.id)).toEqual([1]);
  });

  it('propagates the naming error for a malformed file', () => {
    const io = fakeIO({ [trailPOIPath(trailDir)]: 'oops' });
    expect(() => readTrailPOIsForBuild(trailDir, io)).toThrow(/heysen\/pois\.json/);
  });
});

describe('buildTrailPOIFile', () => {
  it('carries the hand-edited rejected list across a re-fetch', () => {
    const existing = readTrailPOIFile(
      '/repo/data/trails/heysen',
      fakeIO({
        '/repo/data/trails/heysen/pois.json': stringifyTrailPOIFile(
          file({ rejected: ['node/1', 'way/2'], pois: [poi(1, 10)] })
        ),
      })
    );

    const next = buildTrailPOIFile({
      existing,
      pois: [poi(5, 50), poi(1, 10)],
      fetchedAt: '2026-09-07T00:00:00.000Z',
      searchRadiusKm: 2,
      endpoint: 'https://overpass.kumi.systems/api/interpreter',
    });

    expect(next.rejected).toEqual(['node/1', 'way/2']);
    expect(next.pois.map(p => p.id)).toEqual([1, 5]);
    expect(next.fetchedAt).toBe('2026-09-07T00:00:00.000Z');
    expect(next.endpoint).toBe('https://overpass.kumi.systems/api/interpreter');
  });

  it('starts an empty rejected list for a first fetch', () => {
    const next = buildTrailPOIFile({
      existing: null,
      pois: [],
      fetchedAt: '2026-09-07T00:00:00.000Z',
      searchRadiusKm: 2,
      endpoint: 'https://overpass-api.de/api/interpreter',
    });
    expect(next.rejected).toEqual([]);
  });
});

describe('stringifyTrailPOIFile', () => {
  it('writes stable 2-space JSON with a trailing newline', () => {
    const text = stringifyTrailPOIFile(file({ pois: [poi(1, 10)] }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[1]).toBe('  "source": "OpenStreetMap",');
    expect(text).toBe(stringifyTrailPOIFile(file({ pois: [poi(1, 10)] })));
  });
});
