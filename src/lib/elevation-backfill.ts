/**
 * Elevation backfill: give a GPX with no `<ele>` data a real profile by asking
 * a terrain API what the ground height is under each point.
 *
 * Why this exists: a track recorded without elevation (many phone apps, most
 * hand-drawn routes) produces a flat profile and — worse, because it is
 * silent — distance-only day estimates that read as optimistic. Naismith needs
 * ascent. The backfill turns "no data" into "DEM data", which is honest enough
 * to plan on, and marks the trail `elevationSource: 'backfilled'` so the UI can
 * say where the numbers came from.
 *
 * Shape of the request loop is lifted from `scripts/fetch-elevation.ts`: POST
 * batches of 100 locations to Open-Elevation, sleep between batches so the free
 * public instance stays friendly.
 *
 * **Sampling and interpolation.** A 20,000-point web track would be 200
 * requests and several minutes of waiting for detail no DEM actually resolves
 * (Open-Elevation serves ~30-90 m posts, while track points are often metres
 * apart). So at most {@link DEFAULT_MAX_SAMPLES} points are looked up, chosen
 * evenly along the track's *cumulative distance* — not evenly by index, which
 * would over-sample wherever the recorder was walking slowly and under-sample
 * the fast bits. Every other point's elevation is then linearly interpolated
 * between its two bracketing samples, again by cumulative distance. The result
 * is one elevation per input point, in input order.
 *
 * Platform-neutral: no Node, DOM or React Native imports. `fetch` is injected
 * (structurally typed as {@link ElevationFetch}) and falls back to the global
 * one, so the same code runs in the browser, in Hermes and under a Vitest mock.
 */

import { haversineDistance } from './distance';
import { recomputeTrailElevation } from './trail-ingest';
import type { ProcessedTrail } from './trail-types';

/** Public Open-Elevation instance. Free, unauthenticated, rate-limit-by-manners. */
export const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';

/** Locations per request. Open-Elevation recommends no more than this. */
export const DEFAULT_BATCH_SIZE = 100;

/** Pause between requests, so a long track doesn't hammer the free instance. */
export const DEFAULT_DELAY_MS = 500;

/**
 * Most points we will ever look up, however long the track is: 2,000 samples is
 * ~20 requests, and on a 1,000 km trail still puts a sample every 500 m — finer
 * than the DEM underneath it.
 */
export const DEFAULT_MAX_SAMPLES = 2000;

/**
 * Elevation cleaning applied after a backfill.
 *
 * DEM samples are not barometric noise, so spike removal rarely fires — it is
 * on as a guard against a single bad post (voids over water read as 0 or
 * -32768). The 3 m ascent threshold matters more: interpolating between DEM
 * posts produces long shallow ramps whose every-sample deltas would otherwise
 * accumulate into an ascent total that flatters the terrain.
 */
export const BACKFILL_ELEVATION_CLEANING = {
  removeSpikes: true,
  spikeThreshold: 50,
  smooth: true,
  smoothingWindow: 5,
  ascentThreshold: 3,
} as const;

/** Minimal structural `fetch`: what this module needs, and nothing more. */
export type ElevationFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export interface BackfillElevationOptions {
  /** Injected fetch (defaults to the global one). */
  fetch?: ElevationFetch;
  /** Locations per request (default {@link DEFAULT_BATCH_SIZE}). */
  batchSize?: number;
  /** Pause between requests in ms (default {@link DEFAULT_DELAY_MS}). */
  delayMs?: number;
  /** Lookup endpoint (default {@link OPEN_ELEVATION_URL}). */
  endpoint?: string;
  /** Cap on looked-up points (default {@link DEFAULT_MAX_SAMPLES}); 0 disables sampling. */
  maxSamples?: number;
  /** Called after every batch with (samples fetched, samples total). */
  onProgress?: (done: number, total: number) => void;
  /** Cancels between batches, and is passed through to `fetch`. */
  signal?: AbortSignal;
}

interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Look up ground elevation for every point of a track.
 *
 * @returns one elevation (metres) per input point, in input order.
 * @throws an `AbortError` when `signal` fires, or an `Error` describing the
 * HTTP failure / malformed response. Nothing is partially applied: the caller
 * either gets a complete elevation array or an exception.
 */
export async function backfillElevation(
  points: LatLon[],
  options: BackfillElevationOptions = {}
): Promise<number[]> {
  if (points.length === 0) return [];

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as ElevationFetch | undefined);
  if (!doFetch) throw new Error('No fetch implementation available for elevation lookup');

  const endpoint = options.endpoint ?? OPEN_ELEVATION_URL;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  const cumulative = cumulativeMeters(points);
  const sampleIndices = planElevationSamples(cumulative, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
  const total = sampleIndices.length;

  const sampled: number[] = [];
  for (let start = 0; start < total; start += batchSize) {
    throwIfAborted(options.signal);
    if (start > 0 && delayMs > 0) {
      await sleep(delayMs);
      throwIfAborted(options.signal);
    }

    const batch = sampleIndices.slice(start, start + batchSize).map(i => points[i]);
    const elevations = await fetchElevationBatch(doFetch, endpoint, batch, options.signal);
    sampled.push(...elevations);
    options.onProgress?.(sampled.length, total);
  }

  return interpolateBySampledDistance(cumulative, sampleIndices, sampled);
}

/**
 * How many HTTP requests {@link backfillElevation} will make for a track of
 * this size — the number the UI puts in front of the user before they commit to
 * waiting for it.
 */
export function estimateElevationRequests(
  pointCount: number,
  options: Pick<BackfillElevationOptions, 'batchSize' | 'maxSamples'> = {}
): number {
  if (pointCount <= 0) return 0;
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const samples = maxSamples > 0 ? Math.min(pointCount, maxSamples) : pointCount;
  return Math.ceil(samples / batchSize);
}

/**
 * Write looked-up elevations onto a built trail and re-derive everything that
 * depends on them (ascent/descent totals, display points, waypoint stats) via
 * {@link recomputeTrailElevation}, marking the trail `elevationSource:
 * 'backfilled'`.
 *
 * Only the main route's points are covered — see the note on
 * `recomputeTrailElevation` about alternates and side trips.
 *
 * Returns a new trail; the input is not mutated.
 *
 * @throws when `elevations` doesn't line up 1:1 with `trail.track.points`,
 * which would silently shift the whole profile along the track.
 */
export function applyElevation(trail: ProcessedTrail, elevations: number[]): ProcessedTrail {
  const points = trail.track.points;
  if (elevations.length !== points.length) {
    throw new Error(
      `Elevation backfill returned ${elevations.length} values for ${points.length} track points`
    );
  }

  const withElevation: ProcessedTrail = {
    ...trail,
    config: { ...trail.config, elevationSource: 'backfilled' },
    track: {
      ...trail.track,
      points: points.map((p, i) => ({
        ...p,
        // Decimetres are past what any DEM resolves; the extra digits would only
        // bloat the stored JSON.
        ele: Math.round((Number.isFinite(elevations[i]) ? elevations[i] : 0) * 10) / 10,
      })),
    },
  };

  return recomputeTrailElevation(withElevation, BACKFILL_ELEVATION_CLEANING);
}

/**
 * Does this track carry usable elevation data?
 *
 * "All zeroes" is what a GPX without `<ele>` becomes once ingested (`p.ele || 0`
 * throughout the pipeline), so an all-zero profile means missing, not sea
 * level. A single non-zero finite sample is enough to count as real data.
 */
export function trailHasElevation(points: { ele?: number | null }[]): boolean {
  return points.some(p => typeof p.ele === 'number' && Number.isFinite(p.ele) && p.ele !== 0);
}

/**
 * Whether a built trail's day estimates can account for climbing.
 *
 * Prefers the explicit `config.elevationSource` marker the importer writes, and
 * falls back to inspecting the track — bundled trails predate the marker, and
 * so do imports saved before this feature shipped.
 */
export function trailElevationIsUsable(trail: {
  /**
   * Deliberately `unknown` rather than `{ elevationSource?: … }`: the mobile
   * app's `TrailJson` types its config as an index signature, which TypeScript's
   * weak-type check refuses to match against an all-optional parameter. Widening
   * here (and narrowing once, below) lets every caller pass its own trail shape
   * without a cast at the call site.
   */
  config?: unknown;
  track: { points: { ele?: number | null }[] };
}): boolean {
  const marker = (trail.config as { elevationSource?: unknown } | undefined)?.elevationSource;
  if (marker === 'none') return false;
  if (marker === 'gpx' || marker === 'backfilled') return true;
  return trailHasElevation(trail.track.points);
}

// ---------------------------------------------------------------------------
// Sampling / interpolation
// ---------------------------------------------------------------------------

/** Cumulative along-track distance in metres, one entry per point. */
function cumulativeMeters(points: LatLon[]): number[] {
  const cumulative = new Array<number>(points.length);
  let running = 0;
  cumulative[0] = 0;
  for (let i = 1; i < points.length; i++) {
    running += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    cumulative[i] = running;
  }
  return cumulative;
}

/**
 * Choose which point indices to look up: every point when the track is small
 * enough, otherwise `maxSamples` indices spread evenly along the track's
 * length, always including the first and last point.
 *
 * Exported for testing.
 */
export function planElevationSamples(cumulative: number[], maxSamples: number): number[] {
  const n = cumulative.length;
  if (n === 0) return [];
  if (maxSamples <= 0 || n <= maxSamples) {
    return Array.from({ length: n }, (_, i) => i);
  }

  const totalMeters = cumulative[n - 1];
  const indices: number[] = [];
  let cursor = 0;
  for (let k = 0; k < maxSamples; k++) {
    const target = (totalMeters * k) / (maxSamples - 1);
    while (cursor < n - 1 && cumulative[cursor] < target) cursor++;
    if (indices[indices.length - 1] !== cursor) indices.push(cursor);
  }
  // A zero-length track (every point identical) collapses to one index; the
  // last point must still be sampled so interpolation has a right-hand anchor.
  if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
  return indices;
}

/**
 * Spread sampled elevations back over every point by linear interpolation in
 * cumulative-distance space. Points before the first / after the last sample
 * (there are none in practice — both ends are always sampled) clamp to it.
 *
 * Exported for testing.
 */
export function interpolateBySampledDistance(
  cumulative: number[],
  sampleIndices: number[],
  sampleElevations: number[]
): number[] {
  const n = cumulative.length;
  if (sampleIndices.length === 0) return new Array<number>(n).fill(0);

  const out = new Array<number>(n);
  let seg = 0; // index into sampleIndices of the left-hand anchor
  for (let i = 0; i < n; i++) {
    while (seg < sampleIndices.length - 2 && sampleIndices[seg + 1] < i) seg++;

    const leftIdx = sampleIndices[seg];
    const rightIdx = sampleIndices[Math.min(seg + 1, sampleIndices.length - 1)];
    const left = sampleElevations[seg] ?? 0;
    const right = sampleElevations[Math.min(seg + 1, sampleElevations.length - 1)] ?? left;

    if (i <= leftIdx) {
      out[i] = left;
    } else if (i >= rightIdx) {
      out[i] = right;
    } else {
      const span = cumulative[rightIdx] - cumulative[leftIdx];
      const t = span > 0 ? (cumulative[i] - cumulative[leftIdx]) / span : 0;
      out[i] = left + (right - left) * t;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function fetchElevationBatch(
  doFetch: ElevationFetch,
  endpoint: string,
  locations: LatLon[],
  signal?: AbortSignal
): Promise<number[]> {
  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: locations.map(loc => ({ latitude: loc.lat, longitude: loc.lon })),
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Elevation service error: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    );
  }

  const data = (await response.json()) as { results?: { elevation?: unknown }[] } | null;
  const results = data?.results;
  if (!Array.isArray(results) || results.length !== locations.length) {
    throw new Error(
      `Elevation service returned ${Array.isArray(results) ? results.length : 'no'} results for ${locations.length} points`
    );
  }

  return results.map(result => {
    const value = Number(result?.elevation);
    // Voids (ocean, DEM holes) come back null or as a sentinel; 0 is the same
    // "no data" the rest of the pipeline uses for a missing <ele>.
    return Number.isFinite(value) ? value : 0;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  // Hermes has no DOMException; matching the name is what callers check.
  const error = new Error('Elevation lookup was cancelled');
  error.name = 'AbortError';
  throw error;
}
