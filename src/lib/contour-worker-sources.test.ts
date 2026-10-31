/**
 * The contour worker's source → R2 archive mapping
 * (contours/worker/src/sources.ts), imported for real rather than copied.
 */

import { describe, it, expect } from 'vitest';
import { archiveKeyForSource, DEFAULT_SOURCE, isKnownSource, SOURCES } from '../../contours/worker/src/sources';
import { parseTilePath } from '../../contours/worker/src/tile-path';

const WORLD_KEY = 'contours/world.pmtiles';

describe('contour worker sources', () => {
  it('serves world from the world archive', () => {
    expect(archiveKeyForSource('world')).toBe(WORLD_KEY);
  });

  it('keeps contours as an alias of world for shipped app builds (#228)', () => {
    expect(archiveKeyForSource('contours')).toBe(WORLD_KEY);
    expect(archiveKeyForSource('contours')).toBe(archiveKeyForSource('world'));
  });

  it('serves the planet basemap as base, for phone-built corridor packs (#227)', () => {
    expect(archiveKeyForSource('base')).toBe('basemap/planet.pmtiles');
  });

  it('no longer serves the retired Australia archive', () => {
    expect(Object.values(SOURCES)).not.toContain('contours/australia.pmtiles');
  });

  it('reports /health from a source it serves', () => {
    expect(isKnownSource(DEFAULT_SOURCE)).toBe(true);
    expect(DEFAULT_SOURCE).toBe('world');
  });

  it('maps a parsed tile path to its archive', () => {
    const tile = parseTilePath('/contours/9/444/290.pbf');
    expect(tile).not.toBeNull();
    expect(archiveKeyForSource(tile!.source)).toBe(WORLD_KEY);
  });

  it('rejects unknown sources, including inherited object keys', () => {
    for (const source of ['australia', 'secret_data', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isKnownSource(source)).toBe(false);
      expect(archiveKeyForSource(source)).toBeNull();
    }
  });
});
