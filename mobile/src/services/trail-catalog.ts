/**
 * The trail data catalog and the decisions made from it — pure, no I/O.
 *
 * Trail JSON ships in the app bundle, but a waypoint fix should not need a new
 * build. So the same files are also published to R2 (`publish-trail-data.ts`,
 * runbook `docs/trail-data-updates.md`):
 *
 *   {TILE_BASE_URL}/trails/v1/catalog.json   every published trail + its key
 *   {TILE_BASE_URL}/trails/v1/{key}          one trail's JSON, content-addressed
 *
 * and the app keeps a downloaded copy of any trail whose published version is
 * newer than the one it has (`trail-data-updates.ts` does the I/O).
 *
 * **Ordering is by `updatedAt`, not by difference.** Every copy — bundled,
 * downloaded, published — carries the ISO time its content last changed, and a
 * copy only ever replaces one with an earlier `updatedAt`. "Different from the
 * catalog" would be wrong in both directions: an APK built from data not yet
 * published would be reverted to the older published copy, and a downloaded
 * copy would outlive an app update that bundles something newer.
 *
 * `v1` is the format of the trail JSON itself. A breaking change to that shape
 * publishes under `trails/v2/` and leaves v1 frozen, so a build that reads v1
 * is never handed a file it cannot parse.
 */

/** The trail-JSON format this build reads. Part of the catalog's URL. */
export const TRAIL_DATA_FORMAT = 1;

/**
 * The only id shape allowed to become a file name or URL segment. Also refuses
 * the `u_` prefix, which belongs to user imports: a catalog entry claiming one
 * would shadow a hiker's own guide.
 */
const SAFE_CATALOG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,128}\.json$/;
const MD5 = /^[0-9a-f]{32}$/;

export function isCatalogTrailId(id: string): boolean {
  return SAFE_CATALOG_ID.test(id) && !id.startsWith('u_');
}

/** What the guide list needs to show a trail, from any source. */
export interface TrailVersionInfo {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
  /** ISO time this trail's content last changed. Absent = older than anything. */
  updatedAt?: string;
  /** MD5 of the trail file's exact bytes. */
  md5?: string;
  bytes?: number;
}

/** One published trail. */
export interface CatalogEntry extends TrailVersionInfo {
  updatedAt: string;
  md5: string;
  bytes: number;
  /** Object key under `trails/v{format}/`, e.g. `shikoku.0123456789ab.json`. */
  key: string;
}

export interface TrailCatalog {
  format: number;
  generatedAt: string;
  trails: CatalogEntry[];
}

/** A downloaded trail, as recorded in the on-device state file. */
export interface InstalledTrail extends CatalogEntry {
  /** File name under the trail-data directory. */
  file: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !isCatalogTrailId(e.id)) return null;
  if (typeof e.name !== 'string' || typeof e.shortName !== 'string') return null;
  if (!isFiniteNumber(e.lengthKm)) return null;
  if (typeof e.updatedAt !== 'string' || Number.isNaN(Date.parse(e.updatedAt))) return null;
  if (typeof e.md5 !== 'string' || !MD5.test(e.md5)) return null;
  if (!isFiniteNumber(e.bytes) || e.bytes <= 0) return null;
  if (typeof e.key !== 'string' || !SAFE_KEY.test(e.key)) return null;
  return {
    id: e.id,
    name: e.name,
    shortName: e.shortName,
    lengthKm: e.lengthKm,
    ...(typeof e.dataVersion === 'string' ? { dataVersion: e.dataVersion } : {}),
    updatedAt: e.updatedAt,
    md5: e.md5,
    bytes: e.bytes,
    key: e.key,
  };
}

/**
 * Validate a fetched catalog. Returns null for anything this build cannot use —
 * another format, or not a catalog at all. A malformed *entry* is dropped on
 * its own rather than failing the catalog, so one bad line cannot stop every
 * other trail from updating; a duplicated id keeps its first entry.
 */
export function parseCatalog(raw: unknown): TrailCatalog | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.format !== TRAIL_DATA_FORMAT) return null;
  if (!Array.isArray(c.trails)) return null;
  const seen = new Set<string>();
  const trails: CatalogEntry[] = [];
  for (const rawEntry of c.trails) {
    const entry = parseEntry(rawEntry);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    trails.push(entry);
  }
  return {
    format: TRAIL_DATA_FORMAT,
    generatedAt: typeof c.generatedAt === 'string' ? c.generatedAt : '',
    trails,
  };
}

/** Validate one recorded download (the state file is ours, but disk is disk). */
export function parseInstalled(raw: unknown): InstalledTrail | null {
  const entry = parseEntry(raw);
  if (!entry) return null;
  const file = (raw as Record<string, unknown>).file;
  if (typeof file !== 'string' || !SAFE_KEY.test(file)) return null;
  return { ...entry, file };
}

function timeOf(info: TrailVersionInfo | null | undefined): number {
  if (!info?.updatedAt) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(info.updatedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Whether `candidate` is strictly newer content than `current` (null = nothing). */
export function isNewer(
  candidate: TrailVersionInfo,
  current: TrailVersionInfo | null | undefined,
): boolean {
  if (!current) return true;
  if (candidate.md5 && current.md5 && candidate.md5 === current.md5) return false;
  return timeOf(candidate) > timeOf(current);
}

/**
 * Whether a downloaded copy should be read instead of the bundled one: only
 * when it is newer. An app update that bundles later data wins over an older
 * download without the download having to be deleted first.
 */
export function downloadSupersedesBundle(
  installed: InstalledTrail,
  bundled: TrailVersionInfo | null | undefined,
): boolean {
  return isNewer(installed, bundled);
}

export interface TrailDataSyncPlan {
  /** Entries to download now: updates to a trail the device already has. */
  download: CatalogEntry[];
  /** Downloaded copies to delete: the bundle has caught up with them. */
  remove: string[];
}

/**
 * What to do with a freshly fetched catalog.
 *
 * - A trail the device already has (bundled, or downloaded earlier) is
 *   downloaded again whenever the catalog's copy is newer than the one in use.
 *   That is the automatic update.
 * - A trail only the catalog knows about is NOT downloaded here — it is listed,
 *   and fetched when the hiker opens it (`ensureTrailDownloaded`).
 * - A downloaded copy the bundle has caught up with is deleted.
 * - A downloaded trail the catalog no longer lists is left alone: the hiker
 *   may be relying on it offline, and nothing better exists to replace it.
 */
export function planTrailDataSync(
  catalog: TrailCatalog,
  bundled: ReadonlyMap<string, TrailVersionInfo>,
  installed: Readonly<Record<string, InstalledTrail>>,
): TrailDataSyncPlan {
  const download: CatalogEntry[] = [];
  const remove: string[] = [];

  for (const [id, copy] of Object.entries(installed)) {
    if (!downloadSupersedesBundle(copy, bundled.get(id))) remove.push(id);
  }

  for (const entry of catalog.trails) {
    const bundledCopy = bundled.get(entry.id) ?? null;
    const installedCopy = installed[entry.id];
    const current =
      installedCopy && downloadSupersedesBundle(installedCopy, bundledCopy)
        ? installedCopy
        : bundledCopy;
    if (!current) continue; // catalog-only: fetched on demand
    if (isNewer(entry, current)) download.push(entry);
  }

  return { download, remove };
}

/**
 * The minimum a downloaded file must be before it replaces a working copy: the
 * trail it claims to be, with waypoints and a track. The MD5 check already
 * proved the bytes are the published ones; this catches a publish of the wrong
 * file under the right key.
 */
export function isUsableTrailJson(raw: unknown, id: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as { config?: { id?: unknown }; waypoints?: unknown; track?: { points?: unknown } };
  return (
    t.config?.id === id &&
    Array.isArray(t.waypoints) &&
    !!t.track &&
    Array.isArray(t.track.points) &&
    t.track.points.length > 0
  );
}
