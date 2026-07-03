/**
 * Cloudflare Worker for serving contour vector tiles from PMTiles on R2.
 *
 * URL pattern: /{source}/{z}/{x}/{y}.pbf
 * Example:     /contours/12/3750/2520.pbf
 *
 * The PMTiles file is stored in R2 at: contours/australia.pmtiles
 */

import { Compression, PMTiles, RangeResponse, Source } from 'pmtiles';

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
    length: number
  ): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, {
      range: { offset, length },
    });

    if (!obj) {
      throw new Error(`R2 object not found: ${this.key}`);
    }

    const data = await obj.arrayBuffer();
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
    pmtilesInstance = new PMTiles(source);
  }
  return pmtilesInstance;
}

/**
 * Parse tile coordinates from URL path.
 * Expected: /{source}/{z}/{x}/{y}.pbf
 */
function parseTilePath(
  pathname: string
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

    const serveTile = async (): Promise<Response> => {
      const pmtiles = getPMTiles(env.TILES_BUCKET);

      // Check metadata for zoom range
      const header = await pmtiles.getHeader();
      if (tile.z < header.minZoom || tile.z > header.maxZoom) {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }

      const tileData = await pmtiles.getZxy(tile.z, tile.x, tile.y);

      if (!tileData || !tileData.data || tileData.data.byteLength === 0) {
        // Empty tile (ocean, no data for this area)
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }

      const responseHeaders: Record<string, string> = {
        ...corsHeaders(env),
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'public, max-age=86400',
      };

      // Tell the client the tile is gzip-compressed if PMTiles says so
      if (header.tileCompression === Compression.Gzip) {
        responseHeaders['Content-Encoding'] = 'gzip';
      }

      return new Response(tileData.data, {
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
        pmtilesInstance = null;
        console.warn(
          `Tile ${tile.z}/${tile.x}/${tile.y}: retrying with fresh PMTiles instance after: ` +
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
