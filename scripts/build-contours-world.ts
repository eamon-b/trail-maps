/**
 * World Contour PMTiles Build (sharded, chunked)
 *
 * Generates contour vector tiles for the whole world from the Copernicus GLO-30
 * DEM (`data/dem-glo30/`), one 2°×2° cell at a time, exactly like
 * build-contours-australia.ts — same buffered cubicspline warp, same 10 m
 * gdal_contour, same 4 zoom tiers, same `is_index` classification, so the
 * served schema (layer `contour`, `elevation` + `is_index`, z9–15) is identical.
 *
 * Differences from the Australia build:
 *   - Signed global grid (`scripts/lib/world-grid.ts`): cell ids name the SW
 *     corner, e.g. `S26E132`, `N46E006`. Never mix work dirs with the legacy
 *     Australia ids (`E132_S24`, where the S number is the *north* edge).
 *   - The world is built one **shard** (continent-scale cell set) at a time:
 *     one tippecanoe run per shard → `world_{shard}.mbtiles`, then a single
 *     `--join` pass unions the shards into `world.mbtiles` / `world.pmtiles`.
 *     One world-sized tippecanoe merge would repeat the Australia merge pain
 *     (RAM-bound, ~24 h) at ~20× scale.
 *   - Each shard gets its OWN work dir (`data/tiles/contours-world/{shard}/`)
 *     so a shard merge only ever sweeps up its own cells' tier files.
 *   - `--fetch-dem` / `--purge-dem` keep peak DEM disk at shard scale
 *     (100–200 GB) instead of the ~1.1 TB world DEM. Purging is one-way: a
 *     later `--force` rebuild of a purged cell needs `--fetch-dem` again.
 *
 * Cells are resumable: a completed cell writes a `.done` marker and is skipped
 * on re-run (use --force to rebuild).
 *
 * Cell selection precedence: --cell > --bbox > --shard. `--shard` alongside
 * `--cell`/`--bbox` then only names the work dir and the merge output, so a
 * test bbox can be staged into (and merged with) a real shard.
 *
 * Prerequisites: gdal (3.6+), tippecanoe; for --join also tile-join + pmtiles.
 *
 * Usage:
 *   npx tsx scripts/build-contours-world.ts --shard oceania --parallel 16 --purge-dem
 *   npx tsx scripts/build-contours-world.ts --shard oceania --fetch-dem
 *   npx tsx scripts/build-contours-world.ts --shard oceania --merge-only
 *   npx tsx scripts/build-contours-world.ts --cell S26E132 --shard oceania  (child mode, no merge)
 *   npx tsx scripts/build-contours-world.ts --bbox 132 -26 134 -24 --shard oceania
 *   npx tsx scripts/build-contours-world.ts --join     (tile-join shards → world.pmtiles)
 *   npx tsx scripts/build-contours-world.ts --shard oceania --clean-work
 *
 * Remote/detached driver: scripts/remote/run-shard.sh (see
 * docs/world-contours-remote-build.md for the full runbook).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import {
  PROJECT_ROOT,
  CONTOUR_INTERVAL,
  INDEX_CONTOUR_INTERVAL,
  CONTOUR_WARP_TR_DEG,
  MAX_ZOOM,
  CONTOUR_MIN_ZOOM,
  CONTOUR_TIERS,
  CONTOUR_ZOOM_EXPECTATION,
  run,
  ensureDir,
  cleanWorkDir,
  formatBytes,
  fileSizeBytes,
  checkDependencies,
  validateMbtilesArtifact,
  type ContourTier,
} from './tile-pipeline.js';
import { DEFAULT_DEM_DIR, demTilePath, tileListCachePath } from './fetch-dem-copernicus.js';
import {
  cellsForShard,
  dem1DegTiles,
  demTileName,
  enumerateWorldCells,
  parseTileListNames,
  shardForCell,
  worldCellFromId,
  worldShardNames,
  WORLD_LAT_MAX,
  WORLD_LAT_MIN,
  WORLD_LON_MAX,
  WORLD_LON_MIN,
  type DemTile,
  type WorldCell,
} from './lib/world-grid.js';

// --- Constants ---

/** Per-shard cell work dirs live under here: `{base}/{shard}/`. */
const DEFAULT_WORK_BASE = path.join(PROJECT_ROOT, 'data/tiles/contours-world');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');

/** Work dir / output name used when no shard is named (--bbox / --cell only). */
const CUSTOM_SELECTION_NAME = 'custom';

// Warp buffer around each cell so cubic-spline smoothing sees the same
// neighbourhood pixels as the adjacent cell; contours are clipped back to the
// exact cell extent so features tile seamlessly without duplication.
const CELL_BUFFER_DEG = 0.01; // ~1.1km

// Warp resolution (2x the 1 arc-second source density). Shared with the
// Australia build and the per-trail pipeline so contours from every producer
// land on identical elevations.
const WARP_TR_DEG = CONTOUR_WARP_TR_DEG;

const CLASSIFIED_LAYER = 'contour';

/** Tier filename pattern, e.g. `S26E132_z12.fgb`. */
const TIER_FILE_PATTERN = /^([NS]\d{2}[EW]\d{3})_(z\d+)\.fgb$/;

const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts/fetch-dem-copernicus.ts');

/**
 * Cells per `--fetch-dem` invocation. Cell ids are tiny, but a whole-world
 * `--cells` list would still sit near Linux's 128 KiB per-argument limit; a
 * shard is passed by name instead and only ad-hoc selections chunk through here.
 */
const FETCH_CELL_CHUNK = 1000;

// --- CLI argument parsing ---

interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface CliArgs {
  shard: string | null;
  bbox: Bbox | null;
  cell: string | null;
  parallel: number;
  force: boolean;
  mergeOnly: boolean;
  skipSmooth: boolean;
  verbose: boolean;
  fetchDem: boolean;
  purgeDem: boolean;
  cleanWork: boolean;
  join: boolean;
  demDir: string;
  /** Explicit override of the *effective* cell work dir (default `{base}/{name}`). */
  workDir: string | null;
  outputDir: string;
}

/**
 * Parse argv (without node/script). Throws rather than exiting so the parsing
 * logic stays testable; `main` turns the throw into a usage error.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    shard: null,
    bbox: null,
    cell: null,
    parallel: 1,
    force: false,
    mergeOnly: false,
    skipSmooth: false,
    verbose: false,
    fetchDem: false,
    purgeDem: false,
    cleanWork: false,
    join: false,
    demDir: DEFAULT_DEM_DIR,
    workDir: null,
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--shard':
        args.shard = requireValue('--shard', argv[++i]);
        break;
      case '--bbox': {
        const parts = argv.slice(i + 1, i + 5);
        if (parts.length !== 4) throw new Error('--bbox requires W S E N');
        const [west, south, east, north] = parts.map(Number);
        if ([west, south, east, north].some(v => !Number.isFinite(v))) {
          throw new Error(`--bbox values must be numbers: ${parts.join(' ')}`);
        }
        args.bbox = { west, south, east, north };
        i += 4;
        break;
      }
      case '--cell':
        args.cell = requireValue('--cell', argv[++i]);
        break;
      case '--parallel': {
        const value = parseInt(requireValue('--parallel', argv[++i]), 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new Error('--parallel must be a positive integer');
        }
        args.parallel = value;
        break;
      }
      case '--force':
        args.force = true;
        break;
      case '--merge-only':
        args.mergeOnly = true;
        break;
      case '--skip-smooth':
        args.skipSmooth = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--fetch-dem':
        args.fetchDem = true;
        break;
      case '--purge-dem':
        args.purgeDem = true;
        break;
      case '--clean-work':
        args.cleanWork = true;
        break;
      case '--join':
        args.join = true;
        break;
      case '--dem-dir':
        args.demDir = path.resolve(requireValue('--dem-dir', argv[++i]));
        break;
      case '--work-dir':
        args.workDir = path.resolve(requireValue('--work-dir', argv[++i]));
        break;
      case '--output-dir':
        args.outputDir = path.resolve(requireValue('--output-dir', argv[++i]));
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (args.shard !== null && !worldShardNames().includes(args.shard)) {
    throw new Error(
      `Unknown shard "${args.shard}". Known shards: ${worldShardNames().join(', ')}`
    );
  }

  if (!args.join && !args.shard && !args.bbox && !args.cell) {
    throw new Error('One of --shard, --bbox or --cell is required (or --join)');
  }

  return args;
}

/** Name for the work dir / merge output: the shard, else `custom`. */
export function selectionName(args: { shard: string | null }): string {
  return args.shard ?? CUSTOM_SELECTION_NAME;
}

/**
 * The effective cell work dir. Per-shard by default so a shard's tippecanoe
 * merge only ever sweeps up its own cells; `--work-dir` overrides it outright
 * (that is also how the parent hands the exact directory to `--cell` children).
 */
export function effectiveWorkDir(args: CliArgs): string {
  return args.workDir ?? path.join(DEFAULT_WORK_BASE, selectionName(args));
}

/** Merged shard artifact name, e.g. `world_oceania.mbtiles`. */
export function shardMbtilesName(args: { shard: string | null }): string {
  return `world_${selectionName(args)}.mbtiles`;
}

/**
 * Cells selected by the flags, in id order. Precedence --cell > --bbox >
 * --shard: the narrower selection wins, and `--shard` then only names the work
 * dir and merge output.
 */
export function selectCells(args: CliArgs): WorldCell[] {
  if (args.cell) {
    const cell = worldCellFromId(args.cell);
    if (!cell) {
      throw new Error(
        `Invalid cell ID: ${args.cell} (expected an even-degree world cell like S26E132)`
      );
    }
    return [cell];
  }
  if (args.bbox) return enumerateWorldCells(args.bbox);
  if (args.shard) return cellsForShard(args.shard);
  return [];
}

// --- Per-cell paths ---

function cellTierPath(workDir: string, cellId: string, tier: ContourTier): string {
  return path.join(workDir, `${cellId}_${tier.suffix}.fgb`);
}

function cellDoneMarker(workDir: string, cellId: string): string {
  return path.join(workDir, `${cellId}.done`);
}

function mosaicVrtPath(workDir: string): string {
  return path.join(workDir, 'dem_mosaic.vrt');
}

// --- DEM helpers ---

/** The cell's four 1° DEM tiles that are actually on disk. */
export function localDemTilesForCell(demDir: string, cell: WorldCell): string[] {
  return dem1DegTiles(cell)
    .filter(tile => fs.existsSync(demTilePath(demDir, tile)))
    .map(demTileName);
}

/**
 * Every 1° DEM tile the cell's *buffered* warp window reads — its own four plus
 * the neighbours the 0.01° buffer laps into. Purging must respect the buffer:
 * deleting a neighbour tile early would silently warp nodata into the smoothing
 * neighbourhood at the cell edge.
 */
export function bufferedDemTilesForCell(cell: WorldCell): DemTile[] {
  const tiles: DemTile[] = [];
  const lonStart = Math.floor(cell.west - CELL_BUFFER_DEG);
  const lonEnd = Math.ceil(cell.east + CELL_BUFFER_DEG);
  const latStart = Math.floor(cell.south - CELL_BUFFER_DEG);
  const latEnd = Math.ceil(cell.north + CELL_BUFFER_DEG);
  for (let lon = lonStart; lon < lonEnd; lon++) {
    for (let lat = latStart; lat < latEnd; lat++) {
      // The lattice has no wrap-around tiles; clamp at the antimeridian/poles.
      if (lon < WORLD_LON_MIN || lon >= WORLD_LON_MAX) continue;
      if (lat < WORLD_LAT_MIN || lat >= WORLD_LAT_MAX) continue;
      tiles.push({ lat, lon });
    }
  }
  return tiles;
}

/**
 * How many of this run's still-pending cells need each 1° DEM tile. Computed up
 * front so `--purge-dem` can delete a tile the moment the last cell that reads
 * it is done, without ever deleting one a queued cell still needs.
 */
export function demRefCounts(cells: WorldCell[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    for (const tile of bufferedDemTilesForCell(cell)) {
      const name = demTileName(tile);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Drop a completed cell's claim on its DEM tiles and delete the ones nothing
 * pending still needs. Returns the bytes freed.
 *
 * The mosaic VRT keeps listing the deleted files, which is fine: GDAL opens VRT
 * sources lazily and no remaining cell reads a window that overlaps them.
 */
export function purgeCellDem(
  cell: WorldCell,
  counts: Map<string, number>,
  demDir: string,
  verbose: boolean
): number {
  let freed = 0;
  for (const tile of bufferedDemTilesForCell(cell)) {
    const name = demTileName(tile);
    const remaining = (counts.get(name) ?? 0) - 1;
    counts.set(name, Math.max(0, remaining));
    if (remaining > 0) continue;
    const filePath = demTilePath(demDir, tile);
    if (!fs.existsSync(filePath)) continue;
    freed += fs.statSync(filePath).size;
    fs.unlinkSync(filePath);
    if (verbose) console.log(`    purged DEM ${name}.tif`);
  }
  return freed;
}

/** Copernicus land mask from the cached tile list, when it has been fetched. */
function cachedLandTiles(demDir: string): Set<string> | null {
  const listPath = tileListCachePath(demDir);
  if (!fs.existsSync(listPath) || fs.statSync(listPath).size === 0) return null;
  return parseTileListNames(fs.readFileSync(listPath, 'utf-8'));
}

/**
 * Download the GLO-30 tiles this run's cells need, by spawning the fetcher.
 * A whole shard is passed by name (its cell list would be enormous); anything
 * else goes as chunked `--cells` lists.
 */
function fetchDemForCells(cells: WorldCell[], args: CliArgs): void {
  const commonArgs = ['--dem-dir', args.demDir, '--parallel', String(Math.max(2, args.parallel))];
  const invocations: string[][] = [];

  if (!args.cell && !args.bbox && args.shard) {
    invocations.push(['--shard', args.shard, ...commonArgs]);
  } else {
    for (let i = 0; i < cells.length; i += FETCH_CELL_CHUNK) {
      const chunk = cells.slice(i, i + FETCH_CELL_CHUNK).map(c => c.id);
      invocations.push(['--cells', chunk.join(','), ...commonArgs]);
    }
  }

  for (const invocation of invocations) {
    execFileSync('npx', ['tsx', FETCH_SCRIPT, ...invocation], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
}

// --- Pipeline steps ---

/**
 * Build a VRT mosaic of ALL DEM tiles in the GLO-30 dir.
 *
 * The parent rebuilds this every run: a VRT left over from an earlier run would
 * not list tiles fetched since, and cells over those tiles would silently warp
 * nothing but nodata.
 */
function buildDemMosaic(demDir: string, vrtPath: string, verbose: boolean): void {
  if (!fs.existsSync(demDir)) {
    throw new Error(`DEM directory not found: ${demDir} (run scripts/fetch-dem-copernicus.ts)`);
  }

  const demFiles = fs.readdirSync(demDir).filter(f => f.toLowerCase().endsWith('.tif'));
  if (demFiles.length === 0) {
    throw new Error(`No DEM files found in ${demDir} (run scripts/fetch-dem-copernicus.ts)`);
  }

  console.log(`  Found ${demFiles.length} DEM tiles`);

  // gdalbuildvrt reads the file list from an argument file to avoid
  // command-line length limits — world-wide this is ~26,000 tiles.
  const listPath = vrtPath.replace(/\.vrt$/, '_files.txt');
  fs.writeFileSync(listPath, demFiles.map(f => path.join(demDir, f)).join('\n'));
  run(`gdalbuildvrt -vrtnodata -9999 -input_file_list "${listPath}" "${vrtPath}"`, { verbose });
  fs.unlinkSync(listPath);

  console.log(`  ✓ VRT mosaic: ${vrtPath}`);
}

/**
 * Process a single cell: warp+smooth a buffered window from the DEM mosaic,
 * generate contours, then classify + clip to the exact cell extent + split
 * into zoom-tier FlatGeobufs in a single ogr2ogr pass per tier.
 *
 * Identical to the Australia build's processCell, minus its positive-degrees-
 * south coordinate flip: world cells carry real signed latitudes.
 */
function processCell(cell: WorldCell, args: CliArgs, workDir: string): void {
  const cellId = cell.id;
  const demPath = path.join(workDir, `${cellId}_dem.tif`);
  const rawPath = path.join(workDir, `${cellId}_raw.fgb`);

  try {
    // 1: Clip + (optionally) smooth in one warp from the mosaic.
    //    Buffered extent so smoothing matches the neighbouring cell.
    const resampling = args.skipSmooth ? 'near' : 'cubicspline';
    run([
      'gdalwarp',
      '-overwrite',
      `-te ${cell.west - CELL_BUFFER_DEG} ${cell.south - CELL_BUFFER_DEG} ${cell.east + CELL_BUFFER_DEG} ${cell.north + CELL_BUFFER_DEG}`,
      `-r ${resampling}`,
      `-tr ${WARP_TR_DEG} ${WARP_TR_DEG}`,
      // -tap aligns every cell's pixel grid to the same global -tr lattice.
      // Without it, adjacent cells (whose -te origins differ by 2°, not a
      // multiple of -tr) sample the DEM ~0.24px apart and smoothed elevations
      // diverge by several metres at the shared edge — contour lines would
      // dangle at every cell boundary instead of meeting.
      '-tap',
      '-dstnodata -9999',
      '-co COMPRESS=LZW',
      '-co TILED=YES',
      '-co BIGTIFF=YES',
      `"${mosaicVrtPath(workDir)}"`,
      `"${demPath}"`,
    ].join(' '), { verbose: args.verbose });

    // 2: Generate contours. GLO-30 samples are float32 metres, so the interval
    //    and the integer tier arithmetic below mean the same thing they do for
    //    the SRTM-based Australia build.
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
    run([
      'gdal_contour',
      '-a elevation',
      `-i ${CONTOUR_INTERVAL}`,
      '-snodata -9999',
      '-f FlatGeobuf',
      `"${demPath}"`,
      `"${rawPath}"`,
    ].join(' '), { verbose: args.verbose });

    // 3: Per tier: classify (is_index), filter, and clip back to the exact
    //    cell extent so adjacent cells don't duplicate features.
    for (const tier of CONTOUR_TIERS) {
      const tierPath = cellTierPath(workDir, cellId, tier);
      if (fs.existsSync(tierPath)) fs.unlinkSync(tierPath);
      run([
        'ogr2ogr',
        '-f FlatGeobuf',
        `"${tierPath}"`,
        `"${rawPath}"`,
        `-nln ${CLASSIFIED_LAYER}`,
        // Clipping can split a contour into a MultiLineString; promote the
        // layer type so mixed geometries write cleanly.
        '-nlt PROMOTE_TO_MULTI',
        `-clipsrc ${cell.west} ${cell.south} ${cell.east} ${cell.north}`,
        '-dialect sqlite',
        '-sql',
        `"SELECT geometry, elevation, CAST(CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS INTEGER) AS is_index FROM 'contour' WHERE ${tier.where}"`,
      ].join(' '), { verbose: args.verbose });
    }

    fs.writeFileSync(cellDoneMarker(workDir, cellId), new Date().toISOString());
  } finally {
    // Intermediates are per-cell and large; always clean them.
    if (fs.existsSync(demPath)) fs.unlinkSync(demPath);
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  }
}

/**
 * Run cells, optionally in parallel by spawning this script with --cell <id>.
 * The work dir is passed explicitly so a child stages into the same per-shard
 * directory as its parent.
 */
async function processCells(
  cells: WorldCell[],
  args: CliArgs,
  workDir: string,
  onCellDone: (cell: WorldCell) => void
): Promise<{ cellId: string; success: boolean; error?: string }[]> {
  const results: { cellId: string; success: boolean; error?: string }[] = [];

  if (args.parallel <= 1) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      console.log(`  [${i + 1}/${cells.length}] ${cell.id}...`);
      try {
        processCell(cell, args, workDir);
        results.push({ cellId: cell.id, success: true });
        onCellDone(cell);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${cell.id}: ${message}`);
        results.push({ cellId: cell.id, success: false, error: message });
      }
    }
    return results;
  }

  const scriptPath = new URL(import.meta.url).pathname;
  const childArgs = ['--work-dir', workDir, '--dem-dir', args.demDir];
  if (args.skipSmooth) childArgs.push('--skip-smooth');
  if (args.verbose) childArgs.push('--verbose');
  if (args.force) childArgs.push('--force');

  const queue = [...cells];
  let completed = 0;

  const runNext = async (): Promise<void> => {
    for (;;) {
      const cell = queue.shift();
      if (!cell) return;
      await new Promise<void>((resolve) => {
        execFile('npx', ['tsx', scriptPath, '--cell', cell.id, ...childArgs], {
          cwd: PROJECT_ROOT,
          maxBuffer: 50 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          completed++;
          if (args.verbose) {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
          }
          if (error) {
            console.error(`  ✗ [${completed}/${cells.length}] ${cell.id}: ${error.message.split('\n')[0]}`);
            results.push({ cellId: cell.id, success: false, error: error.message });
          } else {
            console.log(`  ✓ [${completed}/${cells.length}] ${cell.id}`);
            results.push({ cellId: cell.id, success: true });
            onCellDone(cell);
          }
          resolve();
        });
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(args.parallel, cells.length) }, () => runNext())
  );

  return results;
}

/**
 * Merge every completed cell's tier FlatGeobufs in this shard's work dir into
 * one .mbtiles with tippecanoe.
 *
 * Invoked via execFileSync with an argv array, NOT through run()/execSync:
 * hundreds of cells x 4 tiers of -L arguments as a single shell string would
 * sit at ~95% of Linux's per-argument limit (MAX_ARG_STRLEN, 128KiB) and fail
 * with E2BIG at the end of a multi-hour build. As separate argv entries the
 * limit is the full ARG_MAX (~2MB).
 */
function mergeToMbtiles(workDir: string, outputPath: string, verbose: boolean): void {
  const layerArgs: string[] = [];
  let fileCount = 0;
  let skipped = 0;

  for (const file of fs.readdirSync(workDir).sort()) {
    const m = file.match(TIER_FILE_PATTERN);
    if (!m) continue;
    const tier = CONTOUR_TIERS.find(t => t.suffix === m[2]);
    if (!tier || !worldCellFromId(m[1])) {
      console.warn(`  ⚠ Skipping ${file} — not on the canonical cell grid`);
      skipped++;
      continue;
    }
    // A cell that died mid-tier-loop leaves partial files without a .done
    // marker; merging them would silently drop part of that cell's contours.
    if (!fs.existsSync(cellDoneMarker(workDir, m[1]))) {
      console.warn(`  ⚠ Skipping ${file} — cell has no .done marker (incomplete build; re-run without --merge-only)`);
      skipped++;
      continue;
    }
    const filePath = path.join(workDir, file);
    layerArgs.push('-L', JSON.stringify({ file: filePath, layer: CLASSIFIED_LAYER, minzoom: tier.minZoom }));
    fileCount++;
  }

  if (fileCount === 0) {
    throw new Error(`No cell tier files found in ${workDir} — nothing to merge`);
  }

  console.log(`  Merging ${fileCount} tier files from ${workDir}` +
    (skipped ? ` (${skipped} skipped)` : ''));

  // tippecanoe spills tens of GB of temporary sort files to /tmp by default;
  // on tmpfs that exhausts the quota mid-merge. Keep temps next to the data.
  const tmpDir = path.join(workDir, 'tmp');
  ensureDir(tmpDir);

  execFileSync('tippecanoe', [
    '-t', tmpDir,
    '-o', outputPath,
    // Quiet the progress indicator unless --verbose. Output also streams to
    // the terminal (stdio inherit) instead of a pipe: any capture buffer
    // eventually fills over a multi-hour merge and kills tippecanoe with
    // ENOBUFS — -q alone doesn't prevent per-tile feature-drop warnings.
    ...(verbose ? [] : ['-q']),
    `-Z${CONTOUR_MIN_ZOOM}`,
    `-z${MAX_ZOOM}`,
    '-P',
    '-y', 'elevation',
    '-y', 'is_index',
    '--drop-smallest-as-needed',
    // Quality bundle chosen at the 2026-08-22 decision gate (Mt Sonder,
    // `npm run experiment:contours`, run `smooth-z13`): simplification 14
    // left z12–z14 contours visibly polygonal; 2 renders smooth at every zoom
    // for ~+35% archive size in mountainous tiles (z15 is unaffected).
    '--simplification=2',
    // Keep full vertex detail at maxzoom: z15 tiles are what MapLibre
    // overzooms past z15, so simplifying them makes contours visibly
    // polygonal exactly where users zoom in. Lower zooms stay simplified.
    '--simplify-only-low-zooms',
    // tippecanoe's default (128 units): an oversize tile may be quantised no
    // coarser than that before features are dropped — 4 allowed a 16×16 grid.
    '--minimum-detail=7',
    '--maximum-tile-bytes=1000000',
    '--force',
    ...layerArgs,
  ], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  console.log(`  ✓ Shard mbtiles: ${outputPath} (${formatBytes(fileSizeBytes(outputPath))})`);
}

/**
 * Union every `world_*.mbtiles` in the output dir into `world.mbtiles` and
 * convert it to `world.pmtiles`.
 *
 * Cells are clipped disjoint, so tile-join only has to re-encode tiles that
 * straddle a shard border. `--no-tile-size-limit` is mandatory: without it
 * those re-encoded border tiles are silently dropped when they exceed 500 KB.
 */
function joinShards(outputDir: string, verbose: boolean): void {
  const shardFiles = fs.readdirSync(outputDir)
    .filter(f => /^world_.+\.mbtiles$/.test(f))
    .sort()
    .map(f => path.join(outputDir, f));

  if (shardFiles.length === 0) {
    throw new Error(
      `No world_*.mbtiles files found in ${outputDir} — build at least one shard first ` +
      `(npx tsx scripts/build-contours-world.ts --shard <name>)`
    );
  }

  const mbtilesPath = path.join(outputDir, 'world.mbtiles');
  const pmtilesPath = path.join(outputDir, 'world.pmtiles');

  console.log(`  Joining ${shardFiles.length} shard file(s):`);
  for (const file of shardFiles) {
    console.log(`    ${path.basename(file)} (${formatBytes(fileSizeBytes(file))})`);
  }

  // A killed tile-join/convert leaves a plausible-looking file whose header was
  // never written; never let one survive into the next attempt.
  if (fs.existsSync(mbtilesPath)) fs.unlinkSync(mbtilesPath);
  if (fs.existsSync(pmtilesPath)) fs.unlinkSync(pmtilesPath);

  execFileSync('tile-join', [
    '-o', mbtilesPath,
    '--no-tile-size-limit',
    '--force',
    ...(verbose ? [] : ['-q']),
    ...shardFiles,
  ], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  console.log(`  ✓ Joined mbtiles: ${mbtilesPath} (${formatBytes(fileSizeBytes(mbtilesPath))})`);
  validateMbtilesArtifact(mbtilesPath, CONTOUR_ZOOM_EXPECTATION);

  execFileSync('pmtiles', ['convert', mbtilesPath, pmtilesPath], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  console.log(`  ✓ PMTiles archive: ${pmtilesPath} (${formatBytes(fileSizeBytes(pmtilesPath))})`);
}

// --- Main ---

function usage(): void {
  console.error(
    '\nUsage: npx tsx scripts/build-contours-world.ts ' +
    '(--shard NAME | --bbox W S E N | --cell ID | --join)\n' +
    '  [--parallel N] [--force] [--merge-only] [--skip-smooth] [--verbose]\n' +
    '  [--fetch-dem] [--purge-dem] [--dem-dir DIR] [--work-dir DIR] [--output-dir DIR] [--clean-work]'
  );
  console.error(`\nShards: ${worldShardNames().join(', ')}`);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(1);
  }

  const workDir = effectiveWorkDir(args);

  // Join mode: purely an output-dir operation, no cells, no DEM.
  if (args.join) {
    console.log('World Contour Join (tile-join + pmtiles convert)');
    console.log('================================================\n');
    checkDependencies({ skipContours: true });
    ensureDir(args.outputDir);
    const startTime = Date.now();
    try {
      joinShards(args.outputDir, args.verbose);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nFatal error: ${message}`);
      process.exit(1);
    }
    console.log(`\n  Time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);
    return;
  }

  // Single-cell child mode: process one cell, no banner, no merge.
  if (args.cell) {
    const cell = worldCellFromId(args.cell);
    if (!cell) {
      console.error(
        `Invalid cell ID: ${args.cell} (expected an even-degree world cell like S26E132)`
      );
      process.exit(1);
    }
    ensureDir(workDir);
    if (!fs.existsSync(mosaicVrtPath(workDir))) {
      buildDemMosaic(args.demDir, mosaicVrtPath(workDir), args.verbose);
    }
    if (!args.force && fs.existsSync(cellDoneMarker(workDir, cell.id))) {
      console.log(`Skipping ${cell.id} (already built — use --force to rebuild)`);
      return;
    }
    processCell(cell, args, workDir);
    return;
  }

  console.log('World Contour Build (sharded)');
  console.log('=============================\n');

  console.log('Checking dependencies...');
  checkDependencies({ skipBase: true });
  console.log('  ✓ All dependencies found\n');

  ensureDir(workDir);
  ensureDir(args.outputDir);

  const startTime = Date.now();
  const outputPath = path.join(args.outputDir, shardMbtilesName(args));

  console.log(`  Selection: ${args.cell ?? (args.bbox ? 'bbox' : `shard ${args.shard}`)}`);
  console.log(`  Work dir:  ${workDir}`);
  console.log(`  DEM dir:   ${args.demDir}`);
  console.log(`  Output:    ${outputPath}\n`);

  try {
    if (!args.mergeOnly) {
      const selected = selectCells(args);

      // --shard alongside --bbox only names the work dir/output; say so loudly
      // if the bbox reaches outside that shard, because those cells will be
      // merged into (and later joined as) that shard's tileset.
      if (args.shard && args.bbox) {
        const foreign = selected.filter(c => shardForCell(c) !== args.shard).length;
        if (foreign > 0) {
          console.warn(
            `  ⚠ ${foreign}/${selected.length} bbox cells belong to another shard — ` +
            `they will still be staged into ${workDir} and merged into ${path.basename(outputPath)}\n`
          );
        }
      }

      if (args.fetchDem) {
        console.log(`Step 0: Fetching Copernicus GLO-30 DEM for ${selected.length} cells...`);
        fetchDemForCells(selected, args);
        console.log('');
      }

      console.log('Step 1: Building DEM mosaic...');
      buildDemMosaic(args.demDir, mosaicVrtPath(workDir), args.verbose);

      // A cell is buildable only if at least one of its four 1° DEM tiles is on
      // disk. Absent-from-the-bucket tiles are ocean (nothing to build);
      // present-in-the-bucket-but-not-on-disk means the DEM fetch is incomplete.
      const landMask = cachedLandTiles(args.demDir);
      const buildable = selected.filter(c => localDemTilesForCell(args.demDir, c).length > 0);
      const missing = landMask
        ? selected.filter(
            c =>
              localDemTilesForCell(args.demDir, c).length === 0 &&
              dem1DegTiles(c).some(t => landMask.has(demTileName(t)))
          ).length
        : 0;

      console.log(`\n  Cells selected:   ${selected.length}`);
      console.log(`  With local DEM:   ${buildable.length}`);
      console.log(`  Ocean/no DEM:     ${selected.length - buildable.length}` +
        (landMask ? ` (of which ${missing} have land tiles not yet downloaded)` : ''));
      if (!landMask) {
        console.log('  (no cached tile list — run the fetcher or --fetch-dem to tell ' +
          'ocean cells apart from un-downloaded ones)');
      }
      if (missing > 0) {
        console.warn(`  ⚠ ${missing} land cells have no DEM on disk — re-run with --fetch-dem`);
      }

      const pendingCells = args.force
        ? buildable
        : buildable.filter(c => !fs.existsSync(cellDoneMarker(workDir, c.id)));

      console.log(`\nStep 2: Processing cells (${buildable.length} land cells, ` +
        `${buildable.length - pendingCells.length} already built, ` +
        `${pendingCells.length} to process, parallelism ${args.parallel})...`);

      // Refcount the DEM tiles this run still needs BEFORE any cell completes,
      // so a purge can only ever delete a tile no queued cell will read.
      const refCounts = args.purgeDem ? demRefCounts(pendingCells) : null;
      let purgedBytes = 0;
      const onCellDone = (cell: WorldCell): void => {
        if (!refCounts) return;
        purgedBytes += purgeCellDem(cell, refCounts, args.demDir, args.verbose);
      };

      const results = await processCells(pendingCells, args, workDir, onCellDone);
      if (refCounts && purgedBytes > 0) {
        console.log(`  Purged ${formatBytes(purgedBytes)} of DEM tiles no pending cell needs`);
      }

      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        console.error(`\n${failed.length} cells failed:`);
        failed.forEach(r => console.error(`  ${r.cellId}: ${r.error?.split('\n')[0]}`));
        console.error('\nRe-run to retry failed cells (completed cells are skipped).');
        process.exit(1);
      }
    }

    console.log('\nStep 3: Merging shard into MBTiles with tippecanoe...');
    mergeToMbtiles(workDir, outputPath, args.verbose);
    validateMbtilesArtifact(outputPath, CONTOUR_ZOOM_EXPECTATION);

    // Tier files are the expensive artifact (hours of GDAL work) and enable
    // cheap tippecanoe-only re-merges via --merge-only; keep them by default.
    if (args.cleanWork) {
      cleanWorkDir(workDir);
    } else {
      console.log(`\n  Work dir kept for --merge-only re-runs: ${workDir}`);
      console.log('  (pass --clean-work to delete it)');
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('\n' + '═'.repeat(40));
    console.log('Shard Build Complete');
    console.log('═'.repeat(40));
    console.log(`  Output: ${outputPath}`);
    console.log(`  Size:   ${formatBytes(fileSizeBytes(outputPath))}`);
    console.log(`  Time:   ${elapsed} minutes`);
    console.log('\n  Join the shards when they are all built:');
    console.log('    npx tsx scripts/build-contours-world.ts --join');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFatal error: ${message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
