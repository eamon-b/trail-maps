/**
 * Australia-Wide Contour PMTiles Build
 *
 * Generates a single PMTiles file containing contour lines for all of
 * Australia. Unlike the grid pipeline (which splits into cells), this
 * produces one output file suitable for serving via Cloudflare Worker.
 *
 * Prerequisites: gdal (3.6+), tippecanoe
 *
 * Usage:
 *   npx tsx scripts/build-contours-australia.ts
 *   npx tsx scripts/build-contours-australia.ts --verbose
 *   npx tsx scripts/build-contours-australia.ts --skip-smooth
 *   npx tsx scripts/build-contours-australia.ts --output-dir /path/to/output
 */

import * as fs from 'fs';
import * as path from 'path';
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
  smoothDem,
} from './tile-pipeline.js';

// --- Constants ---

const CONTOUR_MIN_ZOOM = 9;
const WORK_DIR = path.join(PROJECT_ROOT, 'data/tiles/contours-australia');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');
const OUTPUT_FILENAME = 'australia-contours.pmtiles';

// --- CLI argument parsing ---

interface CliArgs {
  verbose: boolean;
  skipSmooth: boolean;
  outputDir: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    verbose: false,
    skipSmooth: false,
    outputDir: DEFAULT_OUTPUT_DIR,
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
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return result;
}

// --- Pipeline steps ---

/**
 * Build a VRT mosaic of ALL DEM tiles in data/dem/.
 */
function buildDemMosaic(vrtPath: string, verbose: boolean): void {
  console.log('Step 1: Building DEM mosaic...');

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

  const demPaths = demFiles.map(f => `"${path.join(DEM_CACHE_DIR, f)}"`).join(' ');
  run(`gdalbuildvrt -vrtnodata -9999 "${vrtPath}" ${demPaths}`, { verbose });

  console.log(`  ✓ VRT mosaic: ${vrtPath}`);
}

/**
 * Generate contour lines from the DEM mosaic.
 */
function generateContours(
  demPath: string,
  contoursPath: string,
  verbose: boolean
): void {
  console.log('Step 3: Generating contour lines...');

  if (fs.existsSync(contoursPath)) fs.unlinkSync(contoursPath);

  run([
    'gdal_contour',
    '-a elevation',
    `-i ${CONTOUR_INTERVAL}`,
    '-snodata -9999',
    '-f FlatGeobuf',
    `"${demPath}"`,
    `"${contoursPath}"`,
  ].join(' '), { verbose });

  console.log(`  ✓ Raw contours: ${contoursPath} (${formatBytes(fileSizeBytes(contoursPath))})`);
}

/**
 * Classify contours with is_index field.
 */
function classifyContours(
  rawPath: string,
  classifiedPath: string,
  verbose: boolean
): void {
  console.log('Step 4: Classifying contours...');

  if (fs.existsSync(classifiedPath)) fs.unlinkSync(classifiedPath);

  const rawLayerName = 'contour';
  const classifiedLayerName = 'contour';

  run([
    'ogr2ogr',
    '-f FlatGeobuf',
    `"${classifiedPath}"`,
    `"${rawPath}"`,
    `-nln ${classifiedLayerName}`,
    '-dialect sqlite',
    '-sql',
    `"SELECT geometry, elevation, CAST(CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS INTEGER) AS is_index FROM '${rawLayerName}'"`,
  ].join(' '), { verbose });

  console.log(`  ✓ Classified contours: ${classifiedPath} (${formatBytes(fileSizeBytes(classifiedPath))})`);
}

/**
 * Split contours into zoom tiers and tile into a single PMTiles file.
 */
function tileContours(
  classifiedPath: string,
  outputPath: string,
  verbose: boolean
): void {
  console.log('Step 5: Splitting into zoom tiers...');

  const classifiedLayerName = 'contour';
  const tiers = [
    { suffix: 'z9',  minZoom: 9,  sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 100) = 0` },
    { suffix: 'z10', minZoom: 10, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 50) = 0 AND (CAST(elevation AS INTEGER) % 100) != 0` },
    { suffix: 'z12', minZoom: 12, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 20) = 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
    { suffix: 'z13', minZoom: 13, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 20) != 0` },
  ];

  const tierFiles: { path: string; minZoom: number; suffix: string }[] = [];

  for (const tier of tiers) {
    const tierPath = path.join(WORK_DIR, `contours_${tier.suffix}.fgb`);
    if (fs.existsSync(tierPath)) fs.unlinkSync(tierPath);

    run([
      'ogr2ogr',
      '-f FlatGeobuf',
      `"${tierPath}"`,
      `"${classifiedPath}"`,
      '-dialect sqlite',
      '-sql',
      `"${tier.sql}"`,
    ].join(' '), { verbose });

    if (fs.existsSync(tierPath) && fileSizeBytes(tierPath) > 0) {
      tierFiles.push({ path: tierPath, minZoom: tier.minZoom, suffix: tier.suffix });
      console.log(`  ${tier.suffix}: ${formatBytes(fileSizeBytes(tierPath))}`);
    }
  }

  // Build layer args for tippecanoe
  console.log('\nStep 6: Tiling with tippecanoe (PMTiles output)...');

  const layerArgs = tierFiles.map(({ path: filePath, minZoom }) => {
    const config = JSON.stringify({ file: filePath, layer: 'contour', minzoom: minZoom });
    return `-L '${config}'`;
  });

  run([
    'tippecanoe',
    `-o "${outputPath}"`,
    `-Z${CONTOUR_MIN_ZOOM}`,
    `-z${MAX_ZOOM}`,
    '-P',
    '-y elevation',
    '-y is_index',
    '--drop-smallest-as-needed',
    '--simplification=14',
    '--minimum-detail=4',
    '--force',
    ...layerArgs,
  ].join(' '), { verbose });

  // Clean up tier files
  for (const tier of tierFiles) {
    if (fs.existsSync(tier.path)) fs.unlinkSync(tier.path);
  }

  console.log(`  ✓ PMTiles output: ${outputPath} (${formatBytes(fileSizeBytes(outputPath))})`);
}

// --- Main ---

async function main(): Promise<void> {
  console.log('Australia-Wide Contour PMTiles Build');
  console.log('====================================\n');

  const args = parseArgs();

  // Check dependencies (only need contour tools, not base map tools)
  console.log('Checking dependencies...');
  checkDependencies({ skipBase: true });
  console.log('  ✓ All dependencies found\n');

  // Ensure directories
  ensureDir(WORK_DIR);
  ensureDir(args.outputDir);

  const startTime = Date.now();

  // File paths
  const vrtPath = path.join(WORK_DIR, 'dem_mosaic.vrt');
  const smoothedPath = path.join(WORK_DIR, 'dem_smoothed.tif');
  const contoursRawPath = path.join(WORK_DIR, 'contours_raw.fgb');
  const contoursClassifiedPath = path.join(WORK_DIR, 'contours.fgb');
  const outputPath = path.join(args.outputDir, OUTPUT_FILENAME);

  try {
    // Step 1: Build VRT mosaic
    buildDemMosaic(vrtPath, args.verbose);

    // Step 2: Smooth the DEM (optional)
    let contourInputPath = vrtPath;
    if (!args.skipSmooth) {
      console.log('\nStep 2: Smoothing DEM...');
      smoothDem(vrtPath, smoothedPath, args.verbose);
      contourInputPath = smoothedPath;
    } else {
      console.log('\nStep 2: Skipping DEM smoothing (--skip-smooth)');
    }

    // Step 3: Generate contours
    console.log('');
    generateContours(contourInputPath, contoursRawPath, args.verbose);

    // Step 4: Classify contours
    console.log('');
    classifyContours(contoursRawPath, contoursClassifiedPath, args.verbose);

    // Step 5-6: Split into tiers and tile
    console.log('');
    tileContours(contoursClassifiedPath, outputPath, args.verbose);

    // Clean up work directory (keep output)
    cleanWorkDir(WORK_DIR);

    // Report
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
