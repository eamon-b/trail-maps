/**
 * Delete offline-pack objects no live manifest references (issue #158).
 *
 *   npm run cleanup:tiles                       # dry run: print what would go
 *   npm run cleanup:tiles -- --delete           # delete it
 *   npm run cleanup:tiles -- --grace-days 14    # keep anything newer than 14 days (default 7)
 *   npm run cleanup:tiles -- --world-build      # dry run over contours/world-build/ instead
 *   npm run cleanup:tiles -- --world-build --delete
 *
 * `upload-tiles.sh` writes each pack file at a content-addressed key
 * (`base.<sha256[0..12]>.mbtiles`) and publishes the manifest last, so a
 * rebuilt pack leaves the previous build's objects in the bucket: a phone that
 * fetched the old manifest a moment before keeps downloading them. Once every
 * phone has moved on they are dead weight — the #135 rebuild supersedes about
 * 2 GB of packs at once.
 *
 * What it deletes, per pack prefix (`<trail>/`): every
 * `.mbtiles` object directly under the prefix that the live `manifest.json`
 * there does not list, by content-addressed key or by plain name (old app
 * builds download the plain name), once that manifest has been live for
 * `--grace-days` (a download started against the previous manifest finishes
 * in hours; the grace is the margin). It never touches a prefix whose
 * manifest is missing, unreadable or younger than the grace, an object
 * younger than the grace, an object in a sub-directory, anything but
 * `.mbtiles`, the manifest itself, or any other prefix of the bucket
 * (`contours/`, `trails/v1/`, …). The manifest is read from the bucket, not
 * through the edge cache, so it is the one phones get next. Do not run it
 * during an upload.
 *
 * `--world-build` lists `contours/world-build/` (the world contour build's
 * batches and shards, streamed to R2 as insurance), all of which goes once
 * `world.pmtiles` is verified (runbook: contours/docs/world-contours-remote-build.md).
 * It refuses unless `contours/world.pmtiles` is newer than everything under
 * the prefix, and keeps what is younger than the grace.
 *
 * Dry run by default; `--delete` deletes. Needs rclone with an R2 remote
 * (`RCLONE_REMOTE`, default `r2`; Object Read & Write on the bucket) — the
 * same remote `upload-tiles.sh` uses for packs over wrangler's size limit.
 * wrangler cannot list a bucket.
 */

import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const BUCKET = process.env.R2_BUCKET || 'tracknotes-data';
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || 'r2';
const DEFAULT_GRACE_DAYS = 7;
const WORLD_BUILD_PREFIX = 'contours/world-build/';
const WORLD_ARCHIVE_KEY = 'contours/world.pmtiles';

/** One object of a bucket listing (rclone lsjson's fields we use). */
export interface BucketObject {
  /** Key relative to the bucket root. */
  path: string;
  size: number;
  /** ISO timestamp. */
  modTime: string;
}

export interface CleanupPlan {
  /** Objects to delete. */
  delete: BucketObject[];
  /** Unreferenced objects kept because they are newer than the grace period. */
  keptRecent: BucketObject[];
  /** Pack prefixes checked (those with a readable manifest). */
  prefixes: string[];
  /** Prefixes skipped, and why: never delete beside a manifest we cannot read. */
  skipped: Array<{ prefix: string; reason: string }>;
}

/**
 * The pack prefixes of a listing: every top-level directory holding a
 * `manifest.json` (`<trail>/`).
 */
export function packPrefixes(objects: BucketObject[]): string[] {
  const prefixes = new Set<string>();
  for (const o of objects) {
    const m = o.path.match(/^([^/]+\/)manifest\.json$/);
    if (m) prefixes.add(m[1]);
  }
  return [...prefixes].sort();
}

/**
 * The object names (relative to its prefix) a manifest references: each
 * file's content-addressed `key` *and* its plain `name`. The plain name
 * stays live: app builds from before content addressing (~2026-10-10, no
 * over-the-air updates) always download it, and a current build falls back
 * to it when it cannot read the manifest (`tile-service.ts`
 * `remoteKeys.get(name) ?? name`). Throws on a manifest that is not one, so
 * the caller skips that prefix.
 */
export function referencedNames(manifest: unknown): Set<string> {
  const files = (manifest as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('manifest lists no files');
  const names = new Set<string>();
  for (const file of files) {
    const f = file as { name?: unknown; key?: unknown };
    const keys = [f.name, ...(f.key === undefined ? [] : [f.key])];
    for (const name of keys) {
      if (typeof name !== 'string' || name === '' || name.includes('/')) {
        throw new Error(`manifest has an invalid file entry ${JSON.stringify(file)}`);
      }
      names.add(name);
    }
  }
  return names;
}

/**
 * Which objects to delete. `manifests` maps each prefix to its parsed live
 * manifest, or to an Error when it could not be read.
 *
 * The grace runs from when an object was *superseded* — when the manifest
 * that dropped it was published — not from its own age: a pack uploaded a
 * month ago and superseded a minute ago is still being downloaded by phones
 * that read the previous manifest (or an edge-cached copy). So a prefix whose
 * manifest is younger than the grace is left alone entirely. An object itself
 * younger than the grace is kept too: the payload of an upload still running,
 * whose manifest (published last) does not name it yet.
 */
export function planCleanup(
  objects: BucketObject[],
  manifests: Map<string, unknown>,
  options: { now: number; graceDays: number }
): CleanupPlan {
  const plan: CleanupPlan = { delete: [], keptRecent: [], prefixes: [], skipped: [] };
  const cutoff = options.now - options.graceDays * 86_400_000;
  for (const prefix of packPrefixes(objects)) {
    const manifest = manifests.get(prefix);
    let referenced: Set<string>;
    try {
      if (manifest === undefined) throw new Error('manifest not read');
      if (manifest instanceof Error) throw manifest;
      referenced = referencedNames(manifest);
    } catch (e) {
      plan.skipped.push({ prefix, reason: (e as Error).message });
      continue;
    }
    const manifestObject = objects.find(o => o.path === `${prefix}manifest.json`);
    const published = manifestObject ? Date.parse(manifestObject.modTime) : NaN;
    if (!Number.isFinite(published) || published > cutoff) {
      plan.skipped.push({
        prefix,
        reason:
          `manifest published ${manifestObject?.modTime.slice(0, 10) ?? 'at an unknown time'}, ` +
          `inside the ${options.graceDays}-day grace`,
      });
      continue;
    }
    plan.prefixes.push(prefix);
    for (const o of objects) {
      if (!o.path.startsWith(prefix)) continue;
      const name = o.path.slice(prefix.length);
      if (name.includes('/') || !name.endsWith('.mbtiles') || referenced.has(name)) continue;
      const modified = Date.parse(o.modTime);
      if (!Number.isFinite(modified) || modified > cutoff) plan.keptRecent.push(o);
      else plan.delete.push(o);
    }
  }
  return plan;
}

export interface WorldBuildPlan {
  delete: BucketObject[];
  /** Objects inside the grace, kept. */
  keptRecent: BucketObject[];
  /** Why nothing may be deleted, when nothing may. */
  refused?: string;
}

/**
 * Which of `contours/world-build/` to delete. The prefix is the world build's
 * insurance copy of its batches and shards, so it may go only once the
 * archive built from them is published: `contours/world.pmtiles` must exist
 * and be newer than every object under the prefix (a build still streaming
 * batches, or one whose archive is not uploaded yet, is refused). Objects
 * younger than the grace are kept regardless.
 */
export function planWorldBuildCleanup(
  objects: BucketObject[],
  archive: BucketObject | null,
  options: { now: number; graceDays: number }
): WorldBuildPlan {
  const plan: WorldBuildPlan = { delete: [], keptRecent: [] };
  if (!archive) {
    return { ...plan, refused: `${WORLD_ARCHIVE_KEY} is not in the bucket: the build is not published yet` };
  }
  const archiveTime = Date.parse(archive.modTime);
  const newer = objects.filter(o => !(Date.parse(o.modTime) < archiveTime));
  if (!Number.isFinite(archiveTime) || newer.length > 0) {
    return {
      ...plan,
      refused:
        `${newer.length} object(s) under ${WORLD_BUILD_PREFIX} are not older than ${WORLD_ARCHIVE_KEY} ` +
        `(${archive.modTime}), e.g. ${newer[0]?.path ?? '?'}: a build may still be running, or the archive predates it`,
    };
  }
  const cutoff = options.now - options.graceDays * 86_400_000;
  for (const o of objects) {
    if (Date.parse(o.modTime) > cutoff) plan.keptRecent.push(o);
    else plan.delete.push(o);
  }
  return plan;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function rclone(args: string[]): string {
  const result = spawnSync('rclone', ['--s3-no-check-bucket', ...args], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`rclone not runnable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`rclone ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function listObjects(prefix = '', { recursive = true } = {}): BucketObject[] {
  const entries = JSON.parse(
    rclone(['lsjson', ...(recursive ? ['-R'] : []), '--files-only', `${RCLONE_REMOTE}:${BUCKET}/${prefix}`])
  ) as Array<{ Path: string; Size: number; ModTime: string }>;
  return entries.map(e => ({ path: prefix + e.Path, size: e.Size, modTime: e.ModTime }));
}

function readManifest(prefix: string): unknown {
  try {
    return JSON.parse(rclone(['cat', `${RCLONE_REMOTE}:${BUCKET}/${prefix}manifest.json`]));
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

function deleteObjects(objects: BucketObject[]): void {
  for (const o of objects) {
    rclone(['deletefile', `${RCLONE_REMOTE}:${BUCKET}/${o.path}`]);
    console.log(`  deleted ${o.path}`);
  }
}

function printObjects(objects: BucketObject[]): void {
  for (const o of objects) console.log(`  ${o.path}  ${formatBytes(o.size)}  ${o.modTime.slice(0, 10)}`);
}

interface Args {
  delete: boolean;
  graceDays: number;
  worldBuild: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { delete: false, graceDays: DEFAULT_GRACE_DAYS, worldBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--delete') args.delete = true;
    else if (arg === '--world-build') args.worldBuild = true;
    else if (arg === '--grace-days') {
      const days = Number(argv[++i]);
      if (!Number.isFinite(days) || days < 0) throw new Error('--grace-days takes a number of days ≥ 0');
      args.graceDays = days;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run cleanup:tiles -- [--delete] [--grace-days N] [--world-build]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.delete ? 'DELETING' : 'Dry run (pass --delete to delete)';

  if (args.worldBuild) {
    const objects = listObjects(WORLD_BUILD_PREFIX);
    const archive = listObjects('contours/', { recursive: false }).find(o => o.path === WORLD_ARCHIVE_KEY) ?? null;
    const plan = planWorldBuildCleanup(objects, archive, { now: Date.now(), graceDays: args.graceDays });
    if (plan.refused) throw new Error(`not deleting ${WORLD_BUILD_PREFIX}: ${plan.refused}`);
    if (plan.keptRecent.length > 0) {
      console.log(`Newer than ${args.graceDays} days, kept (${plan.keptRecent.length}):`);
      printObjects(plan.keptRecent);
    }
    const total = plan.delete.reduce((a, o) => a + o.size, 0);
    console.log(`${mode}: ${plan.delete.length} objects (${formatBytes(total)}) under ${BUCKET}/${WORLD_BUILD_PREFIX}`);
    printObjects(plan.delete);
    if (args.delete) deleteObjects(plan.delete);
    return;
  }

  console.log(`Listing ${RCLONE_REMOTE}:${BUCKET}...`);
  const objects = listObjects();
  const manifests = new Map<string, unknown>();
  for (const prefix of packPrefixes(objects)) manifests.set(prefix, readManifest(prefix));
  const plan = planCleanup(objects, manifests, { now: Date.now(), graceDays: args.graceDays });

  console.log(`Checked ${plan.prefixes.length} pack prefixes.`);
  for (const s of plan.skipped) console.log(`  ⚠ skipped ${s.prefix}: ${s.reason}`);
  if (plan.keptRecent.length > 0) {
    console.log(`\nUnreferenced but newer than ${args.graceDays} days, kept (${plan.keptRecent.length}):`);
    printObjects(plan.keptRecent);
  }
  const total = plan.delete.reduce((a, o) => a + o.size, 0);
  console.log(`\n${mode}: ${plan.delete.length} superseded objects (${formatBytes(total)})`);
  printObjects(plan.delete);
  if (args.delete) deleteObjects(plan.delete);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    main();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
