/**
 * Pre-fetch OSM points of interest for trail corridors.
 *
 * The OSM catalog, the Overpass query builder, the corridor chunking and the
 * point-to-route geometry all live in the shared `gpx-tools` library, so the
 * web tools, the API proxy and this script agree on what a "water source" is
 * and how far off-trail it sits. This script only supplies the file-system
 * pieces and the trail's own km scale.
 *
 * Track geometry is READ from `public/data/generated/{trail-id}.json`, so
 * `npm run build:trails` must have run first. Results are WRITTEN to
 * `data/trails/<dir>/pois.json` — in the repo, reviewable, and safe from the
 * next rebuild (the generated directory is gitignored and rewritten wholesale).
 * `scripts/build-trails.ts` folds those files back into the generated JSON,
 * minus anything listed in the file's hand-edited `rejected` array. The format
 * is documented in `scripts/lib/trail-pois-file.ts`.
 *
 * POIs never become waypoints: they carry no `data/waypoint-ids.json` id and
 * are kept in their own `pois` array.
 *
 * Usage: tsx scripts/fetch-pois.ts [trail-id] [--dry-run] [--endpoint <url>] [--timeout <s>]
 *   - With no trail-id: processes every generated trail
 *   - With trail-id:    processes only that trail
 *   - --dry-run:        builds the corridor and prints query counts, but makes
 *                       no network requests and writes nothing
 *   - --endpoint <url>: Overpass instance (also `OVERPASS_ENDPOINT`)
 *   - --timeout <s>:    Overpass `[timeout:]` in seconds (default 22)
 *
 * Choosing an instance: public Overpass mirrors vary wildly in reach and load,
 * and a whole-corridor query with all five POI types is a heavy one. As of
 * 2026-09, `overpass-api.de` (the library default) is unreachable from the dev
 * box and `overpass.kumi.systems` answers every query shape with a 504 gateway
 * page. The combination that works is:
 *
 *   npm run fetch:pois -- cape_to_cape \
 *     --endpoint https://overpass.private.coffee/api/interpreter --timeout 120
 *
 * Networking note: on hosts whose IPv6 route to Overpass black-holes, Node's
 * happy-eyeballs fallback can be slower than the request timeout and every
 * chunk fails with a bare "fetch failed". This script therefore lowers the
 * autoselect attempt timeout at startup; the equivalent from the outside is
 * `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000`.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { POI_TYPES, buildCorridorChunks, type POIType } from 'gpx-tools/lib/osm-poi';
import { createOverpassFetcher, type POIFetcher } from 'gpx-tools/lib/overpass-client';
import { enrichRoute, type ChunkFailure } from 'gpx-tools/lib/poi-enrichment';

import { buildRouteScale, toTrailPOIs } from '../src/lib/trail-pois.js';
import type { ProcessedTrail, TrailPOI } from '../src/lib/trail-types.js';
import {
  buildTrailPOIFile,
  readTrailPOIFile,
  trailPOIPath,
  writeTrailPOIFile,
} from './lib/trail-pois-file.js';

export type { TrailPOI };

export interface TrailPOIResult {
  pois: TrailPOI[];
  /** Corridor chunks Overpass refused. A non-empty list means partial data. */
  failedChunks: ChunkFailure[];
  /** How many Overpass queries the corridor was split into. */
  queryChunks: number;
  queryTimeMs: number;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');

/** POIs within this distance of the trail are kept. */
const SEARCH_RADIUS_KM = 2;
/** Overpass etiquette: a slow trickle from one IP, never parallel queries. */
const MIN_DELAY_MS = 2000;
/** Corridor vertices per Overpass query; must stay under CORRIDOR_LIMITS.maxVertices. */
const MAX_VERTICES_PER_CHUNK = 300;
/**
 * The gpx-tools default, restated so the endpoint actually used can be recorded
 * in `pois.json`. Keep in step with `createOverpassFetcher`'s own default.
 */
const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/** The gpx-tools default `[timeout:]`, restated so --timeout has a baseline to print. */
const DEFAULT_TIMEOUT_SECONDS = 22;
/** Overpass etiquette asks clients to identify themselves; kumi.systems enforces it. */
const USER_AGENT = 'trail-maps-fetch-pois/1.0 (+https://github.com/eamon-b/trail-maps)';

const ALL_POI_TYPES: POIType[] = [...POI_TYPES];

/**
 * Fetch and annotate the POIs for one already-parsed trail.
 *
 * Pure apart from the injected fetcher: it neither reads nor writes files,
 * which is what makes it testable without touching Overpass.
 */
export async function processTrailData(
  trail: ProcessedTrail,
  fetchPOIs: POIFetcher
): Promise<TrailPOIResult> {
  const scale = buildRouteScale(trail);
  if (scale.polylines.length === 0) {
    return { pois: [], failedChunks: [], queryChunks: 0, queryTimeMs: 0 };
  }

  const result = await enrichRoute(scale.polylines, {
    types: ALL_POI_TYPES,
    searchRadiusKm: SEARCH_RADIUS_KM,
    maxVerticesPerChunk: MAX_VERTICES_PER_CHUNK,
    fetchPOIs,
  });

  return {
    pois: toTrailPOIs(result.pois, scale),
    failedChunks: result.failedChunks,
    queryChunks: result.stats.queryChunks,
    queryTimeMs: result.stats.queryTimeMs,
  };
}

/** The filesystem calls the trail-directory lookup makes. Injectable for tests. */
export interface TrailDirIO {
  readdirSync(
    dir: string,
    options: { withFileTypes: true }
  ): Array<{ name: string; isDirectory(): boolean }>;
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: 'utf-8'): string;
}

const NODE_IO: TrailDirIO = {
  readdirSync: (dir, options) => fs.readdirSync(dir, options),
  existsSync: fs.existsSync,
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
};

/**
 * Map trail id → source directory by reading each trail directory's `trail.json`.
 *
 * The directory name is not the trail id: `AAWT` holds `aawt` and
 * `Hume_and_Hovell` holds `hume-and-hovell`, so the config is the only
 * trustworthy link between the generated file and the directory to write into.
 */
export function trailDirsById(dataDir: string, io: TrailDirIO = NODE_IO): Map<string, string> {
  const dirs = new Map<string, string>();
  if (!io.existsSync(dataDir)) {
    return dirs;
  }
  for (const entry of io.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const trailDir = path.join(dataDir, entry.name);
    const configPath = path.join(trailDir, 'trail.json');
    if (!io.existsSync(configPath)) {
      continue;
    }
    try {
      const config = JSON.parse(io.readFileSync(configPath, 'utf-8')) as {
        id?: unknown;
      };
      if (typeof config.id === 'string' && config.id.length > 0) {
        dirs.set(config.id, trailDir);
      }
    } catch {
      // A trail.json that will not parse is build-trails' problem to report.
    }
  }
  return dirs;
}

function readTrail(trailPath: string): ProcessedTrail {
  return JSON.parse(fs.readFileSync(trailPath, 'utf-8')) as ProcessedTrail;
}

function countByCategory(pois: TrailPOI[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const poi of pois) {
    counts[poi.category] = (counts[poi.category] ?? 0) + 1;
  }
  return counts;
}

/** Report the corridor a trail would query, without making any request. */
function dryRunTrail(trailPath: string, trailDir: string): void {
  const trailId = path.basename(trailPath, '.json');
  console.log(`\nProcessing: ${trailId} (dry run)`);

  const trail = readTrail(trailPath);
  const scale = buildRouteScale(trail);
  if (scale.polylines.length === 0) {
    console.log('  No track points found. Skipping.');
    return;
  }

  const chunks = buildCorridorChunks(
    scale.polylines,
    SEARCH_RADIUS_KM * 1000,
    MAX_VERTICES_PER_CHUNK
  );
  const vertices = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const existing = readTrailPOIFile(trailDir);

  console.log(`  Route: ${scale.polylines.length} polyline(s), ${scale.kmScale.length} point(s)`);
  console.log(
    `  Corridor: ${chunks.length} Overpass quer${chunks.length === 1 ? 'y' : 'ies'}, ` +
      `${vertices} simplified vertices, radius ${SEARCH_RADIUS_KM} km`
  );
  console.log(`  Types: ${ALL_POI_TYPES.join(', ')}`);
  console.log(
    `  Would write: ${trailPOIPath(trailDir)}` +
      (existing
        ? ` (${existing.pois.length} POI(s), ${existing.rejected.length} rejected — kept)`
        : ' (new file)')
  );
  console.log('  No requests made, no files written.');
}

/** Fetch POIs for one trail and write them to its `pois.json`. */
async function processTrail(
  trailPath: string,
  trailDir: string,
  fetchPOIs: POIFetcher,
  endpoint: string
): Promise<boolean> {
  const trailId = path.basename(trailPath, '.json');
  console.log(`\nProcessing: ${trailId}`);

  const trail = readTrail(trailPath);
  const result = await processTrailData(trail, fetchPOIs);

  if (result.queryChunks === 0) {
    console.log('  No track points found. Skipping.');
    return false;
  }

  console.log(
    `  Queried ${result.queryChunks} corridor chunk(s) in ${(result.queryTimeMs / 1000).toFixed(1)}s`
  );
  for (const failure of result.failedChunks) {
    console.log(`  Chunk ${failure.chunkIndex + 1} FAILED: ${failure.error}`);
  }
  if (result.failedChunks.length > 0) {
    console.log(
      `  WARNING: ${result.failedChunks.length}/${result.queryChunks} chunk(s) failed — POI coverage is incomplete.`
    );
  }

  console.log(`  Total POIs found: ${result.pois.length}`);
  for (const [category, count] of Object.entries(countByCategory(result.pois))) {
    console.log(`    - ${category}: ${count}`);
  }

  // Read before writing: `rejected` is hand-edited review work and must survive
  // every refresh.
  const existing = readTrailPOIFile(trailDir);
  const file = buildTrailPOIFile({
    existing,
    pois: result.pois,
    fetchedAt: new Date().toISOString(),
    searchRadiusKm: SEARCH_RADIUS_KM,
    endpoint,
  });
  const written = writeTrailPOIFile(trailDir, file);
  console.log(
    `  Updated ${written}` +
      (file.rejected.length > 0 ? ` (kept ${file.rejected.length} rejected key(s))` : '')
  );

  return result.pois.length > 0;
}

function printUsage(): void {
  console.log(
    'Usage: tsx scripts/fetch-pois.ts [trail-id] [--dry-run] [--endpoint <url>] [--timeout <s>]'
  );
  console.log('');
  console.log('Fetches OSM points of interest along each trail corridor via the');
  console.log('shared gpx-tools library. Track geometry is read from');
  console.log('public/data/generated/{trail-id}.json (run "npm run build:trails" first);');
  console.log('results are written to data/trails/<dir>/pois.json.');
  console.log('');
  console.log('Options:');
  console.log('  trail-id         Process only this trail (default: all generated trails)');
  console.log(
    '  --dry-run        Build the corridor and print query counts; no network, no writes'
  );
  console.log(
    `  --endpoint <url> Overpass instance (env OVERPASS_ENDPOINT, default ${DEFAULT_ENDPOINT})`
  );
  console.log(
    `  --timeout <s>    Overpass [timeout:] in seconds (default ${DEFAULT_TIMEOUT_SECONDS})`
  );
  console.log('  --help, -h       Show this message');
  console.log('');
  console.log(
    'Known-good instance (2026-09): --endpoint https://overpass.private.coffee/api/interpreter --timeout 120'
  );
}

/** Flags that take a value, so `positionalArgs` never reads one as a trail id. */
const VALUE_FLAGS = ['--endpoint', '--timeout'];

/** Read `--name <value>` or `--name=<value>`. Null when absent; throws when empty. */
function optionValue(args: string[], name: string, requirement: string): string | null {
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${name} requires ${requirement}`);
    }
    return value;
  }
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) {
      throw new Error(`${name} requires ${requirement}`);
    }
    return value;
  }
  return null;
}

/** Resolve the Overpass endpoint: flag beats env beats the library default. */
export function resolveEndpoint(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return optionValue(args, '--endpoint', 'a URL') ?? (env.OVERPASS_ENDPOINT || DEFAULT_ENDPOINT);
}

/**
 * Resolve the Overpass `[timeout:]`, in seconds. A whole-corridor query for all
 * six POI types needs far more than the library's 22 s on a busy mirror.
 */
export function resolveTimeoutSeconds(args: string[]): number {
  const raw = optionValue(args, '--timeout', 'a number of seconds');
  if (raw === null) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout requires a positive number of seconds, got "${raw}"`);
  }
  return seconds;
}

/** Positional arguments, with the value-taking flags and their values removed. */
export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith('-')) {
      out.push(args[i]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const dryRun = args.includes('--dry-run');
  let endpoint: string;
  let timeoutSeconds: number;
  try {
    endpoint = resolveEndpoint(args);
    timeoutSeconds = resolveTimeoutSeconds(args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'bad option'}`);
    printUsage();
    process.exit(1);
  }

  const positional = positionalArgs(args);
  if (positional.length > 1) {
    console.error(`Error: expected at most one trail id, got: ${positional.join(', ')}`);
    printUsage();
    process.exit(1);
  }
  const specificTrail = positional[0];

  console.log('POI Fetch Script');
  console.log('================');

  if (!fs.existsSync(GENERATED_DIR)) {
    console.error(`\nError: Generated data directory not found: ${GENERATED_DIR}`);
    console.error('Run "npm run build:trails" first to generate trail data.');
    process.exit(1);
  }

  let trailFiles: string[];
  if (specificTrail) {
    const trailPath = path.join(GENERATED_DIR, `${specificTrail}.json`);
    if (!fs.existsSync(trailPath)) {
      console.error(`\nError: Trail not found: ${specificTrail}`);
      console.error(`Expected file: ${trailPath}`);
      process.exit(1);
    }
    trailFiles = [trailPath];
  } else {
    trailFiles = fs
      .readdirSync(GENERATED_DIR)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .sort()
      .map(f => path.join(GENERATED_DIR, f));
  }

  if (trailFiles.length === 0) {
    console.log('\nNo trail files found to process.');
    return;
  }

  const trailDirs = trailDirsById(DATA_DIR);
  console.log(`\nFound ${trailFiles.length} trail(s) to process.`);
  if (!dryRun) {
    console.log(`Endpoint: ${endpoint} (timeout ${timeoutSeconds}s)`);
  }

  let failedCount = 0;
  const targets: Array<{ trailFile: string; trailDir: string }> = [];
  for (const trailFile of trailFiles) {
    const trailId = path.basename(trailFile, '.json');
    const trailDir = trailDirs.get(trailId);
    if (!trailDir) {
      console.error(
        `\nError: no source directory for "${trailId}" — expected a data/trails/*/trail.json with "id": "${trailId}".`
      );
      failedCount++;
      continue;
    }
    targets.push({ trailFile, trailDir });
  }

  if (dryRun) {
    for (const { trailFile, trailDir } of targets) {
      try {
        dryRunTrail(trailFile, trailDir);
      } catch (error) {
        console.error(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    console.log('\n================');
    console.log(`Dry run complete. ${targets.length} trail(s) inspected, nothing written.`);
    if (failedCount > 0) {
      console.log(`${failedCount} trail(s) had no source directory.`);
      process.exitCode = 1;
    }
    return;
  }

  // One fetcher for the whole run: it serialises requests and spaces them, so
  // the delay budget is shared across trails rather than reset per trail.
  const fetchPOIs = createOverpassFetcher({
    endpoint,
    minDelayMs: MIN_DELAY_MS,
    timeoutSeconds,
    userAgent: USER_AGENT,
  });

  let updatedCount = 0;

  for (const { trailFile, trailDir } of targets) {
    try {
      if (await processTrail(trailFile, trailDir, fetchPOIs, endpoint)) {
        updatedCount++;
      }
    } catch (error) {
      failedCount++;
      console.error(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.log('\n================');
  console.log(`Done. Updated ${updatedCount} trail(s) with POI data.`);
  if (failedCount > 0) {
    console.log(`${failedCount} trail(s) failed.`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
const isMain =
  typeof invokedPath === 'string' && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  // Overpass over a black-holed IPv6 route otherwise burns the whole request
  // timeout before happy-eyeballs falls back to IPv4 (every chunk then fails
  // with a bare "fetch failed"). Harmless where IPv6 works.
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(3000);
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
