/**
 * Cloudflare Worker for serving contour vector tiles from PMTiles on R2.
 *
 * URL pattern: /{source}/{z}/{x}/{y}.pbf
 * Example:     /contours/12/3750/2520.pbf
 *
 * The PMTiles file is stored in R2 at: contours/australia.pmtiles
 */

import {
  EtagMismatch,
  PMTiles,
  RangeResponse,
  ResolvedValueCache,
  Source,
} from 'pmtiles';

interface Env {
  TILES_BUCKET: R2Bucket;
  ALLOWED_ORIGIN?: string; // e.g. 'https://trailmaps.example.com' — defaults to '*' for dev
}

const MAX_ZOOM = 22;

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  };
}

const PMTILES_KEY = 'contours/australia.pmtiles';

/**
 * R2-backed source for the pmtiles library.
 * Reads byte ranges from the R2 object.
 */
class R2Source implements Source {
  private bucket: R2Bucket;
  private key: string;

  constructor(bucket: R2Bucket, key: string) {
    this.bucket = bucket;
    this.key = key;
  }

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    expectedEtag?: string
  ): Promise<RangeResponse> {
    if (signal?.aborted) {
      throw new Error('Tile range request was aborted');
    }

    const obj = await this.bucket.get(this.key, {
      range: { offset, length },
    });

    if (!obj) {
      throw new Error(`R2 object not found: ${this.key}`);
    }

    if (expectedEtag && obj.etag !== expectedEtag) {
      throw new EtagMismatch(
        `R2 object changed while reading ${this.key}: expected ${expectedEtag}, got ${obj.etag}`
      );
    }

    const data = await obj.arrayBuffer();
    if (data.byteLength !== length) {
      throw new Error(
        `Incomplete R2 range for ${this.key}: requested ${length} bytes at ${offset}, received ${data.byteLength}`
      );
    }

    return {
      data: data,
      etag: obj.etag,
      cacheControl: obj.httpMetadata?.cacheControl,
      expires: obj.httpMetadata?.cacheExpiry?.toISOString(),
    };
  }
}

// Cache PMTiles instances per isolate lifetime
let pmtilesInstance: PMTiles | null = null;

function getPMTiles(bucket: R2Bucket): PMTiles {
  if (!pmtilesInstance) {
    const source = new R2Source(bucket, PMTILES_KEY);
    // Cloudflare Workers cannot reuse pending I/O promises across requests.
    // ResolvedValueCache stores only completed values and is the cache PMTiles
    // provides specifically for runtimes with that restriction.
    pmtilesInstance = new PMTiles(source, new ResolvedValueCache());
  }
  return pmtilesInstance;
}

async function healthResponse(request: Request, env: Env): Promise<Response> {
  const headers = {
    ...corsHeaders(env),
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  try {
    const object = await env.TILES_BUCKET.head(PMTILES_KEY);
    if (!object) {
      return new Response(
        request.method === 'HEAD' ? null : JSON.stringify({ ok: false, error: 'Contour archive not found' }),
        { status: 503, headers }
      );
    }

    const header = await getPMTiles(env.TILES_BUCKET).getHeader();
    const body = {
      ok: true,
      archive: {
        key: PMTILES_KEY,
        size: object.size,
        etag: object.etag,
      },
      tiles: {
        minZoom: header.minZoom,
        maxZoom: header.maxZoom,
        minLon: header.minLon,
        minLat: header.minLat,
        maxLon: header.maxLon,
        maxLat: header.maxLat,
      },
    };

    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      status: 200,
      headers,
    });
  } catch (error) {
    pmtilesInstance = null;
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Contour health check failed: ${message}`);
    return new Response(
      request.method === 'HEAD' ? null : JSON.stringify({ ok: false, error: message }),
      { status: 503, headers }
    );
  }
}

/**
 * Parse tile coordinates from URL path.
 * Expected: /{source}/{z}/{x}/{y}.pbf
 *
 * Returns null (→ 404) for anything out of range. x/y must be validated here:
 * PMTiles.getZxy() throws for x or y >= 2**z, which would otherwise surface as
 * an opaque 500 for what is really a malformed request.
 */
function parseTilePath(
  pathname: string
): { source: string; z: number; x: number; y: number } | null {
  const match = pathname.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!match) return null;

  // Reject absurdly long digit runs before parseInt turns them into Infinity-ish
  // values; the largest legal coordinate at MAX_ZOOM=22 is 7 digits.
  if (match[2].length > 2 || match[3].length > 10 || match[4].length > 10) {
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

/**
 * True when an error means the cached PMTiles directory/header no longer
 * matches the R2 object (i.e. australia.pmtiles was re-uploaded).
 *
 * pmtiles v4 exports `EtagMismatch`, so `instanceof` is the primary signal.
 * The message fallback only guards against a duplicated pmtiles copy in the
 * bundle producing a structurally identical error that fails `instanceof`.
 */
function isEtagMismatch(error: unknown): boolean {
  if (error instanceof EtagMismatch) return true;
  return (
    error instanceof Error &&
    (error.constructor?.name === 'EtagMismatch' || /etag/i.test(error.message))
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return healthResponse(request, env);
    }

    const tile = parseTilePath(url.pathname);

    if (!tile) {
      return new Response('Not found. Use: /{source}/{z}/{x}/{y}.pbf', {
        status: 404,
        headers: corsHeaders(env),
      });
    }

    if (tile.source !== 'contours') {
      return new Response(`Unknown source: ${tile.source}`, {
        status: 404,
        headers: corsHeaders(env),
      });
    }

    // Empty results are stable for the lifetime of an archive build, so let
    // clients and the edge cache them like populated tiles instead of
    // re-asking on every pan.
    const emptyTileHeaders = (): Record<string, string> => ({
      ...corsHeaders(env),
      'Cache-Control': 'public, max-age=86400',
    });

    const serveTile = async (): Promise<Response> => {
      const pmtiles = getPMTiles(env.TILES_BUCKET);

      // Check metadata for zoom range
      const header = await pmtiles.getHeader();
      if (tile.z < header.minZoom || tile.z > header.maxZoom) {
        return new Response(null, { status: 204, headers: emptyTileHeaders() });
      }

      const tileData = await pmtiles.getZxy(tile.z, tile.x, tile.y);

      if (!tileData || !tileData.data || tileData.data.byteLength === 0) {
        // Empty tile (ocean, no data for this area)
        return new Response(null, { status: 204, headers: emptyTileHeaders() });
      }

      const responseHeaders: Record<string, string> = {
        ...corsHeaders(env),
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'public, max-age=86400',
      };

      // PMTiles.getZxy() has already decompressed the tile payload, so do not
      // attach the archive's Content-Encoding to these response bytes.
      return new Response(request.method === 'HEAD' ? null : tileData.data, {
        status: 200,
        headers: responseHeaders,
      });
    };

    try {
      try {
        return await serveTile();
      } catch (firstError) {
        // Re-uploading australia.pmtiles changes the R2 etag, and a PMTiles
        // instance cached from before the upload fails etag validation on its
        // next range read. Drop the cached instance and retry once so warm
        // isolates recover immediately instead of 500ing until recycled.
        //
        // Only etag mismatches justify this. The cached instance holds the warm
        // directory cache shared by every concurrent request in the isolate, so
        // evicting it on transient R2 blips or programming errors would turn one
        // failure into a thundering herd of cold directory re-reads.
        if (!isEtagMismatch(firstError)) throw firstError;

        pmtilesInstance = null;
        console.warn(
          `Tile ${tile.z}/${tile.x}/${tile.y}: retrying with fresh PMTiles instance after etag mismatch: ` +
          (firstError instanceof Error ? firstError.message : String(firstError))
        );
        return await serveTile();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Tile error ${tile.z}/${tile.x}/${tile.y}: ${message}`);
      return new Response('Internal server error', {
        status: 500,
        headers: corsHeaders(env),
      });
    }
  },
};
