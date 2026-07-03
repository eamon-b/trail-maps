/**
 * Australia-Wide Contour PMTiles Build (chunked)
 *
 * Generates a single PMTiles file containing contour lines for all of
 * Australia, suitable for serving via the contour-tiles Cloudflare Worker.
 *
 * Unlike the previous implementation (which warped the entire continent into
 * one smoothed GeoTIFF — ~37GB, and historically died at the 4GiB classic-TIFF
 * ceiling), this build processes the same 2°×2° grid cells as
 * build-grid-tiles.ts: each cell is clipped+smoothed+contoured independently,
 * split into zoom-tier FlatGeobufs, and a single tippecanoe run at the end
 * merges every cell's tiers into one PMTiles file.
 *
 * Cells are resumable: a completed cell writes a `.done` marker and is skipped
 * on re-run (use --force to rebuild).
 *
 * Prerequisites: gdal (3.6+), tippecanoe
 *
 * Usage:
 *   npx tsx scripts/build-contours-australia.ts
 *   npx tsx scripts/build-contours-australia.ts --parallel 4
 *   npx tsx scripts/build-contours-australia.ts --cell E146_S36   (single cell, no merge)
 *   npx tsx scripts/build-contours-australia.ts --merge-only      (skip cells, just tippecanoe)
 *   npx tsx scripts/build-contours-australia.ts --force
 *   npx tsx scripts/build-contours-australia.ts --skip-smooth
 *   npx tsx scripts/build-contours-australia.ts --clean-work  (delete tier files after merge)
 *   npx tsx scripts/build-contours-australia.ts --output-dir /path/to/output
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import {
  PROJECT_ROOT,
  DEM_CACHE_DIR,
  CONTOUR_INTERVAL,
  INDEX_CONTOUR_INTERVAL,
  MAX_ZOOM,
  run,
  ensureDir,
  cleanWorkDir,
  formatBytes,
  fileSizeBytes,
  checkDependencies,
  enumerateCells,
  parseCellId,
  isAlignedCellId,
  demFilesForCell,
  mgaEpsgForLon,
  CELL_SIZE_DEG,
  type CellDef,
} from './tile-pipeline.js';

// --- Constants ---

const CONTOUR_MIN_ZOOM = 9;
const WORK_DIR = path.join(PROJECT_ROOT, 'data/tiles/contours-australia');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');
const OUTPUT_FILENAME = 'australia-contours.pmtiles';

// Warp buffer around each cell so cubic-spline smoothing sees the same
// neighbourhood pixels as the adjacent cell; contours are clipped back to the
// exact cell extent so features tile seamlessly without duplication.
const CELL_BUFFER_DEG = 0.01; // ~1.1km

const CLASSIFIED_LAYER = 'contour';

interface Tier {
  suffix: string;
  minZoom: number;
  where: string;
}

const TIERS: Tier[] = [
  { suffix: 'z9',  minZoom: 9,  where: `(CAST(elevation AS INTEGER) % 100) = 0` },
  { suffix: 'z10', minZoom: 10, where: `(CAST(elevation AS INTEGER) % 50) = 0 AND (CAST(elevation AS INTEGER) % 100) != 0` },
  { suffix: 'z12', minZoom: 12, where: `(CAST(elevation AS INTEGER) % 20) = 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
  // %50 != 0 as well: odd multiples of 50 (50, 150, ...) have %20 = 10 and are
  // already emitted by the z10 tier — without it they'd appear twice.
  { suffix: 'z13', minZoom: 13, where: `(CAST(elevation AS INTEGER) % 20) != 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
];

// --- CLI argument parsing ---

interface CliArgs {
  verbose: boolean;
  skipSmooth: boolean;
  outputDir: string;
  cell: string | null;
  parallel: number;
  force: boolean;
  mergeOnly: boolean;
  cleanWork: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    verbose: false,
    skipSmooth: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    cell: null,
    parallel: 1,
    force: false,
    mergeOnly: false,
    cleanWork: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--verbose':
        result.verbose = true;
        break;
      case '--skip-smooth':
        result.skipSmooth = true;
        break;
      case '--output-dir':
        result.outputDir = args[++i];
        break;
      case '--cell':
        result.cell = args[++i];
        break;
      case '--parallel':
        result.parallel = parseInt(args[++i], 10);
        break;
      case '--force':
        result.force = true;
        break;
      case '--merge-only':
        result.mergeOnly = true;
        break;
      case '--clean-work':
        result.cleanWork = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return result;
}

// --- Per-cell paths ---

function cellTierPath(cellId: string, tier: Tier): string {
  return path.join(WORK_DIR, `${cellId}_${tier.suffix}.fgb`);
}

function cellDoneMarker(cellId: string): string {
  return path.join(WORK_DIR, `${cellId}.done`);
}

const MOSAIC_VRT_PATH = path.join(WORK_DIR, 'dem_mosaic.vrt');

// --- Pipeline steps ---

/**
 * Build a VRT mosaic of ALL DEM tiles in data/dem/.
 */
function buildDemMosaic(vrtPath: string, verbose: boolean): void {
  if (!fs.existsSync(DEM_CACHE_DIR)) {
    throw new Error(`DEM cache directory not found: ${DEM_CACHE_DIR}`);
  }

  const demExtensions = ['.tif', '.tiff', '.hgt'];
  const demFiles = fs.readdirSync(DEM_CACHE_DIR).filter(f =>
    demExtensions.some(ext => f.toLowerCase().endsWith(ext))
  );

  if (demFiles.length === 0) {
    throw new Error(`No DEM files found in ${DEM_CACHE_DIR}`);
  }

  console.log(`  Found ${demFiles.length} DEM tiles`);

  // gdalbuildvrt reads the file list from an argument file to avoid
  // command-line length limits with hundreds of tiles.
  const listPath = vrtPath.replace(/\.vrt$/, '_files.txt');
  fs.writeFileSync(
    listPath,
    demFiles.map(f => path.join(DEM_CACHE_DIR, f)).join('\n')
  );
  run(`gdalbuildvrt -vrtnodata -9999 -input_file_list "${listPath}" "${vrtPath}"`, { verbose });
  fs.unlinkSync(listPath);

  console.log(`  ✓ VRT mosaic: ${vrtPath}`);
}

/**
 * Process a single cell: warp+smooth a buffered window from the DEM mosaic,
 * generate contours, then classify + clip to the exact cell extent + split
 * into zoom-tier FlatGeobufs in a single ogr2ogr pass per tier.
 */
function processCell(cell: CellDef, args: CliArgs): void {
  const cellId = cell.id;

  // Cell bounds in real (negative) latitudes
  const latMin = -cell.north;
  const latMax = -cell.south;

  const demPath = path.join(WORK_DIR, `${cellId}_dem.tif`);
  const rawPath = path.join(WORK_DIR, `${cellId}_raw.fgb`);

  try {
    // 1: Clip + (optionally) smooth in one warp from the mosaic.
    //    Buffered extent so smoothing matches the neighbouring cell.
    const resampling = args.skipSmooth ? 'near' : 'cubicspline';
    run([
      'gdalwarp',
      '-overwrite',
      `-te ${cell.west - CELL_BUFFER_DEG} ${latMin - CELL_BUFFER_DEG} ${cell.east + CELL_BUFFER_DEG} ${latMax + CELL_BUFFER_DEG}`,
      `-r ${resampling}`,
      '-tr 0.000278 0.000278',
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
      `"${MOSAIC_VRT_PATH}"`,
      `"${demPath}"`,
    ].join(' '), { verbose: args.verbose });

    // 2: Generate contours
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
    for (const tier of TIERS) {
      const tierPath = cellTierPath(cellId, tier);
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
        `-clipsrc ${cell.west} ${latMin} ${cell.east} ${latMax}`,
        '-dialect sqlite',
        '-sql',
        `"SELECT geometry, elevation, CAST(CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS INTEGER) AS is_index FROM 'contour' WHERE ${tier.where}"`,
      ].join(' '), { verbose: args.verbose });
    }

    fs.writeFileSync(cellDoneMarker(cellId), new Date().toISOString());
  } finally {
    // Intermediates are per-cell and large; always clean them.
    if (fs.existsSync(demPath)) fs.unlinkSync(demPath);
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  }
}

/**
 * Run cells in parallel by spawning this script with --cell <id>.
 */
async function processCells(
  cells: CellDef[],
  args: CliArgs
): Promise<{ cellId: string; success: boolean; error?: string }[]> {
  const results: { cellId: string; success: boolean; error?: string }[] = [];

  if (args.parallel <= 1) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      console.log(`  [${i + 1}/${cells.length}] ${cell.id}...`);
      try {
        processCell(cell, args);
        results.push({ cellId: cell.id, success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${cell.id}: ${message}`);
        results.push({ cellId: cell.id, success: false, error: message });
      }
    }
    return results;
  }

  const scriptPath = new URL(import.meta.url).pathname;
  const childArgs: string[] = [];
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
 * Merge every cell's tier FlatGeobufs into one PMTiles file with tippecanoe.
 *
 * Invoked via execFileSync with an argv array, NOT through run()/execSync:
 * ~250 cells x 4 tiers of -L arguments as a single shell string would sit at
 * ~95% of Linux's per-argument limit (MAX_ARG_STRLEN, 128KiB) and fail with
 * E2BIG at the end of a multi-hour build. As separate argv entries the limit
 * is the full ARG_MAX (~2MB).
 */
function mergeToPmtiles(outputPath: string, verbose: boolean): void {
  const layerArgs: string[] = [];
  let fileCount = 0;
  let skipped = 0;

  for (const file of fs.readdirSync(WORK_DIR).sort()) {
    const m = file.match(/^(E\d+_S\d+)_(z\d+)\.fgb$/);
    if (!m) continue;
    const tier = TIERS.find(t => t.suffix === m[2]);
    if (!tier || !isAlignedCellId(m[1])) {
      console.warn(`  ⚠ Skipping ${file} — not on the canonical cell grid`);
      skipped++;
      continue;
    }
    // A cell that died mid-tier-loop leaves partial files without a .done
    // marker; merging them would silently drop part of that cell's contours.
    if (!fs.existsSync(cellDoneMarker(m[1]))) {
      console.warn(`  ⚠ Skipping ${file} — cell has no .done marker (incomplete build; re-run without --merge-only)`);
      skipped++;
      continue;
    }
    const filePath = path.join(WORK_DIR, file);
    layerArgs.push('-L', JSON.stringify({ file: filePath, layer: CLASSIFIED_LAYER, minzoom: tier.minZoom }));
    fileCount++;
  }

  if (fileCount === 0) {
    throw new Error(`No cell tier files found in ${WORK_DIR} — nothing to merge`);
  }

  console.log(`  Merging ${fileCount} tier files from ${WORK_DIR}` +
    (skipped ? ` (${skipped} skipped)` : ''));

  // tippecanoe spills tens of GB of temporary sort files to /tmp by default;
  // on tmpfs that exhausts the quota mid-merge. Keep temps next to the data.
  const tmpDir = path.join(WORK_DIR, 'tmp');
  ensureDir(tmpDir);

  execFileSync('tippecanoe', [
    '-t', tmpDir,
    '-o', outputPath,
    // Without -q the continuous progress indicator accumulates in the piped
    // stderr buffer for hours and can hit maxBuffer, killing the merge late.
    ...(verbose ? [] : ['-q']),
    `-Z${CONTOUR_MIN_ZOOM}`,
    `-z${MAX_ZOOM}`,
    '-P',
    '-y', 'elevation',
    '-y', 'is_index',
    '--drop-smallest-as-needed',
    '--simplification=14',
    '--minimum-detail=4',
    '--force',
    ...layerArgs,
  ], {
    cwd: PROJECT_ROOT,
    stdio: verbose ? 'inherit' : 'pipe',
    maxBuffer: 50 * 1024 * 1024,
  });

  console.log(`  ✓ PMTiles output: ${outputPath} (${formatBytes(fileSizeBytes(outputPath))})`);
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs();

  // Single-cell child mode: process one cell, no banner, no merge.
  if (args.cell) {
    const parsed = parseCellId(args.cell);
    if (!parsed || !isAlignedCellId(args.cell)) {
      console.error(`Invalid cell ID: ${args.cell} (expected an even-degree grid cell like E114_S34)`);
      process.exit(1);
    }
    ensureDir(WORK_DIR);
    if (!fs.existsSync(MOSAIC_VRT_PATH)) {
      buildDemMosaic(MOSAIC_VRT_PATH, args.verbose);
    }
    const lonCenter = parsed.lon + CELL_SIZE_DEG / 2;
    const cell: CellDef = {
      id: args.cell,
      west: parsed.lon,
      south: parsed.lat,
      east: parsed.lon + CELL_SIZE_DEG,
      north: parsed.lat + CELL_SIZE_DEG,
      epsg: mgaEpsgForLon(lonCenter),
    };
    if (!args.force && fs.existsSync(cellDoneMarker(cell.id))) {
      console.log(`Skipping ${cell.id} (already built — use --force to rebuild)`);
      return;
    }
    processCell(cell, args);
    return;
  }

  console.log('Australia-Wide Contour PMTiles Build (chunked)');
  console.log('==============================================\n');

  console.log('Checking dependencies...');
  checkDependencies({ skipBase: true });
  console.log('  ✓ All dependencies found\n');

  ensureDir(WORK_DIR);
  ensureDir(args.outputDir);

  const startTime = Date.now();
  const outputPath = path.join(args.outputDir, OUTPUT_FILENAME);

  try {
    if (!args.mergeOnly) {
      console.log('Step 1: Building DEM mosaic...');
      buildDemMosaic(MOSAIC_VRT_PATH, args.verbose);

      // Enumerate land cells (those with DEM coverage)
      const allCells = enumerateCells();
      const landCells = allCells.filter(c => demFilesForCell(c).length > 0);
      const pendingCells = args.force
        ? landCells
        : landCells.filter(c => !fs.existsSync(cellDoneMarker(c.id)));

      console.log(`\nStep 2: Processing cells (${landCells.length} land cells, ` +
        `${landCells.length - pendingCells.length} already built, ` +
        `${pendingCells.length} to process, parallelism ${args.parallel})...`);

      const results = await processCells(pendingCells, args);
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        console.error(`\n${failed.length} cells failed:`);
        failed.forEach(r => console.error(`  ${r.cellId}: ${r.error?.split('\n')[0]}`));
        console.error('\nRe-run to retry failed cells (completed cells are skipped).');
        process.exit(1);
      }
    }

    console.log('\nStep 3: Merging into PMTiles with tippecanoe...');
    mergeToPmtiles(outputPath, args.verbose);

    // Tier files are the expensive artifact (hours of GDAL work) and enable
    // cheap tippecanoe-only re-merges via --merge-only; keep them by default.
    if (args.cleanWork) {
      cleanWorkDir(WORK_DIR);
    } else {
      console.log(`\n  Work dir kept for --merge-only re-runs: ${WORK_DIR}`);
      console.log('  (pass --clean-work to delete it)');
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const fileSize = fileSizeBytes(outputPath);
    console.log('\n' + '═'.repeat(40));
    console.log('Build Complete');
    console.log('═'.repeat(40));
    console.log(`  Output: ${outputPath}`);
    console.log(`  Size:   ${formatBytes(fileSize)}`);
    console.log(`  Time:   ${elapsed} minutes`);

    if (fileSize > 6 * 1024 * 1024 * 1024) {
      console.log('\n  ⚠ WARNING: Output exceeds 6GB target. Consider additional optimizations.');
    }
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
