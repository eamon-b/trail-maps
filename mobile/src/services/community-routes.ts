/**
 * Community routes on the device: the cached public list and the downloaded
 * routes. The decisions are pure and live in `community-catalog.ts`; this is
 * the I/O, laid out like `trail-data-updates.ts`:
 *
 *   {documentDir}/community/state.json   last good list + what is downloaded
 *   {documentDir}/community/{file}       one downloaded route's ProcessedTrail,
 *                                        named `<id>.<md5[0..12]>.json`
 *
 * The list comes from `GET /v1/community/routes` on the comments API
 * (`EXPO_PUBLIC_API_BASE_URL`) on the same launch/foreground/pull-to-refresh
 * cadence as the trail catalog, throttled to {@link COMMUNITY_REFRESH_MS}. A
 * route's JSON is downloaded the first time its guide is opened
 * (`GuideProvider`), checked for size, MD5 and shape on a `.part` file before
 * the state names it, and downloaded again when a fresh list carries a
 * different MD5 (an owner's edit, a de-attribution).
 *
 * A downloaded route is never deleted because a list leaves it out: a list can
 * be truncated, partly unreadable, briefly empty or a cached copy, and the
 * hiker may be walking that route with a plan on it. Each unlisted download is
 * asked about instead (`GET /v1/community/routes/:id`, a few per refresh); a
 * 404 marks it `takenDown` — shown as "No longer shared", file kept — and only
 * the hiker removes it ({@link removeCommunityRouteFromDevice}). A list that
 * names it again clears the flag.
 *
 * A community route is NOT server-known (`server-trails`): no comments, no
 * plan sync, no curated descriptions — the same as a `u_` import. Its offline
 * map pack is borrowed from a covering bundled trail, as for an import.
 *
 * Keep this module free of `trail-loader` imports: the loader depends on it.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { isCommunityRouteId, type CommunityRouteSummary } from '@lib/community-types';

import { getCommunityRoute, listCommunityRoutes } from '../api/community';
import { ApiError, getBaseUrl, type FetchLike } from '../api/client';
import { getDatabase } from '../db/database';
import type { SqlDatabase } from '../db/sql-database';
import { useTrailDataStore } from '../state/trail-data-store';
import {
  classifyCommunityProbe,
  communityFileName,
  isFetchableUrl,
  isUsableCommunityTrail,
  mergeCommunityRoutes,
  parseCommunityList,
  parseCommunitySummary,
  parseInstalledCommunity,
  planCommunitySync,
  type CommunityProbe,
  type CommunityRouteListing,
  type InstalledCommunityRoute,
} from './community-catalog';
import { deleteLocalTrailData } from './local-trail-data';
import type { TrailJson } from './trail-assets';

/** How often the launch/foreground refresh actually reaches the network. */
export const COMMUNITY_REFRESH_MS = 30 * 60 * 1000;
/** After a failed refresh (offline), wait this long before the next automatic one. */
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

const STATE_FILE = 'state.json';
const STATE_TEMP_FILE = 'state.json.tmp';
const PART_SUFFIX = '.part';

export function communityRoot(): Directory {
  return new Directory(Paths.document, 'community');
}

function ensureRoot(): Directory {
  const root = communityRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return root;
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

interface CommunityState {
  /** Last list that parsed, or null before the first successful fetch. */
  list: CommunityRouteSummary[] | null;
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number | null;
  /** Downloaded routes, keyed by id. */
  installed: Record<string, InstalledCommunityRoute>;
}

let state: CommunityState | null = null;

function emptyState(): CommunityState {
  return { list: null, fetchedAt: null, installed: {} };
}

function parseState(raw: unknown): CommunityState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as Record<string, unknown>;
  const installed: Record<string, InstalledCommunityRoute> = {};
  if (r.installed && typeof r.installed === 'object') {
    for (const [id, value] of Object.entries(r.installed as Record<string, unknown>)) {
      const entry = parseInstalledCommunity(value);
      if (entry && entry.summary.id === id) installed[id] = entry;
    }
  }
  return {
    list: r.list === null || r.list === undefined ? null : parseCommunityList({ routes: r.list }),
    fetchedAt: typeof r.fetchedAt === 'number' ? r.fetchedAt : null,
    installed,
  };
}

function readStateFile(name: string): CommunityState | null {
  try {
    const file = new File(communityRoot(), name);
    return file.exists ? parseState(JSON.parse(file.textSync())) : null;
  } catch {
    return null;
  }
}

/** Synchronous: My Guides lists the cached routes in its first frame. */
function getState(): CommunityState {
  if (state) return state;
  state = readStateFile(STATE_FILE) ?? readStateFile(STATE_TEMP_FILE) ?? emptyState();
  return state;
}

/** Temp file then rename, as `trail-data-updates` does, so a crash never tears it. */
function saveState(next: CommunityState): void {
  state = next;
  try {
    const root = ensureRoot();
    const temp = new File(root, STATE_TEMP_FILE);
    if (temp.exists) temp.delete();
    temp.write(JSON.stringify(next));
    const live = new File(root, STATE_FILE);
    if (live.exists) live.delete();
    temp.rename(STATE_FILE);
  } catch (err) {
    console.warn('[community] could not save state', err);
  }
  useTrailDataStore.getState().bump();
}

/** Test seam: forget the in-memory state so the next read goes to disk. */
export function resetCommunityStateForTests(): void {
  state = null;
  inFlightRefresh = null;
  lastAttemptAt = 0;
  inFlightDownloads.clear();
  removals.clear();
}

/** Load the cached list now (cheap; called once at launch). */
export function initCommunityRoutes(): void {
  getState();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CommunityRouteInfo = CommunityRouteListing;

/** Every community route the device can list: the cached list plus downloaded ones. */
export function listCachedCommunityRoutes(): CommunityRouteInfo[] {
  const s = getState();
  return mergeCommunityRoutes(s.list, s.installed);
}

/** One route's metadata (list or downloaded copy), or null. */
export function getCommunityRouteInfo(id: string): CommunityRouteInfo | null {
  if (!isCommunityRouteId(id)) return null;
  return listCachedCommunityRoutes().find((r) => r.id === id) ?? null;
}

/**
 * The copy of a route on this phone exists but cannot be read, and is kept:
 * an I/O error may pass, and a corrupt copy of a route that is no longer
 * shared cannot be downloaded again (`GuideProvider` shows it with a retry).
 */
export class CommunityCopyUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityCopyUnreadableError';
  }
}

/**
 * Read a downloaded route. The worker writes the community id into the
 * trail's `config.id`, but the file is a stranger's and is not trusted for it:
 * the id is set again to the one the guide was opened under — every per-trail
 * store on the device keys on it — and the name to the listed one (an owner
 * may have renamed it since the copy was downloaded).
 *
 * Null when there is no copy. A copy whose file is missing is forgotten. A
 * corrupt copy of a route the cached list still offers is forgotten and
 * deleted, so the next open downloads it again. Anything else throws
 * {@link CommunityCopyUnreadableError} and keeps the file: a read that failed
 * (it may work next time), and a corrupt copy of a route that is not listed —
 * "No longer shared" or not yet known either way — which could not be
 * downloaded again: a download is never deleted except by the hiker.
 */
export async function readCommunityTrail(id: string): Promise<TrailJson | null> {
  if (!isCommunityRouteId(id)) return null;
  const installed = getState().installed[id];
  if (!installed) return null;
  const file = new File(communityRoot(), installed.file);
  let text: string;
  try {
    if (!file.exists) {
      if (getState().installed[id]?.file === installed.file) forgetInstalled(id);
      return null;
    }
    text = await file.text();
  } catch (err) {
    console.warn(`[community] could not read ${installed.file}`, err);
    throw new CommunityCopyUnreadableError('The copy of this route on this phone could not be read.');
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    // Corrupt: handled below with a parse that is not a trail.
  }
  if (isUsableCommunityTrail(json)) {
    const trail = json as TrailJson;
    const name = getCommunityRouteInfo(id)?.name ?? installed.summary.name;
    return {
      ...trail,
      config: {
        ...trail.config,
        id,
        name,
        shortName: name,
      },
    } as TrailJson;
  }

  const current = getState();
  const entry = current.installed[id];
  const stillListed = current.list?.some((r) => r.id === id) === true;
  if (entry?.file === installed.file && stillListed && entry.takenDown !== true) {
    forgetInstalled(id);
    return null;
  }
  throw new CommunityCopyUnreadableError(
    'The copy of this route on this phone is damaged, and the route can’t be downloaded again.',
  );
}

function forgetInstalled(id: string): void {
  const current = getState();
  const entry = current.installed[id];
  if (!entry) return;
  const installed = { ...current.installed };
  delete installed[id];
  saveState({ ...current, installed });
  deleteQuietly(entry.file);
}

function deleteQuietly(fileName: string): void {
  try {
    const file = new File(communityRoot(), fileName);
    if (file.exists) file.delete();
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Refreshing the list
// ---------------------------------------------------------------------------

export interface CommunityRefreshResult {
  /** False when skipped (throttled, unconfigured) or failed. */
  checked: boolean;
  error?: string;
}

let inFlightRefresh: Promise<CommunityRefreshResult> | null = null;
let lastAttemptAt = 0;

/**
 * Ask the server about one route (no token: the public view, so a route hidden
 * from everyone else reads as gone to its owner's phone too). Never throws.
 */
async function probeCommunityRoute(
  baseUrl: string,
  id: string,
  fetchImpl?: FetchLike,
): Promise<CommunityProbe & { error?: unknown }> {
  try {
    const detail = await getCommunityRoute({ baseUrl, fetchImpl, cache: 'no-store' }, id);
    return classifyCommunityProbe({ ok: true, detail });
  } catch (err) {
    const probe = classifyCommunityProbe({
      ok: false,
      status: err instanceof ApiError ? err.status : undefined,
    });
    return { ...probe, error: err };
  }
}

/** Set or clear one download's `takenDown` flag (no-op when it is not downloaded). */
function setTakenDown(id: string, takenDown: boolean): void {
  const current = getState();
  const entry = current.installed[id];
  if (!entry || (entry.takenDown === true) === takenDown) return;
  const next: InstalledCommunityRoute = { summary: entry.summary, file: entry.file };
  if (takenDown) next.takenDown = true;
  saveState({ ...current, installed: { ...current.installed, [id]: next } });
}

/**
 * The server has said this route is no longer shared (a 404 from its detail
 * or its download): drop it from the cached list and, when it is downloaded,
 * flag the copy `takenDown` — kept, never deleted, until the hiker removes it.
 */
export function markCommunityRouteTakenDown(id: string): void {
  const current = getState();
  if (current.list?.some((r) => r.id === id)) {
    saveState({ ...current, list: current.list.filter((r) => r.id !== id) });
  }
  setTakenDown(id, true);
}

/**
 * Fetch the public list and cache it. Throttled unless `force`, single-flight,
 * never throws. Without an API base URL this is a no-op and only routes
 * already on the device are listed.
 *
 * Then, for the downloaded routes: those the list names have `takenDown`
 * cleared and are downloaded again when the list's MD5 differs; those it does
 * not name are asked about one by one (at most `MAX_COMMUNITY_PROBES`), and
 * only a positive "not shared" (404) flags them. Nothing is deleted here.
 */
export function refreshCommunityRoutes(
  options: { force?: boolean; now?: number; fetchImpl?: FetchLike } = {},
): Promise<CommunityRefreshResult> {
  if (inFlightRefresh) return inFlightRefresh;
  const baseUrl = getBaseUrl();
  if (!baseUrl) return Promise.resolve({ checked: false });
  const now = options.now ?? Date.now();
  if (!options.force) {
    const last = getState().fetchedAt;
    if (last !== null && last <= now && now - last < COMMUNITY_REFRESH_MS) {
      return Promise.resolve({ checked: false });
    }
    if (now - lastAttemptAt < RETRY_INTERVAL_MS) return Promise.resolve({ checked: false });
  }
  lastAttemptAt = now;

  inFlightRefresh = (async (): Promise<CommunityRefreshResult> => {
    try {
      const response = await listCommunityRoutes({ baseUrl, fetchImpl: options.fetchImpl });
      const list = parseCommunityList(response);
      if (!list) return { checked: false, error: 'The community list is not in a format this app reads' };
      const plan = planCommunitySync(list, getState().installed);
      saveState({ ...getState(), list, fetchedAt: now, installed: plan.installed });

      for (const id of plan.probe) {
        const probe = await probeCommunityRoute(baseUrl, id, options.fetchImpl);
        if (probe.kind === 'gone') setTakenDown(id, true);
        else if (probe.kind === 'live') setTakenDown(id, false);
      }

      // One at a time, like the trail catalog's updates. A failure keeps the
      // copy already on the phone; the next refresh tries again.
      for (const summary of plan.stale) {
        // Removed from this phone since the plan was made: not an update.
        if (!getState().installed[summary.id]) continue;
        try {
          await downloadRoute(summary);
        } catch (err) {
          console.warn(`[community] update of ${summary.id} failed`, err);
        }
      }
      return { checked: true };
    } catch (err) {
      return { checked: false, error: err instanceof Error ? err.message : String(err) };
    }
  })().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * Put a route into the cached list now (just submitted, or its detail was
 * fetched), replacing any row with its id. A listed route is shared, so a
 * downloaded copy's `takenDown` flag is cleared.
 */
export function upsertCommunitySummary(raw: unknown): void {
  const summary = parseCommunitySummary(raw);
  if (!summary) return;
  const current = getState();
  const list = [...(current.list ?? []).filter((r) => r.id !== summary.id), summary];
  saveState({ ...current, list });
  setTakenDown(summary.id, false);
}

/**
 * Remove a downloaded route from this phone — its file and every piece of
 * local state about it (plan, favourites, custom routes, pace, direction, the
 * "Hiking now" pin; `local-trail-data`). The cached list row stays, so a route
 * that is still shared is listed again as "downloads when opened".
 */
export async function removeCommunityRouteFromDevice(
  id: string,
  options: { db?: SqlDatabase } = {},
): Promise<void> {
  if (!isCommunityRouteId(id)) return;
  // A download already running for it must not put it back: it sees the
  // count move and throws away what it fetched (`doDownload`).
  removals.set(id, removalCount(id) + 1);
  const current = getState();
  const entry = current.installed[id];
  if (entry) {
    const installed = { ...current.installed };
    delete installed[id];
    saveState({ ...current, installed });
    deleteQuietly(entry.file);
  }
  await deleteLocalTrailData(options.db ?? (await getDatabase()), id);
}

/**
 * Drop a route from the list and the device (its owner deleted it): the same
 * full cleanup as {@link removeCommunityRouteFromDevice}, and the list row too.
 */
export async function forgetCommunityRoute(
  id: string,
  options: { db?: SqlDatabase } = {},
): Promise<void> {
  const current = getState();
  if (current.list?.some((r) => r.id === id)) {
    saveState({ ...current, list: current.list.filter((r) => r.id !== id) });
  }
  await removeCommunityRouteFromDevice(id, options);
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

/** A download that is not the file the list describes (size, MD5, shape). */
export class CommunityIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityIntegrityError';
  }
}

/** A download cancelled because the hiker removed the route while it ran. */
export class CommunityDownloadCancelledError extends Error {
  constructor() {
    super('This route was removed from this phone while it downloaded.');
    this.name = 'CommunityDownloadCancelledError';
  }
}

/** Each running download, with the removal count it will commit under. */
const inFlightDownloads = new Map<string, { run: Promise<void>; removal: number }>();
/**
 * How many times each route has been removed from this phone this session. A
 * download notes the count when it starts and commits only if it has not
 * moved, so removing a route always wins over a download in flight.
 */
const removals = new Map<string, number>();

function removalCount(id: string): number {
  return removals.get(id) ?? 0;
}

/**
 * Download one route (single-flight per id). `removal` is the removal count the
 * caller started from — an open that began before the hiker removed the route
 * must not put it back either.
 */
function downloadRoute(
  summary: CommunityRouteSummary,
  removal = removalCount(summary.id),
): Promise<void> {
  const existing = inFlightDownloads.get(summary.id);
  if (existing) {
    if (existing.removal >= removal) return existing.run;
    // A download the hiker has since cancelled by removing the route: let it
    // settle (it throws its work away), then start afresh.
    return existing.run.catch(() => {}).then(() => downloadRoute(summary, removal));
  }
  const run = doDownload(summary, removal).finally(() => {
    inFlightDownloads.delete(summary.id);
    useTrailDataStore.getState().setDownloading(summary.id, false);
  });
  useTrailDataStore.getState().setDownloading(summary.id, true);
  inFlightDownloads.set(summary.id, { run, removal });
  return run;
}

async function doDownload(summary: CommunityRouteSummary, removal: number): Promise<void> {
  if (!isCommunityRouteId(summary.id)) throw new Error(`Refusing route id "${summary.id}".`);
  if (!isFetchableUrl(summary.trailUrl)) throw new Error('This route has no download link.');
  const root = ensureRoot();
  const fileName = communityFileName(summary.id, summary.md5);
  const part = new File(root, `${fileName}${PART_SUFFIX}`);
  if (part.exists) part.delete();

  try {
    await File.downloadFileAsync(summary.trailUrl, part, { idempotent: true });
    const info = part.info({ md5: true });
    if (info.size !== summary.bytes) {
      throw new CommunityIntegrityError(
        `Size mismatch: expected ${summary.bytes} bytes, got ${info.size ?? 0}`,
      );
    }
    if ((info.md5 ?? '').toLowerCase() !== summary.md5) {
      throw new CommunityIntegrityError('Checksum mismatch');
    }
    let json: unknown;
    try {
      json = JSON.parse(await part.text());
    } catch {
      throw new CommunityIntegrityError('The downloaded file is not JSON');
    }
    if (!isUsableCommunityTrail(json)) {
      throw new CommunityIntegrityError('The downloaded file is not a trail');
    }
    // No await from here to the state write below, so this check holds.
    if (removalCount(summary.id) !== removal) throw new CommunityDownloadCancelledError();
    const dest = new File(root, fileName);
    if (dest.exists) dest.delete();
    part.rename(fileName);
  } catch (err) {
    if (part.exists) part.delete();
    throw err;
  }

  const current = getState();
  const previous = current.installed[summary.id];
  saveState({
    ...current,
    installed: { ...current.installed, [summary.id]: { summary, file: fileName } },
  });
  if (previous && previous.file !== fileName) deleteQuietly(previous.file);
}

/**
 * The server says the route is no longer shared — what `GuideProvider` shows
 * as "This route is no longer shared", with no retry.
 */
export class CommunityRouteTakenDownError extends Error {
  constructor() {
    super('This route is no longer shared.');
    this.name = 'CommunityRouteTakenDownError';
  }
}

/**
 * Make sure a community route is on the device, downloading it if needed —
 * what opening one does. Resolves true when a copy is ready to read, false
 * when no such route is known. Throws {@link CommunityRouteTakenDownError}
 * when the server says the route is no longer shared,
 * {@link CommunityDownloadCancelledError} when the hiker removed it from this
 * phone meanwhile, and the download's own error for anything else (usually:
 * offline).
 *
 * A downloaded copy whose MD5 the list no longer carries is downloaded again
 * first; when that fails the older copy is used.
 */
export async function ensureCommunityRouteDownloaded(
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (!isCommunityRouteId(id)) return false;
  const removal = removalCount(id);
  const listed = (getState().list ?? []).find((r) => r.id === id) ?? null;
  const installed = getState().installed[id];
  if (installed) {
    if (listed && listed.md5 !== installed.summary.md5) {
      try {
        await downloadRoute(listed, removal);
        return true;
      } catch (err) {
        if (err instanceof CommunityDownloadCancelledError) throw err;
        console.warn(`[community] update of ${id} failed; opening the copy on this phone`, err);
      }
    }
    if (await readCommunityTrail(id)) return true;
  }

  const baseUrl = getBaseUrl();
  let summary: CommunityRouteSummary | null = listed;
  if (!summary) {
    // A link to a route this phone has never listed: ask the server.
    if (!baseUrl) return false;
    const probe = await probeCommunityRoute(baseUrl, id, options.fetchImpl);
    if (probe.kind === 'gone') {
      markCommunityRouteTakenDown(id);
      throw new CommunityRouteTakenDownError();
    }
    if (probe.kind === 'unknown') {
      // Offline or a 5xx: surface it (the guide offers a retry). An answer
      // that is not a route at all reads as "not found".
      if (probe.error) throw probe.error;
      return false;
    }
    summary = probe.summary;
  }
  try {
    await downloadRoute(summary, removal);
  } catch (err) {
    if (err instanceof CommunityDownloadCancelledError) throw err;
    // The listed copy would not download. Ask whether the route is still
    // shared: a 404 is the taken-down state, a newer copy is fetched instead.
    if (!baseUrl) throw err;
    const probe = await probeCommunityRoute(baseUrl, id, options.fetchImpl);
    if (probe.kind === 'gone') {
      markCommunityRouteTakenDown(id);
      throw new CommunityRouteTakenDownError();
    }
    if (probe.kind === 'live' && probe.summary.md5 !== summary.md5) {
      upsertCommunitySummary(probe.summary);
      await downloadRoute(probe.summary, removal);
      return true;
    }
    throw err;
  }
  return true;
}
