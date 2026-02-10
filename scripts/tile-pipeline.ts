/**
 * Shared tile pipeline functions.
 *
 * Extracted from build-tiles.ts so that both the trail-corridor pipeline
 * and the grid-based pipeline can reuse them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, type ExecSyncOptions } from 'child_process';
import type { TileManifest, TileManifestFile } from '../src/lib/types.js';

// --- Path setup ---

const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
export const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const DEM_CACHE_DIR = path.join(PROJECT_ROOT, 'data/dem');

// --- Constants ---

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 15;
export const CONTOUR_INTERVAL = 10; // metres
export const INDEX_CONTOUR_INTERVAL = 50; // metres (bold lines)

// --- Utility functions ---

export function run(cmd: string, options?: { cwd?: string; verbose?: boolean }): string {
  const execOptions: ExecSyncOptions = {
    encoding: 'utf-8',
    cwd: options?.cwd ?? PROJECT_ROOT,
    stdio: options?.verbose ? 'inherit' : 'pipe',
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
  };

  try {
    const result = execSync(cmd, execOptions);
    return typeof result === 'string' ? result.trim() : '';
  } catch (error) {
    const execError = error as { stderr?: string; status?: number };
    console.error(`Command failed: ${cmd}`);
    if (execError.stderr) {
      console.error(execError.stderr);
    }
    throw error;
  }
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function fileSha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function fileSizeBytes(filePath: string): number {
  return fs.statSync(filePath).size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Dependency checking ---

interface DependencyCheck {
  name: string;
  command: string;
}

export function checkDependencies(opts: {
  skipContours?: boolean;
  skipBase?: boolean;
}): void {
  const deps: DependencyCheck[] = [];

  // Always need ogr2ogr for corridor/polygon generation
  deps.push({ name: 'GDAL (ogr2ogr)', command: 'ogr2ogr --version' });

  if (!opts.skipContours) {
    deps.push({ name: 'GDAL (gdalwarp)', command: 'gdalwarp --version' });
    deps.push({ name: 'GDAL (gdal_contour)', command: 'gdal_contour --version' });
    deps.push({ name: 'tippecanoe', command: 'tippecanoe --version' });
  }

  if (!opts.skipBase) {
    deps.push({ name: 'pmtiles', command: 'pmtiles version' });
    // tile-join exits non-zero for all flags; just check it exists
    deps.push({ name: 'tile-join', command: 'which tile-join' });
  }

  const missing: string[] = [];
  for (const dep of deps) {
    try {
      run(dep.command);
    } catch {
      missing.push(dep.name);
    }
  }

  if (missing.length > 0) {
    console.error('\nMissing required dependencies:');
    missing.forEach(d => console.error(`  - ${d}`));
    console.error('\nInstall them before running this script.');
    process.exit(1);
  }
}

// --- Pipeline step functions ---

/**
 * Build a VRT mosaic of cached DEM tiles, then clip to a region polygon.
 */
export function clipDem(
  regionPath: string,
  demOutputPath: string,
  verbose: boolean
): void {
  console.log('  Clipping DEM to region...');

  // Check for cached DEM tiles
  if (!fs.existsSync(DEM_CACHE_DIR)) {
    console.error(`    ✗ DEM cache directory not found: ${DEM_CACHE_DIR}`);
    console.error('    Download SRTM DEM tiles first.');
    throw new Error('DEM tiles not found');
  }

  const demExtensions = ['.tif', '.tiff', '.hgt'];
  const demFiles = fs.readdirSync(DEM_CACHE_DIR).filter(f =>
    demExtensions.some(ext => f.toLowerCase().endsWith(ext))
  );
  if (demFiles.length === 0) {
    throw new Error(`No DEM files (.tif, .hgt) found in ${DEM_CACHE_DIR}`);
  }

  // Build VRT mosaic from all DEM tiles
  const vrtPath = path.join(path.dirname(demOutputPath), 'dem_mosaic.vrt');
  const demPaths = demFiles.map(f => `"${path.join(DEM_CACHE_DIR, f)}"`).join(' ');
  run(`gdalbuildvrt -vrtnodata -9999 "${vrtPath}" ${demPaths}`, { verbose });

  // Clip to region polygon (overwrite if re-running)
  run([
    'gdalwarp',
    '-overwrite',
    `-cutline "${regionPath}"`,
    '-crop_to_cutline',
    '-dstnodata -9999',
    '-co COMPRESS=LZW',
    '-co TILED=YES',
    `"${vrtPath}"`,
    `"${demOutputPath}"`,
  ].join(' '), { verbose });

  // Clean up VRT
  if (fs.existsSync(vrtPath)) fs.unlinkSync(vrtPath);

  console.log(`    ✓ DEM clipped: ${demOutputPath} (${formatBytes(fileSizeBytes(demOutputPath))})`);
}

/**
 * Generate contour lines from DEM.
 */
export function generateContours(
  demPath: string,
  contoursRawPath: string,
  verbose: boolean
): void {
  console.log('  Generating contour lines...');

  // Remove existing output (gdal_contour won't overwrite)
  if (fs.existsSync(contoursRawPath)) fs.unlinkSync(contoursRawPath);

  run([
    'gdal_contour',
    '-a elevation',
    `-i ${CONTOUR_INTERVAL}`,
    '-snodata -9999',
    '-f FlatGeobuf',
    `"${demPath}"`,
    `"${contoursRawPath}"`,
  ].join(' '), { verbose });

  console.log(`    ✓ Raw contours: ${contoursRawPath} (${formatBytes(fileSizeBytes(contoursRawPath))})`);
}

/**
 * Classify contours and convert to MBTiles vector tiles.
 * Adds is_index field (1 for every 50m contour, 0 otherwise).
 * Uses zoom-dependent filtering for contour density.
 */
export function classifyAndTileContours(
  contoursRawPath: string,
  contoursClassifiedPath: string,
  contoursMbtilesPath: string,
  verbose: boolean
): void {
  console.log('  Classifying and tiling contours...');

  // 4a: Add is_index field
  if (fs.existsSync(contoursClassifiedPath)) fs.unlinkSync(contoursClassifiedPath);
  const rawLayerName = 'contour';
  const classifiedLayerName = 'contour';
  run([
    'ogr2ogr',
    '-f FlatGeobuf',
    `"${contoursClassifiedPath}"`,
    `"${contoursRawPath}"`,
    `-nln ${classifiedLayerName}`,
    '-dialect sqlite',
    '-sql',
    `"SELECT geometry, elevation, CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS is_index FROM '${rawLayerName}'"`,
  ].join(' '), { verbose });

  // 4b: Split into zoom-tier files for density control
  const workDir = path.dirname(contoursMbtilesPath);
  const tiers = [
    { suffix: 'z9',  minZoom: 9,  sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 100) = 0` },
    { suffix: 'z11', minZoom: 11, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 50) = 0 AND (CAST(elevation AS INTEGER) % 100) != 0` },
    { suffix: 'z12', minZoom: 12, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 20) = 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
    { suffix: 'z13', minZoom: 13, sql: `SELECT * FROM '${classifiedLayerName}' WHERE (CAST(elevation AS INTEGER) % 20) != 0` },
  ];

  const tierFiles: { path: string; minZoom: number; suffix: string }[] = [];
  for (const tier of tiers) {
    const tierPath = path.join(workDir, `contours_${tier.suffix}.fgb`);
    if (fs.existsSync(tierPath)) fs.unlinkSync(tierPath);
    run([
      'ogr2ogr',
      '-f FlatGeobuf',
      `"${tierPath}"`,
      `"${contoursClassifiedPath}"`,
      '-dialect sqlite',
      '-sql',
      `"${tier.sql}"`,
    ].join(' '), { verbose });

    if (fs.existsSync(tierPath) && fileSizeBytes(tierPath) > 0) {
      tierFiles.push({ path: tierPath, minZoom: tier.minZoom, suffix: tier.suffix });
      console.log(`    ${tier.suffix}: ${formatBytes(fileSizeBytes(tierPath))}`);
    }
  }

  // 4c: Generate vector tiles with per-tier zoom ranges
  const layerArgs = tierFiles.map(({ path: filePath, minZoom }) => {
    const config = JSON.stringify({ file: filePath, layer: 'contour', minzoom: minZoom });
    return `-L '${config}'`;
  });

  run([
    'tippecanoe',
    `-o "${contoursMbtilesPath}"`,
    `-z${MAX_ZOOM}`,
    '-P',
    '-y elevation',
    '-y is_index',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--simplification=10',
    '--force',
    ...layerArgs,
  ].join(' '), { verbose });

  // Clean up intermediate tier files
  for (const tier of tiers) {
    const tierPath = path.join(workDir, `contours_${tier.suffix}.fgb`);
    if (fs.existsSync(tierPath)) fs.unlinkSync(tierPath);
  }

  console.log(`    ✓ Contour tiles: ${contoursMbtilesPath} (${formatBytes(fileSizeBytes(contoursMbtilesPath))})`);
}

/**
 * Extract base map vector tiles from Protomaps.
 * Supports both remote HTTP extraction and local file extraction.
 */
export function extractBaseTiles(
  regionPath: string,
  basePmtilesPath: string,
  baseMbtilesPath: string,
  protomapsSource: string,
  verbose: boolean
): void {
  console.log('  Extracting base map tiles...');

  // Extract region from Protomaps
  run([
    'pmtiles', 'extract',
    `"${protomapsSource}"`,
    `"${basePmtilesPath}"`,
    `--region="${regionPath}"`,
    `--maxzoom=${MAX_ZOOM}`,
  ].join(' '), { verbose });

  // Convert PMTiles to MBTiles for React Native compatibility
  run([
    'tile-join',
    `-o "${baseMbtilesPath}"`,
    '--force',
    `"${basePmtilesPath}"`,
  ].join(' '), { verbose });

  console.log(`    ✓ Base tiles: ${baseMbtilesPath} (${formatBytes(fileSizeBytes(baseMbtilesPath))})`);
}

/**
 * Write tile manifest JSON.
 *
 * @param id - Identifier (trail ID or grid cell ID)
 * @param outputDir - Directory to write manifest.json into
 * @param bounds - Geographic bounds [west, south, east, north]
 * @param files - List of tile files to include in the manifest
 */
export function writeManifest(
  id: string,
  outputDir: string,
  bounds: { west: number; south: number; east: number; north: number },
  files: { name: string; path: string }[]
): TileManifest {
  const manifestFiles: TileManifestFile[] = [];

  for (const file of files) {
    if (fs.existsSync(file.path)) {
      manifestFiles.push({
        name: file.name,
        size: fileSizeBytes(file.path),
        sha256: fileSha256(file.path),
      });
    }
  }

  const manifest: TileManifest = {
    trailId: id,
    version: new Date().toISOString().split('T')[0],
    files: manifestFiles,
    totalSize: manifestFiles.reduce((sum, f) => sum + f.size, 0),
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
    zoomRange: [MIN_ZOOM, MAX_ZOOM],
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
