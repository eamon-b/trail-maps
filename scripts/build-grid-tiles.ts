/**
 * Grid-Based Tile Pipeline
 *
 * Generates MBTiles files for all of Australia split into 2°×2° grid cells.
 * Each cell produces base.mbtiles + contours.mbtiles, identical in structure
 * to the trail-corridor tiles. Cells can be downloaded and merged on-device
 * to provide offline maps for arbitrary GPX uploads.
 *
 * Prerequisites: gdal (3.6+), tippecanoe, pmtiles CLI
 *
 * Usage:
 *   npx tsx scripts/build-grid-tiles.ts --protomaps-file data/protomaps/planet.pmtiles
 *   npx tsx scripts/build-grid-tiles.ts --cell E114_S34
 *   npx tsx scripts/build-grid-tiles.ts --lon-range 112,126
 *   npx tsx scripts/build-grid-tiles.ts --skip-existing
 *   npx tsx scripts/build-grid-tiles.ts --parallel 4
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { GridIndex, GridCell } from '../src/lib/types.js';
import {
  PROJECT_ROOT,
  DEM_CACHE_DIR,
  run,
  ensureDir,
  cleanWorkDir,
  formatBytes,
  fileSizeBytes,
  checkDependencies,
  clipDem,
  generateContours,
  classifyAndTileContours,
  extractBaseTiles,
  writeManifest,
  mgaEpsgForLon,
} from './tile-pipeline.js';

// --- Grid constants ---

const CELL_SIZE_DEG = 2;
const GRID_LON_MIN = 112;
const GRID_LON_MAX = 154; // exclusive: last cell starts at 152
const GRID_LAT_MIN = 10;  // 10°S
const GRID_LAT_MAX = 44;  // 44°S (exclusive: last cell starts at 42)
const BUFFER_METERS = 1000; // 1km buffer for contour continuity at cell edges

const GRID_WORK_DIR = path.join(PROJECT_ROOT, 'data/tiles/grid');
const GRID_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles/grid');

// --- Grid cell enumeration ---

interface CellDef {
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
  epsg: number;
}

function enumerateCells(opts?: {
  lonMin?: number;
  lonMax?: number;
  latMin?: number;
  latMax?: number;
}): CellDef[] {
  const lonMin = opts?.lonMin ?? GRID_LON_MIN;
  const lonMax = opts?.lonMax ?? GRID_LON_MAX;
  const latMin = opts?.latMin ?? GRID_LAT_MIN;
  const latMax = opts?.latMax ?? GRID_LAT_MAX;

  const cells: CellDef[] = [];
  for (let lon = lonMin; lon < lonMax; lon += CELL_SIZE_DEG) {
    for (let lat = latMin; lat < latMax; lat += CELL_SIZE_DEG) {
      const west = lon;
      const east = lon + CELL_SIZE_DEG;
      const south = lat; // degrees south (stored as positive)
      const north = lat + CELL_SIZE_DEG;
      const lonCenter = west + CELL_SIZE_DEG / 2;
      const id = `E${lon}_S${lat}`;
      cells.push({
        id,
        west,
        south,
        east,
        north,
        epsg: mgaEpsgForLon(lonCenter),
      });
    }
  }
  return cells;
}

function parseCellId(cellId: string): { lon: number; lat: number } | null {
  const m = cellId.match(/^E(\d+)_S(\d+)$/);
  if (!m) return null;
  return { lon: parseInt(m[1], 10), lat: parseInt(m[2], 10) };
}

// --- DEM availability check ---

/**
 * Check which SRTM .hgt files exist for a grid cell's area.
 * Returns the list of .hgt filenames that overlap.
 */
function demFilesForCell(cell: CellDef): string[] {
  if (!fs.existsSync(DEM_CACHE_DIR)) return [];

  const files: string[] = [];
  const demExtensions = ['.hgt', '.tif', '.tiff'];
  // SRTM tile name = SW corner. Cell covers cell.west to cell.east, -cell.north to -cell.south.
  // For a cell E114_S34 (114-116E, 34-36S), we need DEM tiles:
  //   S34E114, S34E115, S35E114, S35E115
  // (where tile S34E114 covers 34S-33S, 114E-115E)
  for (let lat = cell.south; lat < cell.north; lat++) {
    for (let lon = cell.west; lon < cell.east; lon++) {
      const tileName = `S${String(lat).padStart(2, '0')}E${String(lon).padStart(3, '0')}`;
      for (const ext of demExtensions) {
        const demFile = `${tileName}${ext}`;
        if (fs.existsSync(path.join(DEM_CACHE_DIR, demFile))) {
          files.push(demFile);
          break; // found one format, skip others for this tile
        }
      }
    }
  }
  return files;
}

// --- Cell polygon generation ---

/**
 * Generate a GeoJSON polygon for a grid cell, optionally with a buffer.
 * The buffer is applied in projected MGA coordinates for accuracy.
 */
function generateCellPolygon(
  cell: CellDef,
  outputPath: string,
  bufferMeters: number,
  verbose: boolean
): void {
  // Write a simple GeoJSON rectangle. Coordinates are WGS84 (lon/lat).
  // Note: south latitudes are negative in GeoJSON.
  const west = cell.west;
  const east = cell.east;
  const south = -cell.north; // convert to negative latitude
  const north = -cell.south;

  if (bufferMeters > 0) {
    // Create unbuffered GeoJSON with explicit layer name, then use ogr2ogr to buffer in projected CRS
    const unbufferedPath = outputPath.replace('.geojson', '_unbuffered.geojson');
    const layerName = 'cell';
    const geojson = {
      type: 'FeatureCollection',
      name: layerName,
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ]],
        },
      }],
    };
    fs.writeFileSync(unbufferedPath, JSON.stringify(geojson));

    // Buffer in projected CRS, transform back to WGS84
    run([
      'ogr2ogr',
      '-f', 'GeoJSON',
      `"${outputPath}"`,
      `"${unbufferedPath}"`,
      '-dialect', 'sqlite',
      '-sql',
      `"SELECT ST_Transform(ST_Buffer(ST_Transform(geometry, ${cell.epsg}), ${bufferMeters}), 4326) AS geometry FROM ${layerName}"`,
    ].join(' '), { verbose });

    if (fs.existsSync(unbufferedPath)) fs.unlinkSync(unbufferedPath);
  } else {
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ]],
        },
      }],
    };
    fs.writeFileSync(outputPath, JSON.stringify(geojson));
  }
}

// --- CLI argument parsing ---

interface CliArgs {
  cell: string | null;          // --cell E114_S34
  lonRange: [number, number] | null; // --lon-range 112,126
  latRange: [number, number] | null; // --lat-range 30,38
  skipExisting: boolean;        // --skip-existing
  skipBase: boolean;            // --skip-base
  skipContours: boolean;        // --skip-contours
  parallel: number;             // --parallel N
  protomapsUrl: string | null;  // --protomaps-url <url>
  protomapsFile: string | null; // --protomaps-file <path>
  verbose: boolean;             // --verbose
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    cell: null,
    lonRange: null,
    latRange: null,
    skipExisting: false,
    skipBase: false,
    skipContours: false,
    parallel: 1,
    protomapsUrl: null,
    protomapsFile: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--cell':
        result.cell = args[++i];
        break;
      case '--lon-range': {
        const parts = args[++i].split(',').map(Number);
        result.lonRange = [parts[0], parts[1]];
        break;
      }
      case '--lat-range': {
        const parts = args[++i].split(',').map(Number);
        result.latRange = [parts[0], parts[1]];
        break;
      }
      case '--skip-existing':
        result.skipExisting = true;
        break;
      case '--skip-base':
        result.skipBase = true;
        break;
      case '--skip-contours':
        result.skipContours = true;
        break;
      case '--parallel':
        result.parallel = parseInt(args[++i], 10);
        break;
      case '--protomaps-url':
        result.protomapsUrl = args[++i];
        break;
      case '--protomaps-file':
        result.protomapsFile = args[++i];
        break;
      case '--verbose':
        result.verbose = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return result;
}

// --- Per-cell pipeline ---

function processCell(
  cell: CellDef,
  args: CliArgs
): { success: boolean; error?: string; skipped?: boolean } {
  const cellId = cell.id;

  console.log(`\nProcessing cell: ${cellId}`);
  console.log(`  Bounds: ${cell.west}°E to ${cell.east}°E, ${cell.south}°S to ${cell.north}°S`);
  console.log(`  EPSG: ${cell.epsg}`);
  console.log('─'.repeat(40));

  // Check if already built (skip-existing mode)
  const outputDir = path.join(GRID_OUTPUT_DIR, cellId);
  const manifestPath = path.join(outputDir, 'manifest.json');
  if (args.skipExisting && fs.existsSync(manifestPath)) {
    console.log(`  Skipping (already exists)`);
    return { success: true, skipped: true };
  }

  // Check DEM availability
  const demFiles = demFilesForCell(cell);
  if (demFiles.length === 0) {
    console.log(`  Skipping (no DEM tiles — ocean)`);
    return { success: true, skipped: true };
  }
  console.log(`  DEM tiles: ${demFiles.length} .hgt files`);

  // Set up working directories
  const workDir = path.join(GRID_WORK_DIR, cellId);
  ensureDir(workDir);
  ensureDir(outputDir);

  // File paths
  const bufferedPolygonPath = path.join(workDir, 'cell_buffered.geojson');
  const cellPolygonPath = path.join(workDir, 'cell.geojson');
  const demPath = path.join(workDir, 'dem_cell.tif');
  const contoursRawPath = path.join(workDir, 'contours_raw.fgb');
  const contoursClassifiedPath = path.join(workDir, 'contours.fgb');
  const contoursMbtilesPath = path.join(workDir, 'contours.mbtiles');
  const basePmtilesPath = path.join(workDir, 'base.pmtiles');
  const baseMbtilesPath = path.join(workDir, 'base.mbtiles');

  const outputBaseMbtiles = path.join(outputDir, 'base.mbtiles');
  const outputContoursMbtiles = path.join(outputDir, 'contours.mbtiles');

  try {
    // Step 1: Generate cell polygons
    // Buffered polygon for DEM clipping (contour continuity at edges)
    if (!args.skipContours) {
      console.log('  Step 1a: Generating buffered cell polygon...');
      generateCellPolygon(cell, bufferedPolygonPath, BUFFER_METERS, args.verbose);
    }
    // Unbuffered polygon for base tile extraction
    if (!args.skipBase) {
      console.log('  Step 1b: Generating cell polygon...');
      generateCellPolygon(cell, cellPolygonPath, 0, args.verbose);
    }

    // Step 2-4: Contours
    if (!args.skipContours) {
      clipDem(bufferedPolygonPath, demPath, args.verbose);

      // Check if DEM produced any data (could be all-ocean margin)
      if (!fs.existsSync(demPath) || fileSizeBytes(demPath) < 100) {
        console.log(`  Skipping contours (DEM is empty/trivial)`);
      } else {
        generateContours(demPath, contoursRawPath, args.verbose);

        // Check if contours are empty (flat terrain / ocean margin)
        if (fs.existsSync(contoursRawPath) && fileSizeBytes(contoursRawPath) > 100) {
          classifyAndTileContours(contoursRawPath, contoursClassifiedPath, contoursMbtilesPath, args.verbose);
          fs.copyFileSync(contoursMbtilesPath, outputContoursMbtiles);
        } else {
          console.log(`  Skipping contour tiling (no contour features)`);
        }
      }
    }

    // Step 5: Base map tiles
    if (!args.skipBase) {
      const protomapsSource = args.protomapsUrl
        || args.protomapsFile
        || path.join(PROJECT_ROOT, 'data/protomaps/planet.pmtiles');

      if (!args.protomapsUrl && !fs.existsSync(protomapsSource)) {
        throw new Error(`Protomaps source not found: ${protomapsSource}`);
      }

      extractBaseTiles(cellPolygonPath, basePmtilesPath, baseMbtilesPath, protomapsSource, args.verbose);
      fs.copyFileSync(baseMbtilesPath, outputBaseMbtiles);
    }

    // Write manifest
    const bounds = {
      west: cell.west,
      south: -cell.north,  // negative latitude
      east: cell.east,
      north: -cell.south,
    };
    const manifestFiles = [
      { name: 'base.mbtiles', path: outputBaseMbtiles },
      { name: 'contours.mbtiles', path: outputContoursMbtiles },
    ];
    const manifest = writeManifest(cellId, outputDir, bounds, manifestFiles);

    // Clean up work directory
    cleanWorkDir(workDir);

    console.log(`  ✓ Complete: ${cellId} (${formatBytes(manifest.totalSize)})`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ Error processing ${cellId}: ${message}`);
    return { success: false, error: message };
  }
}

// --- Grid index generation ---

function generateGridIndex(): void {
  console.log('\nGenerating grid index...');

  const cells: GridCell[] = [];

  if (!fs.existsSync(GRID_OUTPUT_DIR)) {
    console.log('  No grid output directory found.');
    return;
  }

  const entries = fs.readdirSync(GRID_OUTPUT_DIR)
    .filter(name => {
      const fullPath = path.join(GRID_OUTPUT_DIR, name);
      return fs.statSync(fullPath).isDirectory() && parseCellId(name) !== null;
    })
    .sort();

  for (const name of entries) {
    const manifestPath = path.join(GRID_OUTPUT_DIR, name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const parsed = parseCellId(name)!;

    cells.push({
      id: name,
      bounds: [
        parsed.lon,
        -(parsed.lat + CELL_SIZE_DEG),  // south (negative)
        parsed.lon + CELL_SIZE_DEG,
        -parsed.lat,                     // north (negative)
      ],
      totalSize: manifest.totalSize,
    });
  }

  const index: GridIndex = {
    version: new Date().toISOString().split('T')[0],
    cellSizeDeg: [CELL_SIZE_DEG, CELL_SIZE_DEG],
    bounds: [GRID_LON_MIN, -GRID_LAT_MAX, GRID_LON_MAX, -GRID_LAT_MIN],
    cells,
  };

  const indexPath = path.join(GRID_OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`  ✓ Grid index: ${indexPath} (${cells.length} cells)`);
}

// --- Parallel execution ---

async function processInParallel(
  cells: CellDef[],
  args: CliArgs,
  maxParallel: number
): Promise<{ cellId: string; success: boolean; error?: string; skipped?: boolean }[]> {
  const results: { cellId: string; success: boolean; error?: string; skipped?: boolean }[] = [];

  if (maxParallel <= 1) {
    // Serial execution
    for (const cell of cells) {
      const result = processCell(cell, args);
      results.push({ cellId: cell.id, ...result });
    }
    return results;
  }

  // Parallel execution: spawn child processes
  // Each child runs this same script with --cell <id>
  const scriptPath = new URL(import.meta.url).pathname;
  const queue = [...cells];

  const baseArgs: string[] = [];
  if (args.skipExisting) baseArgs.push('--skip-existing');
  if (args.skipBase) baseArgs.push('--skip-base');
  if (args.skipContours) baseArgs.push('--skip-contours');
  if (args.verbose) baseArgs.push('--verbose');
  if (args.protomapsUrl) baseArgs.push('--protomaps-url', args.protomapsUrl);
  if (args.protomapsFile) baseArgs.push('--protomaps-file', args.protomapsFile);

  // Process in batches
  while (queue.length > 0) {
    const batch = queue.splice(0, maxParallel);
    const promises = batch.map(cell => {
      return new Promise<{ cellId: string; success: boolean; error?: string }>((resolve) => {
        const childArgs = ['tsx', scriptPath, '--cell', cell.id, ...baseArgs];
        execFile('npx', childArgs, {
          cwd: PROJECT_ROOT,
          maxBuffer: 50 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (args.verbose) {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
          }
          if (error) {
            resolve({ cellId: cell.id, success: false, error: error.message });
          } else {
            resolve({ cellId: cell.id, success: true });
          }
        });
      });
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
}

// --- Main ---

async function main(): Promise<void> {
  console.log('Grid-Based Tile Pipeline');
  console.log('========================\n');

  const args = parseArgs();

  // Check dependencies
  console.log('Checking dependencies...');
  checkDependencies({ skipContours: args.skipContours, skipBase: args.skipBase });
  console.log('  ✓ All dependencies found\n');

  // Ensure directories
  ensureDir(GRID_WORK_DIR);
  ensureDir(GRID_OUTPUT_DIR);

  // Determine which cells to process
  let cells: CellDef[];

  if (args.cell) {
    // Single cell
    const parsed = parseCellId(args.cell);
    if (!parsed) {
      console.error(`Invalid cell ID: ${args.cell} (expected format: E114_S34)`);
      process.exit(1);
    }
    const lonCenter = parsed.lon + CELL_SIZE_DEG / 2;
    cells = [{
      id: args.cell,
      west: parsed.lon,
      south: parsed.lat,
      east: parsed.lon + CELL_SIZE_DEG,
      north: parsed.lat + CELL_SIZE_DEG,
      epsg: mgaEpsgForLon(lonCenter),
    }];
  } else {
    // Enumerate cells with optional range filters
    cells = enumerateCells({
      lonMin: args.lonRange?.[0],
      lonMax: args.lonRange?.[1],
      latMin: args.latRange?.[0],
      latMax: args.latRange?.[1],
    });
  }

  console.log(`Cells to process: ${cells.length}`);
  if (args.skipExisting) console.log('Mode: skip existing');
  if (args.parallel > 1) console.log(`Parallelism: ${args.parallel}`);
  console.log('');

  // Process cells
  const results = await processInParallel(cells, args, args.parallel);

  // Generate grid index
  generateGridIndex();

  // Summary
  console.log('\n' + '═'.repeat(40));
  console.log('Summary');
  console.log('═'.repeat(40));

  const succeeded = results.filter(r => r.success && !r.skipped);
  const skipped = results.filter(r => r.skipped);
  const failed = results.filter(r => !r.success);

  console.log(`\nBuilt:   ${succeeded.length}`);
  console.log(`Skipped: ${skipped.length} (ocean / already exists)`);
  console.log(`Failed:  ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailed cells:');
    failed.forEach(r => console.log(`  ${r.cellId}: ${r.error}`));
  }

  // Report total output size
  let totalSize = 0;
  for (const r of results) {
    if (r.success) {
      const manifestPath = path.join(GRID_OUTPUT_DIR, r.cellId, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        totalSize += manifest.totalSize;
      }
    }
  }
  console.log(`\nTotal output size: ${formatBytes(totalSize)}`);
  console.log(`Output: ${GRID_OUTPUT_DIR}`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
