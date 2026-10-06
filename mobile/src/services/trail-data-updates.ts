/**
 * Over-the-air trail data: the R2 catalog, and the downloaded copies on disk.
 *
 * The bundled trail JSON is the seed; this module keeps newer published copies
 * beside it so a waypoint fix reaches the phone without a new build (decisions
 * in `trail-catalog.ts`, publishing in `docs/trail-data-updates.md`). Layout:
 *
 *   {documentDir}/trail-data/state.json      last good catalog + what is installed
 *   {documentDir}/trail-data/{key}           one downloaded trail, named by its
 *                                            content-addressed catalog key
 *
 * Writes are ordered so a crash leaves a working app: the new file is fully
 * downloaded, checked (size, MD5, shape) and in place BEFORE the state file
 * names it, and the old file is deleted only after. A torn state file reads as
 * "nothing installed", which falls back to the bundle; orphaned files are swept
 * on the next successful check.
 *
 * A guide that is open keeps the data it opened with — a download takes effect
 * the next time the guide is opened (`GuideProvider` reads once per mount).
 *
 * Keep this module free of `trail-loader` imports: the loader depends on it.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { registerRemoteTrailIds } from './server-trails';
import {
  TRAIL_DATA_FORMAT,
  downloadSupersedesBundle,
  isCatalogTrailId,
  isUsableTrailJson,
  parseCatalog,
  parseInstalled,
  planTrailDataSync,
  type CatalogEntry,
  type InstalledTrail,
  type TrailCatalog,
  type TrailVersionInfo,
} from './trail-catalog';
import type { TrailJson } from './trail-assets';
import { useTrailDataStore } from '../state/trail-data-store';

/** How often the launch/foreground check actually reaches the network. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After a failed check (offline), wait this long before the next automatic one. */
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

const STATE_FILE = 'state.json';
const PART_SUFFIX = '.part';

// ---------------------------------------------------------------------------
// Where the data lives
// ---------------------------------------------------------------------------

/**
 * `{TILE_BASE_URL}/trails/v{format}` — the same R2 bucket and domain as the
 * offline tile packs. Empty when the build has no tile base URL, which turns
 * over-the-air updates off: the app runs on its bundled data alone.
 */
export function trailDataBaseUrl(): string {
  const base = (process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}/trails/v${TRAIL_DATA_FORMAT}` : '';
}

export function trailDataRoot(): Directory {
  return new Directory(Paths.document, 'trail-data');
}

function ensureRoot(): Directory {
  const root = trailDataRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return root;
}

// ---------------------------------------------------------------------------
// Bundled versions — read straight from index.json (4 KB), not the loader
// ---------------------------------------------------------------------------

let bundledCache: Map<string, TrailVersionInfo> | null = null;

/** The bundled trails' version info, keyed by id. */
export function bundledVersions(): ReadonlyMap<string, TrailVersionInfo> {
  if (!bundledCache) {
    const index = require('../../assets/trails/index.json') as TrailVersionInfo[];
    bundledCache = new Map(index.map((entry) => [entry.id, entry]));
  }
  return bundledCache;
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

interface TrailDataState {
  /** Last catalog that parsed, or null before the first successful check. */
  catalog: TrailCatalog | null;
  /** Epoch ms of the last successful check. */
  lastCheckedAt: number | null;
  /** Downloaded copies, keyed by trail id. */
  installed: Record<string, InstalledTrail>;
}

let state: TrailDataState | null = null;

function emptyState(): TrailDataState {
  return { catalog: null, lastCheckedAt: null, installed: {} };
}

function parseState(raw: unknown): TrailDataState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as Record<string, unknown>;
  const installed: Record<string, InstalledTrail> = {};
  if (r.installed && typeof r.installed === 'object') {
    for (const [id, value] of Object.entries(r.installed as Record<string, unknown>)) {
      const entry = parseInstalled(value);
      if (entry && entry.id === id) installed[id] = entry;
    }
  }
  return {
    catalog: parseCatalog(r.catalog),
    lastCheckedAt: typeof r.lastCheckedAt === 'number' ? r.lastCheckedAt : null,
    installed,
  };
}

/**
 * The state, read synchronously from disk on first use. Synchronous because
 * the guide list and the guide header resolve a bundled trail's metadata in the
 * first frame, and they must already see a newer download's name and length.
 */
function getState(): TrailDataState {
  if (state) return state;
  let loaded = emptyState();
  try {
    const file = new File(trailDataRoot(), STATE_FILE);
    if (file.exists) loaded = parseState(JSON.parse(file.textSync()));
  } catch {
    loaded = emptyState();
  }
  state = loaded;
  registerRemoteTrailIds(remoteIds(loaded));
  return loaded;
}

function saveState(next: TrailDataState): void {
  state = next;
  registerRemoteTrailIds(remoteIds(next));
  try {
    new File(ensureRoot(), STATE_FILE).write(JSON.stringify(next));
  } catch (err) {
    console.warn('[trail-data] could not save state', err);
  }
  useTrailDataStore.getState().bump();
}

/** Catalog-only ids: published or downloaded, not bundled. */
function remoteIds(s: TrailDataState): string[] {
  const bundled = bundledVersions();
  const ids = new Set<string>();
  for (const entry of s.catalog?.trails ?? []) if (!bundled.has(entry.id)) ids.add(entry.id);
  for (const id of Object.keys(s.installed)) if (!bundled.has(id)) ids.add(id);
  return [...ids];
}

/** Test seam: forget the in-memory state so the next read goes to disk. */
export function resetTrailDataStateForTests(): void {
  state = null;
  bundledCache = null;
  inFlightCheck = null;
  lastAttemptAt = 0;
  inFlightDownloads.clear();
}

/** Load the state now (registers catalog-only ids with the server gate). */
export function initTrailData(): void {
  getState();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The downloaded copy the app should read for this trail, or null: a download
 * of a bundled trail counts only while it is newer than the bundle.
 */
export function activeDownload(id: string): InstalledTrail | null {
  const installed = getState().installed[id];
  if (!installed) return null;
  return downloadSupersedesBundle(installed, bundledVersions().get(id)) ? installed : null;
}

/**
 * Read the active downloaded copy. Null when there is none or it is unreadable.
 *
 * An unreadable copy is forgotten as well: the catalog's md5 would otherwise
 * keep matching the record, so no check would ever fetch it again and a
 * catalog-only guide could never reopen.
 */
export async function readDownloadedTrail(id: string): Promise<TrailJson | null> {
  const installed = activeDownload(id);
  if (!installed) return null;
  try {
    const file = new File(trailDataRoot(), installed.file);
    if (file.exists) {
      const json = JSON.parse(await file.text()) as unknown;
      if (isUsableTrailJson(json, id)) return json as TrailJson;
    }
  } catch {
    // Fall through: treated the same as a missing file.
  }
  if (getState().installed[id]?.file === installed.file) removeInstalled([id]);
  return null;
}

export interface RemoteTrailInfo extends TrailVersionInfo {
  /** True once a copy is on the device. */
  downloaded: boolean;
}

/**
 * Trails this build does not bundle: everything in the last catalog plus any
 * downloaded copy the catalog has since dropped, in catalog order.
 */
export function listRemoteTrails(): RemoteTrailInfo[] {
  const s = getState();
  const bundled = bundledVersions();
  const out: RemoteTrailInfo[] = [];
  const seen = new Set<string>();
  for (const entry of s.catalog?.trails ?? []) {
    if (bundled.has(entry.id)) continue;
    seen.add(entry.id);
    const installed = s.installed[entry.id];
    out.push({ ...stripKey(installed ?? entry), downloaded: !!installed });
  }
  for (const [id, installed] of Object.entries(s.installed)) {
    if (bundled.has(id) || seen.has(id)) continue;
    out.push({ ...stripKey(installed), downloaded: true });
  }
  return out;
}

function stripKey(entry: CatalogEntry): TrailVersionInfo {
  return {
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName,
    lengthKm: entry.lengthKm,
    dataVersion: entry.dataVersion,
    updatedAt: entry.updatedAt,
    md5: entry.md5,
    bytes: entry.bytes,
  };
}

/** Metadata of a catalog-only trail, downloaded or not. */
export function getRemoteTrail(id: string): RemoteTrailInfo | null {
  return listRemoteTrails().find((entry) => entry.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

const inFlightDownloads = new Map<string, Promise<void>>();

/**
 * Download one published trail and make it the installed copy. Single-flight
 * per trail. Throws when the download or any check fails; the previous copy
 * (if any) is untouched in that case.
 */
export function downloadTrailEntry(entry: CatalogEntry): Promise<void> {
  const existing = inFlightDownloads.get(entry.id);
  if (existing) return existing;
  const run = doDownload(entry).finally(() => {
    inFlightDownloads.delete(entry.id);
    useTrailDataStore.getState().setDownloading(entry.id, false);
  });
  useTrailDataStore.getState().setDownloading(entry.id, true);
  inFlightDownloads.set(entry.id, run);
  return run;
}

async function doDownload(entry: CatalogEntry): Promise<void> {
  const baseUrl = trailDataBaseUrl();
  if (!baseUrl) throw new Error('Trail downloads are not configured in this build.');
  if (!isCatalogTrailId(entry.id)) throw new Error(`Refusing trail id "${entry.id}".`);

  const root = ensureRoot();
  const part = new File(root, `${entry.key}${PART_SUFFIX}`);
  if (part.exists) part.delete();

  try {
    await File.downloadFileAsync(`${baseUrl}/${entry.key}`, part, { idempotent: true });

    const info = part.info({ md5: true });
    if (info.size !== entry.bytes) {
      throw new Error(`Size mismatch: expected ${entry.bytes} bytes, got ${info.size ?? 0}`);
    }
    if ((info.md5 ?? '').toLowerCase() !== entry.md5) {
      throw new Error('Checksum mismatch');
    }
    if (!isUsableTrailJson(JSON.parse(await part.text()), entry.id)) {
      throw new Error('The downloaded file is not this trail');
    }

    const dest = new File(root, entry.key);
    if (dest.exists) dest.delete();
    part.rename(entry.key);
  } catch (err) {
    if (part.exists) part.delete();
    throw err;
  }

  // The new file is in place; now let the state name it, then drop the old one.
  const current = getState();
  const previous = current.installed[entry.id];
  saveState({
    ...current,
    installed: { ...current.installed, [entry.id]: { ...entry, file: entry.key } },
  });
  if (previous && previous.file !== entry.key) deleteQuietly(previous.file);
}

function deleteQuietly(fileName: string): void {
  try {
    const file = new File(trailDataRoot(), fileName);
    if (file.exists) file.delete();
  } catch {
    // An orphan is swept on the next check.
  }
}

/** Remove downloaded copies (the bundle has caught up with them). */
function removeInstalled(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const current = getState();
  const installed = { ...current.installed };
  const files: string[] = [];
  for (const id of ids) {
    const entry = installed[id];
    if (!entry) continue;
    files.push(entry.file);
    delete installed[id];
  }
  saveState({ ...current, installed });
  files.forEach(deleteQuietly);
}

/** Delete anything in the directory the state does not name. */
function sweepOrphans(): void {
  const root = trailDataRoot();
  if (!root.exists) return;
  const keep = new Set([STATE_FILE, ...Object.values(getState().installed).map((e) => e.file)]);
  // Downloads still running own their `.part` file.
  for (const id of inFlightDownloads.keys()) {
    const key = getState().catalog?.trails.find((e) => e.id === id)?.key;
    if (key) keep.add(`${key}${PART_SUFFIX}`);
  }
  try {
    for (const item of root.list()) {
      if (item instanceof File && !keep.has(item.name)) item.delete();
    }
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export interface TrailDataCheckResult {
  /** False when the check was skipped (throttled, unconfigured) or failed. */
  checked: boolean;
  /** Trail ids downloaded by this check. */
  updated: string[];
  /** Trail ids whose download failed. */
  failed: string[];
  error?: string;
}

let inFlightCheck: Promise<TrailDataCheckResult> | null = null;
let lastAttemptAt = 0;

async function fetchCatalog(): Promise<TrailCatalog> {
  const response = await fetch(`${trailDataBaseUrl()}/catalog.json`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  const catalog = parseCatalog(await response.json());
  if (!catalog) throw new Error('The trail catalog is not in a format this app reads');
  return catalog;
}

/**
 * Fetch the catalog and bring every trail the device has up to date.
 *
 * Throttled to once per {@link CHECK_INTERVAL_MS} unless `force` (pull to
 * refresh), and single-flight: a second caller joins the running check.
 * Never throws — failure (usually: offline) is reported in the result and
 * leaves everything as it was.
 */
export function checkForTrailDataUpdates(
  options: { force?: boolean; now?: number } = {},
): Promise<TrailDataCheckResult> {
  if (inFlightCheck) return inFlightCheck;
  const now = options.now ?? Date.now();
  if (!trailDataBaseUrl()) return Promise.resolve({ checked: false, updated: [], failed: [] });
  if (!options.force) {
    const last = getState().lastCheckedAt;
    // A stamp in the future (the clock was wrong once) is stale, not fresh —
    // otherwise automatic checks would stop until that time came round.
    if (last !== null && last <= now && now - last < CHECK_INTERVAL_MS) {
      return Promise.resolve({ checked: false, updated: [], failed: [] });
    }
    if (now - lastAttemptAt < RETRY_INTERVAL_MS) {
      return Promise.resolve({ checked: false, updated: [], failed: [] });
    }
  }
  lastAttemptAt = now;

  const status = useTrailDataStore.getState();
  status.setChecking(true);
  inFlightCheck = runCheck(now).finally(() => {
    inFlightCheck = null;
    useTrailDataStore.getState().setChecking(false);
  });
  return inFlightCheck;
}

async function runCheck(now: number): Promise<TrailDataCheckResult> {
  let catalog: TrailCatalog;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    return {
      checked: false,
      updated: [],
      failed: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  saveState({ ...getState(), catalog, lastCheckedAt: now });

  const plan = planTrailDataSync(catalog, bundledVersions(), getState().installed);
  removeInstalled(plan.remove);

  const updated: string[] = [];
  const failed: string[] = [];
  // One at a time: these are a few hundred KB each, and a phone on a thin
  // connection does better finishing one than starting twenty.
  for (const entry of plan.download) {
    try {
      await downloadTrailEntry(entry);
      updated.push(entry.id);
    } catch (err) {
      failed.push(entry.id);
      console.warn(`[trail-data] update of ${entry.id} failed`, err);
    }
  }

  sweepOrphans();
  return { checked: true, updated, failed };
}

/**
 * Make sure a catalog-only trail is on the device, downloading it if needed —
 * what opening one does. Resolves true when a copy is ready to read. Throws
 * with a user-presentable message when it cannot be fetched.
 */
export async function ensureTrailDownloaded(id: string): Promise<boolean> {
  // A record whose file is gone is dropped by the read, and fetched again below.
  if (activeDownload(id) && (await readDownloadedTrail(id))) return true;
  if (bundledVersions().has(id)) return false; // bundled: nothing to fetch
  // No catalog in this build: there is nowhere such a trail could come from.
  if (!trailDataBaseUrl()) return false;

  let entry = getState().catalog?.trails.find((e) => e.id === id);
  if (!entry) {
    // The list came from an older catalog, or a deep link names a trail this
    // phone has never seen listed: ask the server.
    // Saved without touching `lastCheckedAt`: this is not the update pass, so
    // the next launch/foreground check still brings the other trails up to date.
    const catalog = await fetchCatalog();
    saveState({ ...getState(), catalog });
    entry = catalog.trails.find((e) => e.id === id);
  }
  if (!entry) return false;
  await downloadTrailEntry(entry);
  return true;
}
