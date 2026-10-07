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
 * the state names it. A fresh list that no longer has a downloaded route (it
 * was hidden or removed) drops it from the device, file and all.
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
import { getBaseUrl, type FetchLike } from '../api/client';
import { useTrailDataStore } from '../state/trail-data-store';
import {
  communityFileName,
  isFetchableUrl,
  isUsableCommunityTrail,
  mergeCommunityRoutes,
  parseCommunityList,
  pruneInstalledCommunity,
  parseCommunitySummary,
  parseInstalledCommunity,
  type InstalledCommunityRoute,
} from './community-catalog';
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
}

/** Load the cached list now (cheap; called once at launch). */
export function initCommunityRoutes(): void {
  getState();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CommunityRouteInfo = CommunityRouteSummary & { downloaded: boolean };

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
 * Read a downloaded route. The trail's own `config.id` is the submitter's
 * import id (`u_…`), so it is rewritten to the community id — every per-trail
 * store on the device keys on the id the guide was opened under — and its name
 * to the listed one (an owner may have renamed it since).
 *
 * An unreadable copy is forgotten so the next open downloads it again.
 */
export async function readCommunityTrail(id: string): Promise<TrailJson | null> {
  if (!isCommunityRouteId(id)) return null;
  const installed = getState().installed[id];
  if (!installed) return null;
  try {
    const file = new File(communityRoot(), installed.file);
    if (file.exists) {
      const json = JSON.parse(await file.text()) as unknown;
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
    }
  } catch {
    // Fall through: treated the same as a missing file.
  }
  if (getState().installed[id]?.file === installed.file) forgetInstalled(id);
  return null;
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
 * Fetch the public list and cache it. Throttled unless `force`, single-flight,
 * never throws. Without an API base URL this is a no-op and only routes
 * already on the device are listed.
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
      const pruned = pruneInstalledCommunity(list, getState().installed);
      saveState({ ...getState(), list, fetchedAt: now, installed: pruned.installed });
      for (const file of pruned.droppedFiles) deleteQuietly(file);
      return { checked: true };
    } catch (err) {
      return { checked: false, error: err instanceof Error ? err.message : String(err) };
    }
  })().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/** Put a route into the cached list now (just submitted), replacing any row with its id. */
export function upsertCommunitySummary(raw: unknown): void {
  const summary = parseCommunitySummary(raw);
  if (!summary) return;
  const current = getState();
  const list = [...(current.list ?? []).filter((r) => r.id !== summary.id), summary];
  saveState({ ...current, list });
}

/** Drop a route from the list and the device (its owner deleted it). */
export function forgetCommunityRoute(id: string): void {
  const current = getState();
  const list = current.list ? current.list.filter((r) => r.id !== id) : current.list;
  const entry = current.installed[id];
  const installed = { ...current.installed };
  delete installed[id];
  saveState({ ...current, list, installed });
  if (entry) deleteQuietly(entry.file);
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

const inFlightDownloads = new Map<string, Promise<void>>();

function downloadRoute(summary: CommunityRouteSummary): Promise<void> {
  const existing = inFlightDownloads.get(summary.id);
  if (existing) return existing;
  const run = doDownload(summary).finally(() => {
    inFlightDownloads.delete(summary.id);
    useTrailDataStore.getState().setDownloading(summary.id, false);
  });
  useTrailDataStore.getState().setDownloading(summary.id, true);
  inFlightDownloads.set(summary.id, run);
  return run;
}

async function doDownload(summary: CommunityRouteSummary): Promise<void> {
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
 * Make sure a community route is on the device, downloading it if needed —
 * what opening one does. Resolves true when a copy is ready to read, false
 * when no such route is known. Throws when the download fails.
 */
export async function ensureCommunityRouteDownloaded(
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (!isCommunityRouteId(id)) return false;
  if (getState().installed[id] && (await readCommunityTrail(id))) return true;

  let summary: CommunityRouteSummary | null =
    (getState().list ?? []).find((r) => r.id === id) ?? null;
  if (!summary) {
    // A link to a route this phone has never listed: ask the server.
    const baseUrl = getBaseUrl();
    if (!baseUrl) return false;
    summary = parseCommunitySummary(
      await getCommunityRoute({ baseUrl, fetchImpl: options.fetchImpl }, id),
    );
    if (!summary) return false;
  }
  await downloadRoute(summary);
  return true;
}
