/**
 * Corridor packs: an offline map for an imported or community route, built on
 * the phone from the tiles along it.
 *
 * Bundled trails have packs built server-side (`scripts/build-tiles.ts`). A
 * route the hiker imported, or someone else's community route, has none, and
 * borrows a bundled one only when it lies inside that trail's coverage
 * (`offline-pack-resolver`). For every other route the phone assembles its own:
 * it fetches each z/x/y vector tile within the hiker's chosen distance of the
 * route (`corridor-tiles`) from the tile worker (`EXPO_PUBLIC_CONTOUR_TILE_URL`)
 * and writes them into the very same on-disk shape as a bundled pack —
 * `{documentDir}/tiles/{trailId}/base.mbtiles` + `contours.mbtiles` +
 * `manifest.json` — so `tileManager.getOfflineStyle`, validation, generation
 * names, status and storage accounting all treat it as any other pack.
 *
 * - **base** — the worker's `base` source (the Protomaps planet, the same schema
 *   the bundled `base.mbtiles` is extracted from), zooms 4–15;
 * - **contours** — the worker's `world` source (Copernicus GLO-30), the one
 *   the online map draws everywhere, zooms 9–15.
 *
 * Before any tile, the worker's `/health` must report both sources ok
 * (`checkTileServer`): a worker deployed before its archive was uploaded would
 * answer every tile with a 500, retried before it failed with a raw status.
 *
 * The worker answers 200 with an uncompressed tile, 204 for an empty one
 * (ocean, outside an archive's zooms — skipped), and is retried on network
 * errors and 5xx. It answers 404 only for a source it does not serve or a
 * malformed path, so a 404 fails the build at once: it means the worker in
 * front of the app is not the one this build expects (not yet deployed, or
 * rolled back), and counting it as an empty tile would pace through the whole
 * corridor to a misleading "check the connection", or record a pack with no
 * contours as if the route had none. Any hard failure aborts every other
 * request of the build. Tiles are stored gzipped, as tile-join stores them.
 *
 * **Throttle.** The zone in front of the worker blocks an IP that sends more
 * than 500 requests in 10 s (a 429 for the next 10 s), and every tile is a
 * Worker invocation. So request *starts* are paced to
 * {@link MAX_REQUESTS_PER_SECOND} across every build in the process, whatever
 * the concurrency, and a pack is capped at {@link MAX_CORRIDOR_TILES}. A 429
 * pauses every request — honouring `Retry-After`, else
 * {@link RATE_LIMIT_WAIT_MS} — and has its own generous per-tile budget
 * ({@link MAX_RATE_LIMIT_WAITS}) rather than spending the 5xx retries, so a
 * burst of them never fails the pack.
 *
 * Each file is written to `{name}.part`, validated by the same structural check
 * a downloaded pack passes (`validateMbtilesFile`), then promoted with
 * `promoteStagedTiles` — the commit step `downloadTrailTiles` uses. The
 * manifest records the corridor (`CorridorPackRecord`): its width, the route
 * fingerprint it was built from (a different one now means the route changed,
 * and the screen offers a rebuild), and whether it has contours at all — a
 * route whose corridor held no contour tile gets a base-only pack rather than
 * an empty contours.mbtiles that would fail validation.
 *
 * **Resume.** A cancelled or failed build keeps its `.part` files, stamped with
 * a key of route fingerprint + width + source. The next build of the same
 * corridor skips the tiles they already hold; any other corridor starts them
 * afresh. `corridor-progress.json` beside them records the same width and
 * fingerprint for the screen (`readCorridorProgress`), which defaults the width
 * to it and offers "Resume" only for that corridor. A cancel is honoured up to
 * the promotion itself. Deleting the pack deletes them with the directory.
 */

import { File } from 'expo-file-system';
import { gzipSync } from 'fflate';

import {
  BASE_MIN_ZOOM,
  CONTOUR_MIN_ZOOM,
  CORRIDOR_MAX_ZOOM,
  corridorFingerprint,
  corridorLines,
  corridorTileSet,
  countTiles,
  levelBounds,
  listTiles,
  type CorridorTileSet,
  type CorridorTrailInput,
  type TileXYZ,
} from './corridor-tiles';
import {
  CORRIDOR_KEY_METADATA,
  openMbtilesWriter,
  tileKey,
  type MbtilesWriter,
  type TileRow,
} from './mbtiles-writer';
import { tilesRoot, trailTilesDir, uriToPath, type TileFileName } from './tile-paths';
import {
  PART_SUFFIX,
  packFileNames,
  promoteStagedTiles,
  readStoredManifest,
  validateMbtilesFile,
  type CorridorPackRecord,
} from './tile-service';

/**
 * Most tiles (basemap + contours) one corridor pack may fetch. A technical cap,
 * not a judgement about the hike: every tile is a request to the tile Worker
 * (our request budget), and at the per-IP pace below 40,000 tiles is already
 * about 22 minutes of downloading. Roughly a 1,000 km route at 5 km either
 * side. A wider or longer corridor is refused with a plain message suggesting a
 * narrower one.
 */
export const MAX_CORRIDOR_TILES = 40_000;

/**
 * Most tile requests started per second, across every build in the process.
 * The zone's rate-limit rule blocks an IP above 500 requests per 10 s (50/s);
 * 30/s leaves room for the map and anything else on the same connection.
 */
export const MAX_REQUESTS_PER_SECOND = 30;

/** Wait after a 429 with no usable `Retry-After`: the rule's 10 s mitigation, plus one. */
export const RATE_LIMIT_WAIT_MS = 11_000;

/** 429s one tile may wait out before the build gives up (~5 minutes at 11 s). */
export const MAX_RATE_LIMIT_WAITS = 30;

/** Tiles in flight at once. */
const DEFAULT_CONCURRENCY = 12;
/** Tiles written per SQLite transaction. */
const WRITE_BATCH = 64;
/** Waits before each retry of a tile; one more attempt than entries. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/** Worker source names (`contours/worker`). */
export type CorridorSource = 'base' | 'world';

/** The worker source corridor packs take their contours from. */
export const CONTOUR_SOURCE: CorridorSource = 'world';

/** What a corridor of a given width around a route amounts to. */
export interface CorridorPlan {
  bufferKm: number;
  /** Route fingerprint — the pack's `sourceVersion`. */
  sourceVersion: string;
  /** Tiles at zooms 4–15 (basemap) and 9–15 (contours). */
  tileSet: CorridorTileSet;
  baseTiles: number;
  contourTiles: number;
  /** Tiles to fetch: basemap + contours. */
  totalTiles: number;
  /** Over {@link MAX_CORRIDOR_TILES}: the screen refuses it. */
  tooLarge: boolean;
  /** `[west, south, east, north]` of the deepest zoom's tiles; null when empty. */
  bounds: [number, number, number, number] | null;
}

/**
 * The fingerprint a pack built from this route now would record (see
 * `corridorFingerprint`). Null for a route with no points.
 */
export function corridorSourceVersion(trail: CorridorTrailInput | null | undefined): string | null {
  const lines = corridorLines(trail);
  return lines.length > 0 ? corridorFingerprint(lines) : null;
}

/** Plan a corridor `bufferKm` either side of a route. Null for a route with no points. */
export function planCorridor(
  trail: CorridorTrailInput | null | undefined,
  bufferKm: number,
): CorridorPlan | null {
  const lines = corridorLines(trail);
  if (lines.length === 0) return null;
  const tileSet = corridorTileSet(lines, bufferKm * 1000, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
  const baseTiles = countTiles(tileSet, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
  const contourTiles = countTiles(tileSet, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
  const totalTiles = baseTiles + contourTiles;
  const deepest = tileSet.levels.get(CORRIDOR_MAX_ZOOM);
  return {
    bufferKm,
    sourceVersion: corridorFingerprint(lines),
    tileSet,
    baseTiles,
    contourTiles,
    totalTiles,
    tooLarge: totalTiles > MAX_CORRIDOR_TILES,
    bounds: deepest ? levelBounds(deepest) : null,
  };
}

/** The corridor record of the pack on disk for this trail, or null. */
export function readCorridorRecord(trailId: string): CorridorPackRecord | null {
  return readStoredManifest(trailId)?.corridor ?? null;
}

/** True when an interrupted build left tiles to resume from. */
export function hasCorridorProgress(trailId: string): boolean {
  try {
    return new File(trailTilesDir(trailId), `base.mbtiles${PART_SUFFIX}`).exists;
  } catch {
    return false;
  }
}

/** The corridor an interrupted build was for: only that corridor resumes it. */
export interface CorridorProgressRecord {
  bufferKm: number;
  /** Route fingerprint the build started from. */
  sourceVersion: string;
}

/**
 * Beside the `.part` files: which corridor they hold. Their own metadata says
 * the same (the staging key), but reading it means opening SQLite, and the
 * screen needs it synchronously to default the width chips to it and to say
 * whether "Resume" really resumes.
 */
const PROGRESS_FILE = 'corridor-progress.json';

/**
 * The corridor an interrupted build was for, or null when there is none (or
 * its record is missing or unreadable — then the screen cannot promise a
 * resume, and does not).
 */
export function readCorridorProgress(trailId: string): CorridorProgressRecord | null {
  if (!hasCorridorProgress(trailId)) return null;
  try {
    const file = new File(trailTilesDir(trailId), PROGRESS_FILE);
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as Partial<CorridorProgressRecord>;
    return typeof parsed.bufferKm === 'number' && typeof parsed.sourceVersion === 'string'
      ? { bufferKm: parsed.bufferKm, sourceVersion: parsed.sourceVersion }
      : null;
  } catch {
    return null;
  }
}

function writeCorridorProgress(trailId: string, record: CorridorProgressRecord): void {
  new File(trailTilesDir(trailId), PROGRESS_FILE).writeSync(JSON.stringify(record));
}

function deleteCorridorProgress(trailId: string): void {
  try {
    const file = new File(trailTilesDir(trailId), PROGRESS_FILE);
    if (file.exists) file.delete();
  } catch {
    // Dead bytes at worst: readCorridorProgress ignores it without a .part.
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface CorridorProgress {
  tilesDone: number;
  tilesTotal: number;
  /** Compressed bytes written so far this run. */
  bytes: number;
}

export interface CorridorDownloadOptions {
  /** Tile worker base URL (`EXPO_PUBLIC_CONTOUR_TILE_URL`). */
  tileUrl: string;
  /** Corridor half-width the hiker chose, in km. */
  bufferKm: number;
  /** Display name, for the mbtiles `name` metadata. */
  name?: string;
  signal?: AbortSignal;
  onProgress?: (progress: CorridorProgress) => void;
  /** Tiles in flight at once (default 12). */
  concurrency?: number;
  /** Test seam: waits between retries. */
  retryDelaysMs?: readonly number[];
  /** Test seam: request starts per second (default {@link MAX_REQUESTS_PER_SECOND}). */
  requestsPerSecond?: number;
  /** Test seam: wait after a 429 without `Retry-After` (default {@link RATE_LIMIT_WAIT_MS}). */
  rateLimitWaitMs?: number;
  /** Test seam: the build time recorded. */
  now?: () => Date;
}

/** Thrown when the hiker cancels; the store shows no error for it. */
export class CorridorCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CorridorCancelledError';
  }
}

/**
 * The worker answered 404: it does not serve the source this build asks for
 * (not deployed yet, or rolled back). Retrying cannot help.
 */
export class TileSourceMissingError extends Error {
  constructor(url: string) {
    super(
      "The map server can't provide offline maps for this route yet. " +
        `Try again later. (HTTP 404 for ${url})`,
    );
    this.name = 'TileSourceMissingError';
  }
}

/**
 * The worker's `/health` says it cannot serve a source this build needs: the
 * worker predates it, or its archive is not in R2 yet.
 */
export class TileServerNotReadyError extends Error {
  constructor(detail: string) {
    super(
      "The map server can't provide offline maps for this route yet. " +
        `Try again later. (${detail})`,
    );
    this.name = 'TileServerNotReadyError';
  }
}

/** The plain refusal for a corridor over {@link MAX_CORRIDOR_TILES}. */
export function tooLargeMessage(totalTiles: number): string {
  return (
    `This corridor needs ${totalTiles.toLocaleString('en')} map tiles, more than the ` +
    `${MAX_CORRIDOR_TILES.toLocaleString('en')} one offline map can hold. ` +
    'Choose a narrower corridor.'
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CorridorCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CorridorCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Request pacing — shared by every build in the process, since the limit is per IP
// ---------------------------------------------------------------------------

/** Earliest time (ms since epoch) the next tile request may start. */
let nextRequestAt = 0;

/** Test seam — forget the pacing state. */
export function resetRequestPacing(): void {
  nextRequestAt = 0;
}

/** Wait for this request's slot: starts are at least 1/rate seconds apart. */
async function awaitRequestSlot(requestsPerSecond: number, signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + 1000 / Math.max(1, requestsPerSecond);
  if (at > now) await sleep(at - now, signal);
}

/** Hold every request (this build's and any other's) until `until`. */
function pauseRequestsUntil(until: number): void {
  nextRequestAt = Math.max(nextRequestAt, until);
}

/**
 * How long a 429 asks us to wait: `Retry-After` in seconds or as an HTTP date,
 * else the fallback.
 */
export function retryAfterMs(header: string | null | undefined, fallbackMs: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return fallbackMs;
}

/** True for a gzip stream (magic 1f 8b). */
function isGzipped(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/** How a tile request is paced and retried. */
interface FetchPolicy {
  retryDelaysMs: readonly number[];
  requestsPerSecond: number;
  rateLimitWaitMs: number;
}

/**
 * One tile's bytes, gzipped, or null for an empty tile. Retries network
 * failures and 5xx up to the policy's retries; waits out 429s on their own
 * budget; any other status is a hard failure.
 */
async function fetchTile(
  url: string,
  signal: AbortSignal,
  policy: FetchPolicy,
): Promise<Uint8Array | null> {
  let lastError = '';
  let attempt = 0;
  let rateLimited = 0;
  while (attempt <= policy.retryDelaysMs.length) {
    await awaitRequestSlot(policy.requestsPerSecond, signal);
    if (signal.aborted) throw new CorridorCancelledError();
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (signal.aborted) throw new CorridorCancelledError();
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(policy.retryDelaysMs[attempt] ?? 0, signal);
      attempt++;
      continue;
    }
    // 204 is the worker's empty tile (nothing there, or outside the archive's
    // zooms). A 404 is never that: the worker does not serve this source.
    if (response.status === 204) return null;
    if (response.status === 404) throw new TileSourceMissingError(url);
    if (response.status === 429) {
      // The IP is blocked for a while: pause every request, not just this one,
      // and do not spend this tile's ordinary retries on it.
      if (++rateLimited > MAX_RATE_LIMIT_WAITS) {
        throw new Error(`Couldn't fetch ${url} (rate limited ${rateLimited - 1} times)`);
      }
      const wait = retryAfterMs(response.headers?.get?.('Retry-After'), policy.rateLimitWaitMs);
      pauseRequestsUntil(Date.now() + wait);
      lastError = 'HTTP 429';
      continue;
    }
    if (response.status >= 500) {
      lastError = `HTTP ${response.status}`;
      await sleep(policy.retryDelaysMs[attempt] ?? 0, signal);
      attempt++;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (signal.aborted) throw new CorridorCancelledError();
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(policy.retryDelaysMs[attempt] ?? 0, signal);
      attempt++;
      continue;
    }
    if (data.length === 0) return null;
    return isGzipped(data) ? data : gzipSync(data);
  }
  throw new Error(`Couldn't fetch ${url} (${lastError})`);
}

/** The worker sources a corridor build reads. */
const REQUIRED_SOURCES: readonly CorridorSource[] = ['base', CONTOUR_SOURCE];

/**
 * Ask the worker's `/health` whether it serves every source the build needs,
 * before a single tile request. A worker deployed before its archive was
 * uploaded answers each tile with a 500, which the build would only give up on
 * after retrying the first tiles; one that predates the source answers 404.
 * `/health` names both plainly, and answers 503 (with the same body) when its
 * default source is down, so the body is read whatever the status.
 */
async function checkTileServer(
  tileUrl: string,
  signal: AbortSignal,
  retryDelaysMs: readonly number[],
): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1] ?? 0, signal);
    let body: { sources?: Record<string, { ok?: boolean; error?: string }> };
    try {
      const response = await fetch(`${tileUrl}/health`, { signal });
      if (response.status === 404) {
        throw new TileServerNotReadyError(`HTTP 404 for ${tileUrl}/health`);
      }
      body = JSON.parse(await response.text());
    } catch (err) {
      if (signal.aborted) throw new CorridorCancelledError();
      if (err instanceof TileServerNotReadyError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    const missing = REQUIRED_SOURCES.filter((source) => body.sources?.[source]?.ok !== true);
    if (missing.length > 0) {
      const detail = missing
        .map((source) => {
          const error = body.sources?.[source]?.error;
          return error ? `${source}: ${error}` : `${source} not served`;
        })
        .join('; ');
      throw new TileServerNotReadyError(detail);
    }
    return;
  }
  throw new Error(
    `Couldn't reach the map server. Check the connection and try again. (${lastError})`,
  );
}

interface FillResult {
  count: number;
  minZoom: number;
  maxZoom: number;
}

/**
 * Open a staging file, discarding it when it was started for a different
 * corridor, and stamp it with this one's key.
 */
async function openStaging(trailId: string, partName: string, key: string): Promise<MbtilesWriter> {
  const dirPath = uriToPath(trailTilesDir(trailId).uri);
  let writer = await openMbtilesWriter(dirPath, partName);
  const meta = await writer.readMetadata();
  if (meta[CORRIDOR_KEY_METADATA] !== key) {
    if (Object.keys(meta).length > 0) {
      // Started for another corridor (or route): its tiles are the wrong ones.
      await writer.close();
      const stale = new File(trailTilesDir(trailId), partName);
      if (stale.exists) stale.delete();
      writer = await openMbtilesWriter(dirPath, partName);
    }
    await writer.setMetadata({ [CORRIDOR_KEY_METADATA]: key });
  }
  return writer;
}

/**
 * Fetch `tiles` from one worker source into an open staging file, skipping
 * those it already holds. Resolves with what the file holds afterwards.
 */
async function fillStaging(
  writer: MbtilesWriter,
  tiles: readonly TileXYZ[],
  sourceUrl: string,
  ctx: {
    signal: AbortSignal;
    /** Stops every other request of the build when one tile fails. */
    abort: () => void;
    concurrency: number;
    policy: FetchPolicy;
    tick: (bytes: number) => void;
  },
): Promise<FillResult | null> {
  const have = await writer.existingTiles();
  const pending: TileRow[] = [];
  let writes: Promise<void> = Promise.resolve();
  const flush = () => {
    const batch = pending.splice(0, pending.length);
    writes = writes.then(() => writer.putTiles(batch));
    return writes;
  };

  let next = 0;
  const fetchAll = async () => {
    for (;;) {
      if (ctx.signal.aborted) throw new CorridorCancelledError();
      const i = next++;
      if (i >= tiles.length) return;
      const { z, x, y } = tiles[i];
      if (have.has(tileKey(z, x, y))) {
        ctx.tick(0);
        continue;
      }
      const data = await fetchTile(`${sourceUrl}/${z}/${x}/${y}.pbf`, ctx.signal, ctx.policy);
      if (data) {
        pending.push({ z, x, y, data });
        if (pending.length >= WRITE_BATCH) await flush();
      }
      ctx.tick(data?.length ?? 0);
    }
  };
  const work = async () => {
    try {
      await fetchAll();
    } catch (err) {
      // One failed tile fails the build: stop the other workers now rather
      // than after they have worked through the rest of the list.
      ctx.abort();
      throw err;
    }
  };

  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, ctx.concurrency) }, () => work()),
  );
  // Whatever did arrive is kept for a resume, even when the run failed.
  await flush();
  // allSettled keeps worker order, not time order: the failure that aborted
  // the others may come after their cancellations, and must win over them.
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const failure =
    failures.find((r) => !(r.reason instanceof CorridorCancelledError)) ?? failures[0];
  if (failure) throw failure.reason;

  return writer.stats();
}

/**
 * Build (or rebuild, or resume) the corridor pack for `trailId` from `trail`.
 *
 * Throws {@link CorridorCancelledError} on cancel, and an Error with a plain
 * message on anything else; either way the pack already on disk — files and
 * manifest — is untouched, and the staging files stay for a resume.
 */
export async function downloadCorridorPack(
  trailId: string,
  trail: CorridorTrailInput,
  options: CorridorDownloadOptions,
): Promise<void> {
  const plan = planCorridor(trail, options.bufferKm);
  if (!plan) throw new Error('This route has no track to build an offline map around.');
  if (plan.tooLarge) throw new Error(tooLargeMessage(plan.totalTiles));
  const tileUrl = options.tileUrl.replace(/\/$/, '');
  if (!tileUrl) throw new Error('No tile server is configured.');

  // Cancel aborts the in-flight requests too, and a failed tile stops the rest
  // (`fillStaging` aborts `inner` when one does).
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (options.signal?.aborted) throw new CorridorCancelledError();
  options.signal?.addEventListener('abort', onAbort);

  const root = tilesRoot();
  if (!root.exists) root.create();
  const dir = trailTilesDir(trailId);
  if (!dir.exists) dir.create();
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const key = (source: CorridorSource) => `${plan.sourceVersion}|${plan.bufferKm}|${source}|v1`;
  const tilesTotal = plan.totalTiles;
  let tilesDone = 0;
  let bytes = 0;
  const tick = (n: number) => {
    tilesDone++;
    bytes += n;
    options.onProgress?.({ tilesDone, tilesTotal, bytes });
  };
  const ctx = {
    signal: inner.signal,
    abort: () => inner.abort(),
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    policy: {
      retryDelaysMs,
      requestsPerSecond: options.requestsPerSecond ?? MAX_REQUESTS_PER_SECOND,
      rateLimitWaitMs: options.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS,
    },
    tick,
  };

  const boundsText = (plan.bounds ?? [-180, -85.0511, 180, 85.0511])
    .map((v) => v.toFixed(6))
    .join(',');
  const label = options.name ?? trailId;

  /** Build one file; null when the worker had no tile at all for it. */
  const build = async (
    name: TileFileName,
    source: CorridorSource,
    minZoom: number,
  ): Promise<FillResult | null> => {
    const partName = `${name}${PART_SUFFIX}`;
    const writer = await openStaging(trailId, partName, key(source));
    try {
      const tiles = listTiles(plan.tileSet, minZoom, CORRIDOR_MAX_ZOOM);
      const result = await fillStaging(writer, tiles, `${tileUrl}/${source}`, ctx);
      if (result) {
        // The zooms actually present: MapLibre stoi()s these, and an archive
        // with nothing at the shallow zooms must not claim them.
        await writer.setMetadata({
          name: `${label} ${source === 'base' ? 'basemap' : 'contours'}`,
          format: 'pbf',
          type: source === 'base' ? 'baselayer' : 'overlay',
          minzoom: String(result.minZoom),
          maxzoom: String(result.maxZoom),
          bounds: boundsText,
          ...(source === 'base' ? { attribution: '© OpenStreetMap contributors' } : {}),
        });
      }
      return result;
    } finally {
      await writer.close().catch(() => undefined);
    }
  };

  try {
    await checkTileServer(tileUrl, inner.signal, retryDelaysMs);
    // Recorded before the first tile lands, so an interrupted build always
    // says which corridor its .part files hold (see readCorridorProgress).
    writeCorridorProgress(trailId, { bufferKm: plan.bufferKm, sourceVersion: plan.sourceVersion });
    const base = await build('base.mbtiles', 'base', BASE_MIN_ZOOM);
    if (!base) {
      throw new Error('No map tiles came back for this route. Check the connection and try again.');
    }
    const contours = await build('contours.mbtiles', CONTOUR_SOURCE, CONTOUR_MIN_ZOOM);
    if (inner.signal.aborted) throw new CorridorCancelledError();

    const staged: TileFileName[] = contours
      ? ['base.mbtiles', 'contours.mbtiles']
      : ['base.mbtiles'];
    if (!contours) {
      // No contour tile anywhere along the corridor: a base-only pack, not an
      // empty contours.mbtiles that validation would reject.
      const empty = new File(dir, `contours.mbtiles${PART_SUFFIX}`);
      if (empty.exists) empty.delete();
    }

    // The same structural check a downloaded pack passes, on the staging file,
    // before anything live changes.
    const files: { name: TileFileName; size: number }[] = [];
    for (const name of staged) {
      const partName = `${name}${PART_SUFFIX}`;
      const validation = await validateMbtilesFile(trailId, partName);
      if (!validation.ok) {
        // A file that fails here will fail again: drop it rather than resume it.
        for (const n of staged) {
          const part = new File(dir, `${n}${PART_SUFFIX}`);
          if (part.exists) part.delete();
        }
        deleteCorridorProgress(trailId);
        throw new Error(`${name} is not a usable tile database (${validation.reason})`);
      }
      files.push({ name, size: new File(dir, partName).size ?? 0 });
    }

    const corridor: CorridorPackRecord = {
      bufferKm: plan.bufferKm,
      sourceVersion: plan.sourceVersion,
      builtAt: (options.now?.() ?? new Date()).toISOString(),
      contours: contours != null,
      tileCount: base.count + (contours?.count ?? 0),
    };
    // Promotion is the commit: a cancel that came in while the files were
    // being validated still stops it, and the .part files stay for a resume.
    if (inner.signal.aborted) throw new CorridorCancelledError();
    promoteStagedTiles(trailId, staged, {
      currentNames: packFileNames(trailId),
      keptNames: {},
      record: {
        trailId,
        version: `corridor-${plan.sourceVersion}-${plan.bufferKm}km`,
        files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
        bounds: plan.bounds,
        zoomRange: [BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM],
        corridor,
      },
    });
    deleteCorridorProgress(trailId);
  } catch (err) {
    if (options.signal?.aborted || err instanceof CorridorCancelledError) {
      throw new CorridorCancelledError();
    }
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
