/**
 * In-browser OpenStreetMap POI enrichment for user-imported trails.
 *
 * Bundled trails get their `pois` array at build time from
 * `scripts/fetch-pois.ts`. An imported trail exists nowhere but this browser's
 * IndexedDB, so there is no build step to hang that off — the browser has to
 * ask Overpass itself. This module is the browser half of that script: the same
 * `gpx-tools` corridor query, the same 2 km radius, and the same
 * `@lib/trail-pois` km-scale mapping, so a POI lands on the same trail km
 * whichever path found it.
 *
 * Requests go straight from the page to a public Overpass instance
 * (`overpass-api.de` allows CORS), so nothing about the user's trail is sent to
 * a server of ours. Two consequences worth knowing:
 *
 * - The browser will not let us set a `User-Agent`, which Overpass etiquette
 *   asks for. `createOverpassFetcher` sets one anyway and the browser drops it;
 *   the request still carries the browser's own UA, so the instance can still
 *   identify traffic. Requests are serialised and spaced by `MIN_DELAY_MS` all
 *   the same, because the per-IP slot limit is the part that actually matters.
 * - A public instance is sometimes unreachable from a given network (DNS
 *   blackholes and corporate resolvers both do this to `overpass-api.de`). When
 *   *every* corridor query fails, the next endpoint in
 *   {@link DEFAULT_OVERPASS_ENDPOINTS} is tried before giving up. An explicit
 *   `endpoint` option disables that fallback — it means "use this one".
 */

import { POI_TYPES, type POIType } from 'gpx-tools/lib/osm-poi';
import { createOverpassFetcher, type POIFetcher } from 'gpx-tools/lib/overpass-client';
import {
  enrichRoute,
  type ChunkFailure,
  type EnrichmentProgress,
} from 'gpx-tools/lib/poi-enrichment';

import { buildRouteScale, toTrailPOIs } from '@lib/trail-pois';
import type { ProcessedTrail, TrailPOI } from '@lib/trail-types';

export type { ChunkFailure, EnrichmentProgress };

/**
 * Public Overpass instances, tried in order.
 *
 * The main instance is first because it is the one the project's build scripts
 * use and the one whose load Overpass sizes for. The mirror exists only as a
 * fallback for networks that cannot reach it at all.
 */
export const DEFAULT_OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** POIs within this distance of the trail are kept. Matches `scripts/fetch-pois.ts`. */
export const SEARCH_RADIUS_KM = 2;

/** Overpass etiquette: a slow trickle from one client, never parallel queries. */
const MIN_DELAY_MS = 2000;

/** Corridor vertices per Overpass query; must stay under `CORRIDOR_LIMITS.maxVertices`. */
const MAX_VERTICES_PER_CHUNK = 300;

const ALL_POI_TYPES: POIType[] = [...POI_TYPES];

export interface EnrichImportedTrailOptions {
  /** Cancellation. The returned promise rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Progress for the UI: stage, `current`/`total` within the stage, and a message. */
  onProgress?: (progress: EnrichmentProgress) => void;
  /**
   * Use exactly this Overpass instance and do not fall back to another.
   * Handy for a dev override; unset in normal use.
   */
  endpoint?: string;
  /**
   * How a fetcher is made for an endpoint. Injected by tests; the default
   * queries Overpass directly.
   */
  createFetcher?: (endpoint: string) => POIFetcher;
}

export interface ImportedTrailPOIResult {
  /** POIs on the trail's own km scale, sorted by `distanceAlongTrail`. */
  pois: TrailPOI[];
  /** Corridor chunks Overpass refused. A non-empty list means partial coverage. */
  failedChunks: ChunkFailure[];
  /** How many Overpass queries the corridor was split into. */
  queryChunks: number;
  /** The instance the results actually came from. */
  endpoint: string;
}

function defaultFetcher(endpoint: string): POIFetcher {
  return createOverpassFetcher({ endpoint, minDelayMs: MIN_DELAY_MS });
}

/** True for the library's own cancellation error, which must not trigger a retry. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Fetch the OpenStreetMap POIs along an imported trail.
 *
 * The route handed to the library is the main track plus every alternate and
 * side trip (see `buildRouteScale`), so a POI beside a variant is found and
 * measured from that variant's junction km rather than from the main line.
 *
 * A trail with no usable track points returns an empty result without making
 * any request. Individual corridor queries that fail are reported in
 * `failedChunks` and the rest of the results are kept — partial POIs are far
 * more useful than none. Only an every-query failure (on every endpoint)
 * throws.
 */
export async function enrichImportedTrail(
  trail: Pick<ProcessedTrail, 'track' | 'alternates' | 'sideTrips'>,
  options: EnrichImportedTrailOptions = {}
): Promise<ImportedTrailPOIResult> {
  const { signal, onProgress } = options;
  const makeFetcher = options.createFetcher ?? defaultFetcher;
  const endpoints = options.endpoint ? [options.endpoint] : [...DEFAULT_OVERPASS_ENDPOINTS];

  const scale = buildRouteScale(trail);
  if (scale.polylines.length === 0) {
    onProgress?.({
      stage: 'done',
      message: 'This trail has no track points to search along.',
    });
    return {
      pois: [],
      failedChunks: [],
      queryChunks: 0,
      endpoint: endpoints[0],
    };
  }

  let lastError: unknown = new Error('No Overpass endpoint was tried');

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    if (i > 0) {
      onProgress?.({
        stage: 'prepare',
        message: 'That OpenStreetMap server did not answer — trying a backup…',
      });
    }

    try {
      const result = await enrichRoute(
        scale.polylines,
        {
          types: ALL_POI_TYPES,
          searchRadiusKm: SEARCH_RADIUS_KM,
          maxVerticesPerChunk: MAX_VERTICES_PER_CHUNK,
          fetchPOIs: makeFetcher(endpoint),
          signal,
        },
        onProgress
      );

      return {
        pois: toTrailPOIs(result.pois, scale),
        failedChunks: result.failedChunks,
        queryChunks: result.stats.queryChunks,
        endpoint,
      };
    } catch (error) {
      // The user pressing Cancel is not an endpoint problem: stop immediately
      // rather than replaying the whole route against the next instance.
      if (isAbort(error) || signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
