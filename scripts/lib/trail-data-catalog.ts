/**
 * The bundled trail index and the R2 trail-data catalog: the shapes, hashing
 * and merge rules shared by `build-mobile-trails.ts` (which writes
 * `mobile/assets/trails/index.json`) and `publish-trail-data.ts` (which
 * publishes the same files and a catalog of them to R2).
 *
 * The app seeds itself from the bundled index and then takes a remote copy of
 * a trail only when the catalog's `updatedAt` for it is strictly later than
 * the copy it already has. So `updatedAt` must move when — and only when — the
 * bytes of the trail file change: `mergeIndexEntry` keeps the previous stamp
 * while the md5 is unchanged. See docs/trail-data-updates.md.
 *
 * Everything here is pure (no file system, no network) so it can be tested.
 */

import { createHash } from 'crypto';

/**
 * The trail data format version, the `v1` in `trails/v1/`. A breaking change
 * to the trail JSON shape publishes under a new prefix and leaves this one
 * frozen for the app builds that read it.
 */
export const TRAIL_DATA_FORMAT = 1;
export const TRAIL_DATA_PREFIX = `trails/v${TRAIL_DATA_FORMAT}`;
export const CATALOG_KEY = `${TRAIL_DATA_PREFIX}/catalog.json`;

export const CATALOG_CACHE_CONTROL = 'public, max-age=60';
export const TRAIL_FILE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Trail ids the app can key storage and routes on. `u_` is reserved for imports. */
const TRAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;
const DATA_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A full git object name: SHA-1 (40 hex) or SHA-256 (64 hex). */
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What the generated web index says about a trail, before any file is written. */
export interface TrailIndexBase {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  /** ISO country code, for grouping the app's trail list (`@lib/trail-regions`). */
  country?: string;
  /** State/region codes in route order; the list groups a trail under the first. */
  states?: string[];
}

/** One entry of `mobile/assets/trails/index.json`. */
export interface MobileIndexEntry extends TrailIndexBase {
  /** Date part of `updatedAt`. Shown to people; never used for ordering. */
  dataVersion: string;
  /** When this trail's file content (md5) last changed. The app's ordering key. */
  updatedAt: string;
  /** md5 of the exact bytes of `<id>.json`, 32 lowercase hex. */
  md5: string;
  bytes: number;
}

/** One trail in `trails/v1/catalog.json`. */
export interface CatalogTrail extends MobileIndexEntry {
  /** Object key under `trails/v1/`, content-addressed: `<id>.<md5[0..12]>.json`. */
  key: string;
}

export interface TrailCatalog {
  format: number;
  generatedAt: string;
  /**
   * The git commit (`HEAD`) the publish ran from, when it could be read. The
   * next publish refuses to go ahead unless this commit is an ancestor of its
   * own `HEAD` (`sourceCommitVerdict`): a checkout that has not seen the last
   * publish's commit may be publishing older data than is live, whatever its
   * `updatedAt` stamps say. Catalog-level rather than per trail, so a rebuild
   * never rewrites `index.json` just because the commit moved; ignored by
   * `diffCatalogs`, like `generatedAt`. Absent on catalogs published before it.
   */
  sourceCommit?: string;
  trails: CatalogTrail[];
}

export interface FileDigest {
  md5: string;
  bytes: number;
}

/** md5 and size of the exact bytes a trail file is (or will be) written as. */
export function digestTrailFile(content: string | Uint8Array): FileDigest {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    bytes: buffer.byteLength,
  };
}

/**
 * `country`/`states` when the entry has them, and nothing otherwise, so an
 * entry without them keeps the shape it always had.
 */
function listFields(entry: { country?: unknown; states?: unknown }): Pick<TrailIndexBase, 'country' | 'states'> {
  const out: Pick<TrailIndexBase, 'country' | 'states'> = {};
  if (typeof entry.country === 'string') out.country = entry.country;
  if (Array.isArray(entry.states)) out.states = entry.states.filter((s): s is string => typeof s === 'string');
  return out;
}

/**
 * The index entry for a freshly written trail file.
 *
 * Same md5 as the previous entry: the content has not changed, so the previous
 * `updatedAt` and `dataVersion` are kept — re-running the build must not make
 * every phone download every trail again. Otherwise both are stamped `now`.
 * Name, short name and length always come from the new build.
 */
export function mergeIndexEntry(
  base: TrailIndexBase,
  digest: FileDigest,
  previous: Partial<MobileIndexEntry> | undefined,
  now: Date
): MobileIndexEntry {
  const unchanged =
    previous !== undefined &&
    previous.md5 === digest.md5 &&
    typeof previous.updatedAt === 'string' &&
    typeof previous.dataVersion === 'string';
  const updatedAt = unchanged ? (previous.updatedAt as string) : now.toISOString();
  const dataVersion = unchanged ? (previous.dataVersion as string) : updatedAt.slice(0, 10);
  return {
    id: base.id,
    name: base.name,
    shortName: base.shortName,
    lengthKm: base.lengthKm,
    ...listFields(base),
    dataVersion,
    updatedAt,
    md5: digest.md5,
    bytes: digest.bytes,
  };
}

/**
 * Read a previous index.json's text into a lookup by id. Anything that is not
 * an array of objects with a string `id` (a missing file, an old format, a
 * hand-mangled file) yields an empty map, which stamps every trail as changed.
 */
export function previousIndexById(text: string | undefined): Map<string, Partial<MobileIndexEntry>> {
  const byId = new Map<string, Partial<MobileIndexEntry>>();
  if (text === undefined) return byId;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return byId;
  }
  if (!Array.isArray(parsed)) return byId;
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      byId.set((entry as { id: string }).id, entry as Partial<MobileIndexEntry>);
    }
  }
  return byId;
}

/** Serialise the index exactly as build-mobile-trails writes it (2-space, no trailing newline). */
export function serializeIndex(index: MobileIndexEntry[]): string {
  return JSON.stringify(index, null, 2);
}

/** The content-addressed object name of a trail file, relative to `trails/v1/`. */
export function catalogKey(id: string, md5: string): string {
  return `${id}.${md5.slice(0, 12)}.json`;
}

/**
 * The catalog for an index, trails in index order. `sourceCommit` is written
 * only when known, so a publish without git produces the same shape as before.
 */
export function buildCatalog(
  index: MobileIndexEntry[],
  generatedAt: Date,
  sourceCommit?: string | null
): TrailCatalog {
  return {
    format: TRAIL_DATA_FORMAT,
    generatedAt: generatedAt.toISOString(),
    ...(sourceCommit ? { sourceCommit } : {}),
    trails: index.map(entry => ({
      id: entry.id,
      name: entry.name,
      shortName: entry.shortName,
      lengthKm: entry.lengthKm,
      ...listFields(entry),
      dataVersion: entry.dataVersion,
      updatedAt: entry.updatedAt,
      md5: entry.md5,
      bytes: entry.bytes,
      key: catalogKey(entry.id, entry.md5),
    })),
  };
}

/** Why a trail id cannot be published, or `null` when it can. */
export function trailIdProblem(id: unknown): string | null {
  if (typeof id !== 'string' || !TRAIL_ID_RE.test(id)) {
    return `trail id ${JSON.stringify(id)} must match ${TRAIL_ID_RE}`;
  }
  if (id.startsWith('u_')) {
    return `trail id "${id}" starts with "u_", which is reserved for trails imported on the device`;
  }
  return null;
}

/** Every problem with one index entry's shape (not its file). */
export function indexEntryProblems(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return ['index entry is not an object'];
  const e = entry as Record<string, unknown>;
  const label = typeof e.id === 'string' ? e.id : JSON.stringify(e.id);
  const problems: string[] = [];
  const idProblem = trailIdProblem(e.id);
  if (idProblem) problems.push(idProblem);
  if (typeof e.name !== 'string' || e.name === '') problems.push(`${label}: name must be a non-empty string`);
  if (typeof e.shortName !== 'string' || e.shortName === '') problems.push(`${label}: shortName must be a non-empty string`);
  if (typeof e.lengthKm !== 'number' || !Number.isFinite(e.lengthKm)) problems.push(`${label}: lengthKm must be a number`);
  if (e.country !== undefined && (typeof e.country !== 'string' || !/^[A-Z]{2}$/.test(e.country))) problems.push(`${label}: country must be a two-letter upper-case code`);
  if (e.states !== undefined && (!Array.isArray(e.states) || !e.states.every((st) => typeof st === 'string'))) problems.push(`${label}: states must be an array of strings`);
  if (typeof e.dataVersion !== 'string' || !DATA_VERSION_RE.test(e.dataVersion)) {
    problems.push(`${label}: dataVersion must be YYYY-MM-DD`);
  }
  if (typeof e.updatedAt !== 'string' || Number.isNaN(Date.parse(e.updatedAt))) {
    problems.push(`${label}: updatedAt must be an ISO timestamp`);
  }
  if (typeof e.md5 !== 'string' || !MD5_RE.test(e.md5)) problems.push(`${label}: md5 must be 32 lowercase hex characters`);
  if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes <= 0) {
    problems.push(`${label}: bytes must be a positive integer`);
  }
  return problems;
}

/** Every problem with a whole index: entry shapes plus duplicate ids. */
export function indexProblems(index: unknown): string[] {
  if (!Array.isArray(index)) return ['index.json is not an array'];
  if (index.length === 0) return ['index.json lists no trails'];
  const problems = index.flatMap(indexEntryProblems);
  const seen = new Set<string>();
  for (const entry of index as { id?: unknown }[]) {
    if (typeof entry?.id !== 'string') continue;
    if (seen.has(entry.id)) problems.push(`trail id "${entry.id}" is listed twice`);
    seen.add(entry.id);
  }
  return problems;
}

/**
 * Every problem with a trail file's parsed content: the minimum the app needs
 * before it will swap a downloaded file in for the bundled one.
 */
export function trailFileProblems(id: string, parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [`${id}.json: not a JSON object`];
  }
  const trail = parsed as { config?: { id?: unknown }; waypoints?: unknown; track?: { points?: unknown } };
  const problems: string[] = [];
  if (trail.config?.id !== id) {
    problems.push(`${id}.json: config.id is ${JSON.stringify(trail.config?.id)}, expected "${id}"`);
  }
  if (!Array.isArray(trail.waypoints)) problems.push(`${id}.json: waypoints is not an array`);
  const points = trail.track?.points;
  if (!Array.isArray(points)) problems.push(`${id}.json: track.points is not an array`);
  // The app refuses a trail with no track points, so publishing one would only
  // have every phone download it and throw it away on each check.
  else if (points.length === 0) problems.push(`${id}.json: track.points is empty`);
  return problems;
}

/**
 * Read a fetched catalog. Throws on anything that is not a format-1 catalog,
 * so a publish never builds its plan on top of a catalog it misread.
 */
export function parseCatalog(text: string): TrailCatalog {
  const parsed = JSON.parse(text) as Partial<TrailCatalog>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('catalog is not a JSON object');
  }
  if (parsed.format !== TRAIL_DATA_FORMAT) {
    throw new Error(`catalog format is ${JSON.stringify(parsed.format)}, expected ${TRAIL_DATA_FORMAT}`);
  }
  if (!Array.isArray(parsed.trails)) throw new Error('catalog has no trails array');
  if (
    parsed.sourceCommit !== undefined &&
    (typeof parsed.sourceCommit !== 'string' || !COMMIT_RE.test(parsed.sourceCommit))
  ) {
    throw new Error(`catalog sourceCommit ${JSON.stringify(parsed.sourceCommit)} is not a git commit id`);
  }
  for (const trail of parsed.trails) {
    if (!trail || typeof trail.id !== 'string' || typeof trail.key !== 'string') {
      throw new Error(`catalog entry ${JSON.stringify(trail)} has no id/key`);
    }
  }
  return parsed as TrailCatalog;
}

/** The fields of a catalog trail that matter for "has anything changed?" — all of them. */
function trailSignature(trail: CatalogTrail): string {
  return JSON.stringify([
    trail.id,
    trail.name,
    trail.shortName,
    trail.lengthKm,
    trail.country ?? null,
    trail.states ?? null,
    trail.dataVersion,
    trail.updatedAt,
    trail.md5,
    trail.bytes,
    trail.key,
  ]);
}

export interface CatalogDiff {
  /** In the local catalog, not the live one. */
  added: string[];
  /** In both, with any field different. */
  changed: string[];
  /** In the live catalog, not the local one. */
  removed: string[];
  /** The trails are the same but listed in a different order. */
  reordered: boolean;
}

/** How a local catalog differs from the live one (`generatedAt` and `sourceCommit` are ignored). */
export function diffCatalogs(local: TrailCatalog, live: TrailCatalog | null): CatalogDiff {
  const liveTrails = live?.trails ?? [];
  const liveById = new Map(liveTrails.map(trail => [trail.id, trail]));
  const localIds = new Set(local.trails.map(trail => trail.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const trail of local.trails) {
    const remote = liveById.get(trail.id);
    if (!remote) added.push(trail.id);
    else if (trailSignature(remote) !== trailSignature(trail)) changed.push(trail.id);
  }
  const removed = liveTrails.filter(trail => !localIds.has(trail.id)).map(trail => trail.id);
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    local.trails.some((trail, i) => liveTrails[i]?.id !== trail.id);
  return { added, changed, removed, reordered };
}

export function catalogsDiffer(diff: CatalogDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0 || diff.reordered;
}

export interface UploadPlan {
  /** Trail files to upload, in catalog order. */
  files: CatalogTrail[];
  /** Whether to upload the catalog (always last). */
  uploadCatalog: boolean;
  diff: CatalogDiff;
}

/**
 * What a publish has to upload. A trail file whose content-addressed key the
 * live catalog already lists is already in the bucket, so only new keys go up;
 * `all` re-uploads every file. The catalog goes up when anything about it
 * differs (or with `all`).
 */
export function planUpload(local: TrailCatalog, live: TrailCatalog | null, options: { all?: boolean } = {}): UploadPlan {
  const liveKeys = new Set((live?.trails ?? []).map(trail => trail.key));
  const diff = diffCatalogs(local, live);
  return {
    files: options.all ? [...local.trails] : local.trails.filter(trail => !liveKeys.has(trail.key)),
    uploadCatalog: Boolean(options.all) || catalogsDiffer(diff),
    diff,
  };
}

/**
 * Trails the live catalog lists that this publish would drop, minus the ones
 * the operator named with `--remove <id>`. Dropping a trail from the catalog
 * takes it off every phone's list of downloadable trails, and the usual cause
 * is not intent but a checkout that predates the trail being added — so it is
 * refused unless asked for by name (or with `--force`).
 */
export function unapprovedRemovals(diff: CatalogDiff, approved: ReadonlySet<string>): string[] {
  return diff.removed.filter(id => !approved.has(id));
}

/** What the source-commit guard decided, and why. */
export type SourceCommitVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; message: string }
  | { kind: 'refuse'; message: string };

/**
 * Whether a publish from `head` may replace a live catalog published from
 * `liveCommit`.
 *
 * The `updatedAt` rollback check (`rollbacks` in publish-trail-data.ts) only
 * catches a local copy that is OLDER; a stale checkout that rebuilds stamps
 * every changed file `now` and sails through it, reverting newer live data.
 * Ancestry catches that: if the live publish's commit is not in this
 * checkout's history, this checkout has not seen what is live.
 *
 * - No commit recorded live (first publish, or a catalog from before this
 *   field): nothing to compare, ok.
 * - `head` unknown (git missing, not a repository): warn and carry on — the
 *   guard is best-effort and must not make publishing impossible without git.
 * - `isAncestor` true: ok. False: refuse. Null (git could not answer, usually
 *   because the commit is not in this clone at all): refuse — that is the
 *   stale-checkout case in its plainest form.
 */
export function sourceCommitVerdict(
  liveCommit: string | undefined,
  head: string | null,
  isAncestor: boolean | null
): SourceCommitVerdict {
  if (!liveCommit) return { kind: 'ok' };
  if (!head) {
    return {
      kind: 'warn',
      message: `could not read this checkout's git HEAD, so cannot confirm it contains the live publish (${liveCommit})`,
    };
  }
  if (liveCommit === head || isAncestor === true) return { kind: 'ok' };
  if (isAncestor === false) {
    return {
      kind: 'refuse',
      message: `the live catalog was published from ${liveCommit}, which is not an ancestor of HEAD ${head}`,
    };
  }
  return {
    kind: 'refuse',
    message: `the live catalog was published from ${liveCommit}, which this clone does not have (git fetch?)`,
  };
}

/**
 * The comments API's `ALLOWED_TRAILS`, read from the worker's source text
 * (importing the worker would pull its Cloudflare types into this project).
 */
export function parseAllowedTrails(validationSource: string): string[] {
  const literal = validationSource.match(/ALLOWED_TRAILS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!literal) throw new Error('ALLOWED_TRAILS array literal not found');
  return [...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
}
