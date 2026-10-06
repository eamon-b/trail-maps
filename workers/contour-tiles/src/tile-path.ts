/**
 * Tile-path parsing for the contour worker, kept free of runtime dependencies
 * (no pmtiles, no Workers globals) so the root test suite can import the real
 * function rather than a copy of it.
 */

/** Highest zoom any contour source is served at. */
export const MAX_ZOOM = 22;

/** A decimal digit string with no leading zeros ("0" itself is canonical). */
function isCanonicalInt(digits: string): boolean {
  return String(Number(digits)) === digits;
}

/**
 * Parse tile coordinates from URL path.
 * Expected: /{source}/{z}/{x}/{y}.pbf
 *
 * Returns null (→ 404) for anything out of range. x/y must be validated here:
 * PMTiles.getZxy() throws for x or y >= 2**z, which would otherwise surface as
 * an opaque 500 for what is really a malformed request.
 */
export function parseTilePath(
  pathname: string
): { source: string; z: number; x: number; y: number } | null {
  const match = pathname.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!match) return null;

  // Reject absurdly long digit runs before parseInt turns them into Infinity-ish
  // values; the largest legal coordinate at MAX_ZOOM=22 is 7 digits.
  if (match[2].length > 2 || match[3].length > 10 || match[4].length > 10) {
    return null;
  }

  // Canonical integers only: `/12/0003750/02520.pbf` names the same tile as
  // `/12/3750/2520.pbf` but is a different URL, so it would get its own edge
  // cache entry — a free way to multiply cache misses (and R2 reads) for one
  // tile. One tile, one URL.
  if (!isCanonicalInt(match[2]) || !isCanonicalInt(match[3]) || !isCanonicalInt(match[4])) {
    return null;
  }

  const z = parseInt(match[2], 10);
  if (!Number.isInteger(z) || z > MAX_ZOOM) return null;

  const x = parseInt(match[3], 10);
  const y = parseInt(match[4], 10);
  // z <= 22, so 2**z is exact in Number range.
  const limit = 2 ** z;
  if (x >= limit || y >= limit) return null;

  return { source: match[1], z, x, y };
}
