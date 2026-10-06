/**
 * Publish the app's trail data to R2, so a phone picks up a waypoint fix
 * without a new APK. Runbook: docs/trail-data-updates.md.
 *
 * Reads `mobile/assets/trails/index.json` (written by `build-mobile-trails.ts`)
 * and every file it lists, checks the index describes those files exactly,
 * then uploads to the `aus-map-data` bucket (public at
 * https://data.contour-map-tiles.net):
 *
 *   trails/v1/<id>.<md5[0..12]>.json   each trail file, content-addressed, immutable
 *   trails/v1/catalog.json             the catalog of them — uploaded LAST
 *
 * The catalog is the commit point, as the tile manifest is in upload-tiles.sh:
 * trail files go to keys named by their content, so a published catalog never
 * points at bytes that get overwritten, and a failure part-way leaves the live
 * catalog (and every phone) on the previous consistent set. Only files whose
 * key the live catalog does not list yet are uploaded.
 *
 * Usage:
 *   npm run publish:trail-data -- --dry-run   # print the plan, upload nothing
 *   npm run publish:trail-data                # upload new files, then the catalog
 *   npm run publish:trail-data -- --all       # re-upload every file and the catalog
 *   npm run publish:trail-data -- --check     # exit 1 if the live catalog differs
 *   npm run publish:trail-data -- --remove <id>  # allow dropping that trail from the catalog
 *   npm run publish:trail-data -- --force     # publish past every guard below
 *
 * Guards, each refusing the publish unless `--force`:
 *   - a trail whose live `updatedAt` is later than the local one (`rollbacks`);
 *   - the live catalog was published from a git commit that is not an
 *     ancestor of this checkout's HEAD (`sourceCommitVerdict`) — the stale
 *     checkout that rebuilt, so its stamps are new but its data is old. The
 *     catalog records the HEAD it was published from as `sourceCommit`; with
 *     no git available the guard warns and lets the publish through;
 *   - a trail the live catalog has and this checkout does not, unless named
 *     with `--remove <id>` (`unapprovedRemovals`).
 * `--dry-run` reports the same refusals; `--check` only compares.
 *
 * Env: R2_BUCKET (default aus-map-data), TRAIL_DATA_BASE_URL (default
 * https://data.contour-map-tiles.net). Uploads need `wrangler` on PATH and
 * logged in (`wrangler login`).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  CATALOG_CACHE_CONTROL,
  CATALOG_KEY,
  TRAIL_DATA_PREFIX,
  TRAIL_FILE_CACHE_CONTROL,
  buildCatalog,
  catalogsDiffer,
  diffCatalogs,
  digestTrailFile,
  indexProblems,
  parseAllowedTrails,
  parseCatalog,
  planUpload,
  sourceCommitVerdict,
  trailFileProblems,
  unapprovedRemovals,
  type CatalogDiff,
  type MobileIndexEntry,
  type TrailCatalog,
} from './lib/trail-data-catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, '..');
const MOBILE_TRAILS_DIR = path.join(ROOT, 'mobile', 'assets', 'trails');
const VALIDATION_SOURCE = path.join(ROOT, 'workers', 'comments-api', 'src', 'validation.ts');

const DEFAULT_BASE_URL = 'https://data.contour-map-tiles.net';
const DEFAULT_BUCKET = 'aus-map-data';

export interface PublishOptions {
  all: boolean;
  dryRun: boolean;
  check: boolean;
  force: boolean;
  /** Trail ids `--remove` allows this publish to drop from the live catalog. */
  remove: string[];
}

export function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = { all: false, dryRun: false, check: false, force: false, remove: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--remove' || arg.startsWith('--remove=')) {
      const id = arg === '--remove' ? argv[++i] : arg.slice('--remove='.length);
      if (!id || id.startsWith('-')) throw new Error('--remove requires a trail id');
      options.remove.push(id);
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)} (expected --all, --dry-run, --check, --force or --remove <id>)`
      );
    }
  }
  return options;
}

/** Run git in the repository; null when git is missing or the command fails to start. */
function git(args: string[]): { status: number | null; stdout: string } | null {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  if (result.error) return null;
  return { status: result.status, stdout: result.stdout ?? '' };
}

/** This checkout's HEAD commit, or null when git cannot say (best-effort). */
export function gitHead(): string | null {
  const result = git(['rev-parse', 'HEAD']);
  if (!result || result.status !== 0) return null;
  const head = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
}

/**
 * Whether `ancestor` is in `head`'s history: `git merge-base --is-ancestor`
 * exits 0 for yes and 1 for no; anything else (an unknown commit, no git) is
 * null, "could not tell".
 */
export function gitIsAncestor(ancestor: string, head: string): boolean | null {
  const result = git(['merge-base', '--is-ancestor', ancestor, head]);
  if (!result) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/** A trail file's bytes, keyed by trail id. Injected so the checks are testable. */
export type ReadTrailFile = (id: string) => Buffer | undefined;

/**
 * Every problem with the local index and the files it lists: the index's own
 * shape, any file whose md5/size the index does not match, and any file that
 * is not a trail the app could load.
 */
export function localDataProblems(index: unknown, readFile: ReadTrailFile): string[] {
  const shapeProblems = indexProblems(index);
  if (shapeProblems.length > 0) return shapeProblems;

  const problems: string[] = [];
  for (const entry of index as MobileIndexEntry[]) {
    const bytes = readFile(entry.id);
    if (!bytes) {
      problems.push(`${entry.id}.json: listed in index.json but missing`);
      continue;
    }
    const digest = digestTrailFile(bytes);
    if (digest.md5 !== entry.md5 || digest.bytes !== entry.bytes) {
      problems.push(
        `${entry.id}.json: index.json says md5 ${entry.md5} / ${entry.bytes} bytes, ` +
          `the file is ${digest.md5} / ${digest.bytes} bytes`
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf-8'));
    } catch (error) {
      problems.push(`${entry.id}.json: not valid JSON (${(error as Error).message})`);
      continue;
    }
    problems.push(...trailFileProblems(entry.id, parsed));
  }
  return problems;
}

/**
 * Trails the local data would roll back: listed live with a later `updatedAt`
 * than the local copy. A publish from a stale checkout would otherwise hand
 * fresh installs older data than the phones that already updated.
 */
export function rollbacks(local: TrailCatalog, live: TrailCatalog | null): string[] {
  const liveById = new Map((live?.trails ?? []).map(trail => [trail.id, trail]));
  const lines: string[] = [];
  for (const trail of local.trails) {
    const before = liveById.get(trail.id);
    if (!before || before.md5 === trail.md5) continue;
    if (Date.parse(trail.updatedAt) < Date.parse(before.updatedAt)) {
      lines.push(`  ${trail.id}: live ${before.updatedAt}, local ${trail.updatedAt}`);
    }
  }
  return lines;
}

/** One line per trail the diff names, for --check and --dry-run output. */
export function describeDiff(diff: CatalogDiff, local: TrailCatalog, live: TrailCatalog | null): string[] {
  const liveById = new Map((live?.trails ?? []).map(trail => [trail.id, trail]));
  const localById = new Map(local.trails.map(trail => [trail.id, trail]));
  const lines: string[] = [];
  for (const id of diff.added) {
    const trail = localById.get(id)!;
    lines.push(`  + ${id}: new (${trail.key}, updatedAt ${trail.updatedAt})`);
  }
  for (const id of diff.changed) {
    const before = liveById.get(id)!;
    const after = localById.get(id)!;
    const fields = (Object.keys(after) as (keyof typeof after)[]).filter(
      field => JSON.stringify(before[field]) !== JSON.stringify(after[field])
    );
    lines.push(
      `  ~ ${id}: ${fields.map(field => `${field} ${JSON.stringify(before[field])} -> ${JSON.stringify(after[field])}`).join(', ')}`
    );
  }
  for (const id of diff.removed) lines.push(`  - ${id}: in the live catalog, not in index.json`);
  if (diff.reordered) lines.push('  (same trails, different order)');
  return lines;
}

async function fetchLiveCatalog(baseUrl: string): Promise<TrailCatalog | null> {
  // The catalog is cached at the edge for 60 s; a query string is its own cache
  // key, so this reads what is in the bucket now rather than a minute ago.
  const url = `${baseUrl.replace(/\/+$/, '')}/${CATALOG_KEY}?t=${Date.now()}`;
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }
  return parseCatalog(await response.text());
}

function requireWrangler(): void {
  const probe = spawnSync('wrangler', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      'wrangler not found (or not runnable). Install it with `npm install -g wrangler` and run `wrangler login`.'
    );
  }
}

function putObject(bucket: string, key: string, file: string, cacheControl: string): void {
  console.log(`  Uploading ${key}`);
  const result = spawnSync(
    'wrangler',
    [
      'r2', 'object', 'put', `${bucket}/${key}`,
      '--remote',
      '--file', file,
      '--content-type', 'application/json',
      '--cache-control', cacheControl,
    ],
    { stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler r2 object put ${bucket}/${key} exited with status ${result.status}`);
  }
}

function warnAboutCommentsAllowlist(ids: string[]): void {
  let allowed: string[];
  try {
    allowed = parseAllowedTrails(fs.readFileSync(VALIDATION_SOURCE, 'utf-8'));
  } catch (error) {
    console.warn(`Warning: could not read ALLOWED_TRAILS from ${VALIDATION_SOURCE}: ${(error as Error).message}`);
    return;
  }
  for (const id of ids.filter(id => !allowed.includes(id))) {
    console.warn(
      `Warning: "${id}" is not in the comments API's ALLOWED_TRAILS ` +
        '(workers/comments-api/src/validation.ts). Comment sync for it will be rejected ' +
        'until it is added and the comments worker is redeployed.'
    );
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const baseUrl = process.env.TRAIL_DATA_BASE_URL ?? DEFAULT_BASE_URL;
  const bucket = process.env.R2_BUCKET ?? DEFAULT_BUCKET;

  const indexPath = path.join(MOBILE_TRAILS_DIR, 'index.json');
  const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const readFile: ReadTrailFile = id => {
    const file = path.join(MOBILE_TRAILS_DIR, `${id}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  };

  const problems = localDataProblems(index, readFile);
  if (problems.length > 0) {
    console.error(`${indexPath} does not describe the trail files next to it:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Run `npm run build:mobile-trails` to regenerate the files and the index, then retry.');
    return 1;
  }
  const entries = index as MobileIndexEntry[];
  warnAboutCommentsAllowlist(entries.map(entry => entry.id));

  const head = gitHead();
  const local = buildCatalog(entries, new Date(), head);
  console.log(`Local: ${local.trails.length} trails in ${indexPath}` + (head ? ` (HEAD ${head})` : ''));

  const live = await fetchLiveCatalog(baseUrl);
  console.log(
    live
      ? `Live:  ${live.trails.length} trails in ${baseUrl}/${CATALOG_KEY} (generated ${live.generatedAt})`
      : `Live:  no catalog at ${baseUrl}/${CATALOG_KEY} yet`
  );

  if (options.check) {
    const diff = diffCatalogs(local, live);
    if (!catalogsDiffer(diff)) {
      console.log('The live catalog matches the local trail data.');
      return 0;
    }
    console.error('The live catalog differs from the local trail data:');
    for (const line of describeDiff(diff, local, live)) console.error(line);
    console.error('Publish with `npm run publish:trail-data`.');
    return 1;
  }

  const rolledBack = rollbacks(local, live);
  if (rolledBack.length > 0 && !options.force) {
    console.error('The live catalog has newer data for these trails than this checkout:');
    for (const line of rolledBack) console.error(line);
    console.error('Pull and rebuild first, or pass --force to publish the older data anyway.');
    return 1;
  }

  // The rollback check above only sees stamps, and a stale checkout that
  // rebuilt has fresh ones; ancestry is what tells it apart.
  const liveCommit = live?.sourceCommit;
  const verdict = sourceCommitVerdict(
    liveCommit,
    head,
    liveCommit && head ? gitIsAncestor(liveCommit, head) : null
  );
  if (verdict.kind === 'warn') {
    console.warn(`Warning: ${verdict.message}.`);
  } else if (verdict.kind === 'refuse' && !options.force) {
    console.error(`Refusing to publish: ${verdict.message}.`);
    console.error('This checkout may not contain the data that is live. Pull (and rebuild), or pass --force.');
    return 1;
  }

  const plan = planUpload(local, live, { all: options.all });

  const removals = unapprovedRemovals(plan.diff, new Set(options.remove));
  if (removals.length > 0 && !options.force) {
    console.error('This publish would remove trails the live catalog lists:');
    for (const id of removals) console.error(`  - ${id}`);
    console.error(
      'If that is intended, name each one: ' +
        removals.map(id => `--remove ${id}`).join(' ') +
        ' (or pass --force).'
    );
    return 1;
  }

  const diffLines = describeDiff(plan.diff, local, live);
  if (diffLines.length > 0) {
    console.log('Changes against the live catalog:');
    for (const line of diffLines) console.log(line);
  }

  if (plan.files.length === 0 && !plan.uploadCatalog) {
    console.log('Nothing to publish: the live catalog already matches. (Use --all to re-upload anyway.)');
    return 0;
  }

  // Written out even on a dry run, so the catalog can be inspected.
  const catalogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trail-data-')), 'catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(local, null, 2) + '\n');

  const totalBytes = plan.files.reduce((sum, trail) => sum + trail.bytes, 0);
  console.log(
    `${options.dryRun ? 'Would upload' : 'Uploading'} ${plan.files.length} trail file(s) ` +
      `(${(totalBytes / 1024 / 1024).toFixed(2)} MB) to ${bucket}/${TRAIL_DATA_PREFIX}/` +
      (plan.uploadCatalog ? `, then ${CATALOG_KEY}` : '')
  );

  if (options.dryRun) {
    for (const trail of plan.files) {
      console.log(`  would put ${TRAIL_DATA_PREFIX}/${trail.key} (${trail.bytes} bytes)`);
    }
    if (plan.uploadCatalog) console.log(`  would put ${CATALOG_KEY} (last) — written to ${catalogFile}`);
    return 0;
  }

  requireWrangler();
  for (const trail of plan.files) {
    putObject(
      bucket,
      `${TRAIL_DATA_PREFIX}/${trail.key}`,
      path.join(MOBILE_TRAILS_DIR, `${trail.id}.json`),
      TRAIL_FILE_CACHE_CONTROL
    );
  }
  // Last: publishing the catalog is what makes the new files live.
  if (plan.uploadCatalog) putObject(bucket, CATALOG_KEY, catalogFile, CATALOG_CACHE_CONTROL);

  console.log('Published. Verify with `npm run publish:trail-data -- --check`.');
  return 0;
}

// Guarded so the module can be imported by a test without publishing anything.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  );
}
