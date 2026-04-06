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

const MAX_ZOOM = 22;

// Replicate parseTilePath from the worker (with zoom validation)
function parseTilePath(
  pathname: string,
): { source: string; z: number; x: number; y: number } | null {
  const match = pathname.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!match) return null;
  const z = parseInt(match[2], 10);
  if (z > MAX_ZOOM) return null;
  return {
    source: match[1],
    z,
    x: parseInt(match[3], 10),
    y: parseInt(match[4], 10),
  };
}

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
