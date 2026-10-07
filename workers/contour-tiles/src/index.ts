/**
 * Cloudflare Worker for serving contour vector tiles from PMTiles on R2.
 *
 * URL pattern: /{source}/{z}/{x}/{y}.pbf
 * Example:     /contours/12/3750/2520.pbf
 *
 * Each source name maps to one PMTiles archive in R2 (see SOURCES).
 */

import {
  EtagMismatch,
  PMTiles,
  RangeResponse,
  ResolvedValueCache,
  Source,
} from 'pmtiles';
import { parseTilePath } from './tile-path';
import { smoothContourTile, type SmoothingOptions } from './contour-smoothing';

interface Env {
  TILES_BUCKET: R2Bucket;
  ALLOWED_ORIGIN?: string; // e.g. 'https://trailmaps.example.com' — defaults to '*' for dev
  /** 'off' serves the archives' geometry untouched (see SMOOTHING). */
  CONTOUR_SMOOTHING?: string;
}

/** How long a browser may reuse a CORS preflight result. */
const PREFLIGHT_MAX_AGE = 86400;

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  };
}

/** Append a field to Vary without duplicating one that is already listed. */
function addVary(headers: Headers, field: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', field);
    return;
  }
  const alreadyListed = existing
    .split(',')
    .some((value) => value.trim().toLowerCase() === field.toLowerCase());
  if (!alreadyListed) headers.set('Vary', `${existing}, ${field}`);
}

/**
 * Attach CORS headers to a response at the very last moment, immediately
 * before it leaves the Worker.
 *
 * This ordering is load-bearing now that tile responses are stored in
 * `caches.default`. That cache is keyed by URL alone, so an entry stored *with*
 * an Access-Control-Allow-Origin header would be replayed verbatim to every
 * later requester of the same URL. Keeping CORS out of the stored entry means:
 *   - the cached bytes are origin-agnostic, so no origin can ever be served
 *     another origin's ACAO out of the shared edge cache;
 *   - changing the ALLOWED_ORIGIN var takes effect immediately instead of
 *     after the cached entries expire.
 * `Vary: Origin` is still emitted (when ALLOWED_ORIGIN is configured) so that
 * downstream shared caches — browsers, proxies, any future CDN in front of
 * this Worker — know the response is origin-dependent and do not make the same
 * mistake.
 *
 * Also strips the body for HEAD, so upstream code can build one full-bodied
 * response and let this decide what actually goes on the wire.
 */
function finalize(
  response: Response,
  env: Env,
  request: Request,
  edgeCacheStatus?: 'HIT' | 'MISS'
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(env))) {
    headers.set(name, value);
  }
  if (env.ALLOWED_ORIGIN) addVary(headers, 'Origin');
  if (edgeCacheStatus) headers.set('X-Edge-Cache', edgeCacheStatus);

  const bodyless = request.method === 'HEAD' || response.status === 204;
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Served tilesets, keyed by the `{source}` path segment. Adding a tileset is
 * one entry here plus uploading the archive to R2 — nothing else in this file
 * is per-source.
 */
const SOURCES: Record<string, string> = {
  contours: 'contours/australia.pmtiles',
  world: 'contours/world.pmtiles',
};

/**
 * Serve-time line smoothing per source (see contour-smoothing.ts), applied up
 * to `maxZoom` and never at the archive's own maxzoom: those tiles keep full
 * vertex detail already — they are what clients overzoom.
 *
 * Tuned per archive in 2026-10 on live tiles: measured at Mt Sonder, Mt
 * Feathertop, Aoraki and the Colorado Front Range, and rendered in MapLibre
 * (Mt Sonder against full-detail z15 tiles, the Front Range from `world`):
 *
 * - `contours` (australia.pmtiles) is coarse below z15 — median segment ~25 px
 *   at z14, with ~40% of corners sharper than 45° at z13 — so it is smoothed
 *   through z14 with three passes. Re-simplifying at tolerance 2 keeps the
 *   growth to 1.3-2x compressed bytes; ~5-110 ms CPU per tile.
 * - `world` (--simplification=2) already draws smooth from z12, so smoothing
 *   there bought nothing visible for ~1.2x bytes. At z10-z11 it removes the
 *   remaining kinks for ~1.15x bytes. Two passes at tolerance 1: tolerance 2
 *   let close contours touch far more often (its segments are short), and
 *   tolerance 0 nearly doubled tiles that already run to 800 KB at z10.
 *   Up to ~140 ms CPU on the densest z10 tiles.
 *
 * A source with no entry is served as stored.
 */
const SMOOTHING: Record<string, { options: SmoothingOptions; maxZoom: number }> = {
  contours: { options: { iterations: 3, tolerance: 2 }, maxZoom: 14 },
  world: { options: { iterations: 2, tolerance: 1 }, maxZoom: 11 },
};

/**
 * Names the geometry in the edge cache key, so tiles cached before a change to
 * SMOOTHING or the algorithm are never served after it. Bump on any such change.
 */
const SMOOTHING_VERSION = 'chaikin-1';

function smoothingEnabled(env: Env): boolean {
  return env.CONTOUR_SMOOTHING !== 'off';
}

/** The source whose health decides the top-level `ok` of /health. */
const DEFAULT_SOURCE = 'contours';

function isKnownSource(source: string): boolean {
  return Object.hasOwn(SOURCES, source);
}

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

// Cache PMTiles instances per source, per isolate lifetime
const pmtilesInstances = new Map<string, PMTiles>();

function getPMTiles(bucket: R2Bucket, source: string): PMTiles {
  let instance = pmtilesInstances.get(source);
  if (!instance) {
    const r2Source = new R2Source(bucket, SOURCES[source]);
    // Cloudflare Workers cannot reuse pending I/O promises across requests.
    // ResolvedValueCache stores only completed values and is the cache PMTiles
    // provides specifically for runtimes with that restriction.
    instance = new PMTiles(r2Source, new ResolvedValueCache());
    pmtilesInstances.set(source, instance);
  }
  return instance;
}

interface SourceHealth {
  ok: boolean;
  error?: string;
  archive?: { key: string; size: number; etag: string };
  tiles?: {
    minZoom: number;
    maxZoom: number;
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
}

/** Probe one source's archive. Never throws. */
async function sourceHealth(env: Env, source: string): Promise<SourceHealth> {
  const key = SOURCES[source];
  try {
    const object = await env.TILES_BUCKET.head(key);
    if (!object) {
      return { ok: false, error: 'Contour archive not found' };
    }

    const header = await getPMTiles(env.TILES_BUCKET, source).getHeader();
    return {
      ok: true,
      archive: {
        key,
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
  } catch (error) {
    pmtilesInstances.delete(source);
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Contour health check failed for ${source}: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Health check. Never edge-cached (Cache-Control: no-store) — it exists to
 * report the *current* state of the R2 archives.
 *
 * The top-level shape still describes DEFAULT_SOURCE exactly as it always did,
 * so existing consumers keep working; `sources` adds the per-source breakdown.
 * A source whose archive is not uploaded yet reports ok:false under `sources`
 * without failing the overall check.
 *
 * Returns a CORS-free response; the caller runs it through finalize().
 */
async function healthResponse(env: Env): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const names = Object.keys(SOURCES);
  const results = await Promise.all(names.map((name) => sourceHealth(env, name)));
  const sources: Record<string, SourceHealth> = {};
  names.forEach((name, i) => {
    sources[name] = results[i];
  });

  const primary = sources[DEFAULT_SOURCE];
  const body = { ...primary, sources };

  return new Response(JSON.stringify(body), {
    status: primary.ok ? 200 : 503,
    headers,
  });
}

/**
 * True when an error means the cached PMTiles directory/header no longer
 * matches the R2 object (i.e. the archive was re-uploaded).
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight. Max-Age lets the browser skip the preflight for
    // subsequent tile requests in the same origin/method/header combination.
    if (request.method === 'OPTIONS') {
      return finalize(
        new Response(null, {
          status: 204,
          headers: { 'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE) },
        }),
        env,
        request
      );
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return finalize(new Response('Method not allowed', { status: 405 }), env, request);
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return finalize(await healthResponse(env), env, request);
    }

    const tile = parseTilePath(url.pathname);

    if (!tile) {
      return finalize(
        new Response('Not found. Use: /{source}/{z}/{x}/{y}.pbf', { status: 404 }),
        env,
        request
      );
    }

    if (!isKnownSource(tile.source)) {
      return finalize(new Response(`Unknown source: ${tile.source}`, { status: 404 }), env, request);
    }

    // --- Edge cache -------------------------------------------------------
    //
    // NOTE: `caches.default` is a NO-OP on *.workers.dev — that cache lives at
    // the zone level and workers.dev is a shared zone, so put/match silently do
    // nothing there. This Worker answers on both hostnames, so the code below is
    // live on tiles.contour-map-tiles.net and inert on the workers.dev one.
    // Measure cache behaviour on the custom domain only.
    //
    // Staleness tradeoff: tiles are immutable for the lifetime of an archive
    // build, but australia.pmtiles can be re-uploaded. The R2 side of that is
    // handled by the EtagMismatch retry below; the edge side is not. After a
    // re-upload, edge entries can serve pre-upload tiles for up to their
    // max-age (86400s / 24h). That is the accepted tradeoff — contour geometry
    // changes rarely and never urgently, so we deliberately do not build purge
    // machinery. To force a flush, bump the archive key/URL path or purge the
    // zone cache manually.
    const cache = caches.default;

    // Cache keyed by URL only — the full pathname, which already includes the
    // `{source}` segment, so serving multiple sources needs no cache changes.
    // Normalize away the query string: the response depends solely on the path,
    // so leaving the query in would let `?cachebust=N` mint unbounded distinct
    // entries for byte-identical bytes.
    // Always a GET key — cache.put() rejects non-GET requests, and this lets a
    // HEAD be served from (and populate) the same entry a GET uses.
    // The one query parameter is ours: it names the geometry (smoothed with
    // SMOOTHING_VERSION, or raw), so neither kind is ever served for the other.
    const geometry = smoothingEnabled(env) ? SMOOTHING_VERSION : 'raw';
    const cacheKey = new Request(`${url.origin}${url.pathname}?geometry=${geometry}`, {
      method: 'GET',
    });

    const cached = await cache.match(cacheKey);
    if (cached) {
      // finalize() attaches CORS and drops the body for HEAD.
      return finalize(cached, env, request, 'HIT');
    }

    // Empty results are stable for the lifetime of an archive build, so let
    // clients cache them like populated tiles instead of re-asking on every pan.
    const emptyTileHeaders = (): Record<string, string> => ({
      'Cache-Control': 'public, max-age=86400',
    });

    // Builds the full-bodied, CORS-free response. Full-bodied even for HEAD, so
    // a HEAD miss stores a usable entry rather than poisoning the cache with an
    // empty body; finalize() strips the body on the way out.
    const serveTile = async (): Promise<Response> => {
      const pmtiles = getPMTiles(env.TILES_BUCKET, tile.source);

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
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'public, max-age=86400',
      };

      let body: ArrayBuffer | Uint8Array = tileData.data;
      const smoothing = SMOOTHING[tile.source];
      if (
        smoothing &&
        smoothingEnabled(env) &&
        tile.z <= smoothing.maxZoom &&
        tile.z < header.maxZoom
      ) {
        try {
          body = smoothContourTile(new Uint8Array(tileData.data), smoothing.options);
          responseHeaders['X-Contour-Smoothing'] = SMOOTHING_VERSION;
        } catch (error) {
          // A tile the rewriter cannot parse is still a tile: serve it as stored.
          console.error(
            `Smoothing failed for ${tile.source}/${tile.z}/${tile.x}/${tile.y}, serving it unsmoothed: ` +
              (error instanceof Error ? error.message : String(error))
          );
        }
      }

      // PMTiles.getZxy() has already decompressed the tile payload, so do not
      // attach the archive's Content-Encoding to these response bytes.
      return new Response(body, {
        status: 200,
        headers: responseHeaders,
      });
    };

    /**
     * Store a tile response at the edge, then hand it back for the wire.
     *
     * Only 200s are stored. 204 is deliberately skipped: it is not one of
     * Cloudflare's cacheable status codes (200/206/301/302/303/404/410 — "all
     * other status codes are not cached by default"), so a put() of a 204 is
     * not reliably retrievable, and faking one as a 200-with-sentinel just to
     * reconstruct it on read is more machinery than the win justifies. Empty
     * tiles still carry `Cache-Control: public, max-age=86400`, so browsers and
     * any downstream cache absorb the repeat traffic; on the Worker side an
     * empty tile is a directory lookup that the in-isolate ResolvedValueCache
     * usually answers with no R2 read at all.
     */
    const cacheAndFinalize = (response: Response): Response => {
      if (response.status === 200) {
        ctx.waitUntil(
          cache
            .put(cacheKey, response.clone())
            .catch((error: unknown) =>
              console.error(
                `Edge cache put failed for ${url.pathname}: ` +
                  (error instanceof Error ? error.message : String(error))
              )
            )
        );
      }
      return finalize(response, env, request, 'MISS');
    };

    try {
      try {
        return cacheAndFinalize(await serveTile());
      } catch (firstError) {
        // Re-uploading an archive changes the R2 etag, and a PMTiles instance
        // cached from before the upload fails etag validation on its next range
        // read. Drop that source's cached instance and retry once so warm
        // isolates recover immediately instead of 500ing until recycled.
        //
        // Only etag mismatches justify this. The cached instance holds the warm
        // directory cache shared by every concurrent request in the isolate, so
        // evicting it on transient R2 blips or programming errors would turn one
        // failure into a thundering herd of cold directory re-reads.
        if (!isEtagMismatch(firstError)) throw firstError;

        pmtilesInstances.delete(tile.source);
        console.warn(
          `Tile ${tile.source}/${tile.z}/${tile.x}/${tile.y}: retrying with fresh PMTiles instance after etag mismatch: ` +
          (firstError instanceof Error ? firstError.message : String(firstError))
        );
        return cacheAndFinalize(await serveTile());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Tile error ${tile.source}/${tile.z}/${tile.x}/${tile.y}: ${message}`);
      // Errors are never edge-cached — a transient R2 failure must not pin a
      // 500 to this tile URL for the next 24 hours.
      return finalize(new Response('Internal server error', { status: 500 }), env, request);
    }
  },
};
