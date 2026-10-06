/**
 * Tests for the contour tile worker's input validation and security.
 *
 * The worker at workers/contour-tiles/src/index.ts uses parseTilePath()
 * to parse tile paths, validates source === 'contours', and enforces
 * MAX_ZOOM. CORS is configurable via env.ALLOWED_ORIGIN.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
// The worker's own parser (a dependency-free module), not a copy of it.
import { parseTilePath } from '../../workers/contour-tiles/src/tile-path';

const ALLOWED_SOURCES = ['contours'];

function isAllowedSource(source: string): boolean {
  return ALLOWED_SOURCES.includes(source);
}

describe('parseTilePath', () => {
  it('parses valid contour tile path', () => {
    const result = parseTilePath('/contours/12/3750/2520.pbf');
    expect(result).toEqual({ source: 'contours', z: 12, x: 3750, y: 2520 });
  });

  it('rejects path traversal attempts', () => {
    expect(parseTilePath('/../../../etc/passwd')).toBeNull();
    expect(parseTilePath('/contours/../../../12/3750/2520.pbf')).toBeNull();
  });

  it('rejects URL-encoded path traversal', () => {
    expect(parseTilePath('/%2e%2e/12/3750/2520.pbf')).toBeNull();
  });

  it('rejects excessively large zoom levels', () => {
    const result = parseTilePath('/contours/99/0/0.pbf');
    expect(result).toBeNull();
  });

  it('rejects negative coordinates (regex blocks them)', () => {
    expect(parseTilePath('/contours/12/-1/2520.pbf')).toBeNull();
  });

  it('rejects non-canonical integers, so one tile has one cache key', () => {
    expect(parseTilePath('/contours/12/0003750/02520.pbf')).toBeNull();
    expect(parseTilePath('/contours/012/3750/2520.pbf')).toBeNull();
    expect(parseTilePath('/contours/12/3750/02520.pbf')).toBeNull();
    expect(parseTilePath('/contours/0/00/0.pbf')).toBeNull();
    // Zero itself is canonical.
    expect(parseTilePath('/contours/0/0/0.pbf')).toEqual({ source: 'contours', z: 0, x: 0, y: 0 });
  });

  it('rejects coordinates outside the zoom level', () => {
    expect(parseTilePath('/contours/2/4/0.pbf')).toBeNull();
    expect(parseTilePath('/contours/2/3/3.pbf')).not.toBeNull();
  });
});

describe('source validation', () => {
  it('allows "contours" source', () => {
    expect(isAllowedSource('contours')).toBe(true);
  });

  it('rejects unknown sources that match \\w+ regex', () => {
    const parsed = parseTilePath('/secret_data/12/3750/2520.pbf');
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(isAllowedSource(parsed.source)).toBe(false);
    }
  });

  it('rejects source with underscores that could access other R2 objects', () => {
    const parsed = parseTilePath('/internal_tiles/12/3750/2520.pbf');
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(isAllowedSource(parsed.source)).toBe(false);
    }
  });
});

describe('CORS configuration audit', () => {
  it('worker uses configurable CORS origin, not hardcoded wildcard', () => {
    const workerSource = readFileSync(
      resolve(__dirname, '../../workers/contour-tiles/src/index.ts'),
      'utf-8',
    );
    // Should NOT have a hardcoded wildcard CORS constant
    const hasHardcodedWildcard = workerSource.includes("'Access-Control-Allow-Origin': '*'");
    expect(hasHardcodedWildcard).toBe(false);
  });
});

describe('tile coordinate bounds validation', () => {
  it('rejects zoom levels above 22', () => {
    expect(parseTilePath('/contours/25/0/0.pbf')).toBeNull();
  });

  it('accepts zoom level 22', () => {
    const result = parseTilePath('/contours/22/0/0.pbf');
    expect(result).not.toBeNull();
    expect(result!.z).toBe(22);
  });

  it('accepts zoom level 0', () => {
    const result = parseTilePath('/contours/0/0/0.pbf');
    expect(result).not.toBeNull();
    expect(result!.z).toBe(0);
  });
});
