/**
 * Topographic Tile Pipeline
 *
 * Generates MBTiles files for each trail from open data:
 *   1. Creates corridor polygon from GPX track (buffered 20km)
 *   2. Downloads/clips SRTM DEM to corridor
 *   3. Generates contour line vector tiles
 *   4. Extracts base map vector tiles from Protomaps
 *   5. Writes tile manifest JSON
 *
 * Prerequisites: gdal (3.6+), tippecanoe, pmtiles CLI
 *
 * Usage:
 *   npx tsx scripts/build-tiles.ts                    # All trails
 *   npx tsx scripts/build-tiles.ts --trail bibbulmun  # Single trail
 *   npx tsx scripts/build-tiles.ts --skip-base        # Skip base map extraction
 *   npx tsx scripts/build-tiles.ts --skip-contours    # Skip contour generation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, type ExecSyncOptions } from 'child_process';
import { JSDOM } from 'jsdom';
import type { TileManifest, TileManifestFile, TrailTileConfig } from '../src/lib/types.js';

// --- Path setup (matches build-trails.ts pattern) ---

const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const TRAILS_DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const DEM_CACHE_DIR = path.join(PROJECT_ROOT, 'data/dem');
const TILES_WORK_DIR = path.join(PROJECT_ROOT, 'data/tiles');
const TILES_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');

// --- MGA Zone mapping for Australian trails ---
// Each trail needs a projected CRS for accurate buffering.
// MGA (Map Grid of Australia) zones use EPSG:283XX where XX is the zone number.

const TRAIL_TILE_CONFIGS: Record<string, TrailTileConfig> = {
  'bibbulmun':       { mgaZone: 50, epsg: 28350 },
  'cape_to_cape':    { mgaZone: 50, epsg: 28350 },
  'heysen':          { mgaZone: 54, epsg: 28354 },
  'larapinta':       { mgaZone: 53, epsg: 28353 },
  'aawt':            { mgaZone: 55, epsg: 28355 },
  'hume-and-hovell': { mgaZone: 55, epsg: 28355 },
};

const BUFFER_DISTANCE_METERS = 20_000; // 20km corridor buffer
const MIN_ZOOM = 8;
const MAX_ZOOM = 15;
const CONTOUR_INTERVAL = 10; // metres
const INDEX_CONTOUR_INTERVAL = 50; // metres (bold lines)

// --- CLI argument parsing ---

interface CliArgs {
  trail: string | null;      // --trail <id> to process single trail
  skipBase: boolean;         // --skip-base
  skipContours: boolean;     // --skip-contours
  protomapsUrl: string | null; // --protomaps-url <url> (remote PMTiles URL)
  protomapsFile: string | null; // --protomaps-file <path> (local PMTiles file)
  verbose: boolean;          // --verbose
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    trail: null,
    skipBase: false,
    skipContours: false,
    protomapsUrl: null,
    protomapsFile: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--trail':
        result.trail = args[++i];
        break;
      case '--skip-base':
        result.skipBase = true;
        break;
      case '--skip-contours':
        result.skipContours = true;
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

// --- Utility functions ---

function run(cmd: string, options?: { cwd?: string; verbose?: boolean }): string {
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

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fileSha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fileSizeBytes(filePath: string): number {
  return fs.statSync(filePath).size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Dependency checking ---

interface DependencyCheck {
  name: string;
  command: string;
  minVersion?: string;
}

function checkDependencies(args: CliArgs): void {
  const deps: DependencyCheck[] = [];

  // Always need ogr2ogr for corridor generation
  deps.push({ name: 'GDAL (ogr2ogr)', command: 'ogr2ogr --version' });

  if (!args.skipContours) {
    deps.push({ name: 'GDAL (gdalwarp)', command: 'gdalwarp --version' });
    deps.push({ name: 'GDAL (gdal_contour)', command: 'gdal_contour --version' });
    deps.push({ name: 'tippecanoe', command: 'tippecanoe --version' });
  }

  if (!args.skipBase) {
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
    console.error('\nInstall them before running this script. See plans/topo-tile-pipeline.md for instructions.');
    process.exit(1);
  }
}

// --- GPX track reading ---

interface TrackPoint {
  lat: number;
  lon: number;
}

function readGpxTrackPoints(gpxPath: string): TrackPoint[] {
  const xml = fs.readFileSync(gpxPath, 'utf-8');
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  const points: TrackPoint[] = [];

  // Get all track points
  const trkpts = doc.querySelectorAll('trkseg trkpt');
  for (const pt of Array.from(trkpts) as Element[]) {
    points.push({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
    });
  }

  // Fall back to route points if no tracks
  if (points.length === 0) {
    const rtepts = doc.querySelectorAll('rte rtept');
    for (const pt of Array.from(rtepts) as Element[]) {
      points.push({
        lat: parseFloat(pt.getAttribute('lat') || '0'),
        lon: parseFloat(pt.getAttribute('lon') || '0'),
      });
    }
  }

  return points;
}

function computeBounds(points: TrackPoint[]): { west: number; south: number; east: number; north: number } {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const p of points) {
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return { west, south, east, north };
}

// --- Pipeline step functions ---

/**
 * Step 1: Generate corridor polygon from GPX track.
 * Buffers the track by BUFFER_DISTANCE_METERS in the trail's MGA zone,
 * then transforms back to WGS84.
 */
function generateCorridor(
  gpxPath: string,
  corridorPath: string,
  epsg: number,
  verbose: boolean
): void {
  console.log('  Step 1: Generating corridor polygon...');

  // ogr2ogr with SQLite dialect for ST_Buffer in projected CRS
  const cmd = [
    'ogr2ogr',
    '-f', 'GeoJSON',
    `"${corridorPath}"`,
    `"${gpxPath}"`,
    '-dialect', 'sqlite',
    '-sql',
    `"SELECT ST_Union(ST_Transform(ST_Buffer(ST_Transform(geometry, ${epsg}), ${BUFFER_DISTANCE_METERS}), 4326)) AS geometry FROM tracks"`,
  ].join(' ');

  run(cmd, { verbose });
  console.log(`    ✓ Corridor: ${corridorPath}`);
}

/**
 * Step 2: Build a VRT mosaic of cached DEM tiles, then clip to corridor.
 */
function clipDem(
  corridorPath: string,
  demOutputPath: string,
  verbose: boolean
): void {
  console.log('  Step 2: Clipping DEM to corridor...');

  // Check for cached DEM tiles
  if (!fs.existsSync(DEM_CACHE_DIR)) {
    console.error(`    ✗ DEM cache directory not found: ${DEM_CACHE_DIR}`);
    console.error('    Download SRTM DEM tiles via the ELVIS portal (https://elevation.fsdf.org.au/)');
    console.error('    and place GeoTIFF files in data/dem/');
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

  // Clip to corridor polygon (overwrite if re-running)
  run([
    'gdalwarp',
    '-overwrite',
    `-cutline "${corridorPath}"`,
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
 * Step 3: Generate contour lines from DEM.
 */
function generateContours(
  demPath: string,
  contoursRawPath: string,
  verbose: boolean
): void {
  console.log('  Step 3: Generating contour lines...');

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
 * Step 4: Classify contours and convert to MBTiles vector tiles.
 * Adds is_index field (1 for every 50m contour, 0 otherwise).
 * Uses zoom-dependent filtering for contour density.
 */
function classifyAndTileContours(
  contoursRawPath: string,
  contoursClassifiedPath: string,
  contoursMbtilesPath: string,
  verbose: boolean
): void {
  console.log('  Step 4: Classifying and tiling contours...');

  // Add is_index field (need SQLite dialect for CAST support)
  if (fs.existsSync(contoursClassifiedPath)) fs.unlinkSync(contoursClassifiedPath);
  // gdal_contour names the layer "contour" by default in FlatGeobuf output
  const layerName = 'contour';
  run([
    'ogr2ogr',
    '-f FlatGeobuf',
    `"${contoursClassifiedPath}"`,
    `"${contoursRawPath}"`,
    '-dialect sqlite',
    '-sql',
    `"SELECT geometry, elevation, CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS is_index FROM '${layerName}'"`,
  ].join(' '), { verbose });

  // Convert contours to vector tiles
  // Include all contours — zoom-dependent density is handled by the MapLibre style
  // using minzoom and filters on the is_index and elevation properties.
  // tippecanoe's --drop-densest-as-needed handles tile size limits automatically.
  run([
    'tippecanoe',
    `-o "${contoursMbtilesPath}"`,
    `-Z9 -z${MAX_ZOOM}`,
    '-P',                       // Read input in parallel
    '-y elevation',
    '-y is_index',
    '-l contour',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--simplification=10',
    '--drop-densest-as-needed', // Auto-drop dense contours at low zoom
    '--force',                  // Overwrite existing output
    `"${contoursClassifiedPath}"`,
  ].join(' '), { verbose });

  console.log(`    ✓ Contour tiles: ${contoursMbtilesPath} (${formatBytes(fileSizeBytes(contoursMbtilesPath))})`);
}

/**
 * Step 5: Extract base map vector tiles from Protomaps.
 * Supports both remote HTTP extraction and local file extraction.
 */
function extractBaseTiles(
  corridorPath: string,
  basePmtilesPath: string,
  baseMbtilesPath: string,
  protomapsSource: string, // URL or local file path
  verbose: boolean
): void {
  console.log('  Step 5: Extracting base map tiles...');

  // Extract corridor region from Protomaps
  run([
    'pmtiles', 'extract',
    `"${protomapsSource}"`,
    `"${basePmtilesPath}"`,
    `--region="${corridorPath}"`,
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
 * Write tile manifest JSON for a trail.
 */
function writeManifest(
  trailId: string,
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
    trailId,
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

// --- Main pipeline ---

interface TrailConfig {
  id: string;
  gpxFile: string;
}

function findGpxFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  return files.find(f => f.toLowerCase().endsWith('.gpx')) || null;
}

function loadTrailConfig(trailDir: string): TrailConfig {
  const configPath = path.join(trailDir, 'trail.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No trail.json found in ${trailDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Resolve GPX file: use trail.json gpxFile if it exists on disk, otherwise search directory
  let gpxFile = raw.gpxFile;
  if (!gpxFile || !fs.existsSync(path.join(trailDir, gpxFile))) {
    const found = findGpxFile(trailDir);
    if (!found) {
      throw new Error(`No GPX file found in ${trailDir}`);
    }
    gpxFile = found;
  }

  return { id: raw.id, gpxFile };
}

async function processTrail(
  trailDir: string,
  args: CliArgs
): Promise<void> {
  const config = loadTrailConfig(trailDir);
  const trailId = config.id;
  const dirName = path.basename(trailDir);

  console.log(`\nProcessing trail: ${trailId}`);
  console.log('─'.repeat(40));

  // Validate tile config exists for this trail
  const tileConfig = TRAIL_TILE_CONFIGS[trailId];
  if (!tileConfig) {
    console.error(`  ✗ No tile config (MGA zone) defined for trail: ${trailId}`);
    console.error(`    Add an entry to TRAIL_TILE_CONFIGS in build-tiles.ts`);
    throw new Error(`Missing tile config for ${trailId}`);
  }

  // Set up working directories
  const workDir = path.join(TILES_WORK_DIR, dirName);
  const outputDir = path.join(TILES_OUTPUT_DIR, dirName);
  ensureDir(workDir);
  ensureDir(outputDir);

  // Read GPX track
  const gpxPath = path.join(trailDir, config.gpxFile);
  if (!fs.existsSync(gpxPath)) {
    throw new Error(`GPX file not found: ${gpxPath}`);
  }
  const trackPoints = readGpxTrackPoints(gpxPath);
  console.log(`  Track points: ${trackPoints.length}`);

  const bounds = computeBounds(trackPoints);
  console.log(`  Bounds: ${bounds.west.toFixed(2)}°E, ${bounds.south.toFixed(2)}°S to ${bounds.east.toFixed(2)}°E, ${bounds.north.toFixed(2)}°S`);

  // File paths
  const corridorPath = path.join(workDir, 'corridor.geojson');
  const demPath = path.join(workDir, 'dem_corridor.tif');
  const contoursRawPath = path.join(workDir, 'contours_raw.fgb');
  const contoursClassifiedPath = path.join(workDir, 'contours.fgb');
  const contoursMbtilesPath = path.join(workDir, 'contours.mbtiles');
  const basePmtilesPath = path.join(workDir, 'base.pmtiles');
  const baseMbtilesPath = path.join(workDir, 'base.mbtiles');

  // Output paths (final)
  const outputBaseMbtiles = path.join(outputDir, 'base.mbtiles');
  const outputContoursMbtiles = path.join(outputDir, 'contours.mbtiles');

  // Step 1: Generate corridor polygon
  generateCorridor(gpxPath, corridorPath, tileConfig.epsg, args.verbose);

  // Step 2: Clip DEM (needed for contours)
  if (!args.skipContours) {
    clipDem(corridorPath, demPath, args.verbose);
  }

  // Step 3-4: Generate contour tiles
  if (!args.skipContours) {
    generateContours(demPath, contoursRawPath, args.verbose);
    classifyAndTileContours(contoursRawPath, contoursClassifiedPath, contoursMbtilesPath, args.verbose);
    fs.copyFileSync(contoursMbtilesPath, outputContoursMbtiles);
  }

  // Step 5: Extract base map tiles
  if (!args.skipBase) {
    const protomapsSource = args.protomapsUrl
      || args.protomapsFile
      || path.join(PROJECT_ROOT, 'data/protomaps/planet.pmtiles');

    if (!args.protomapsUrl && !fs.existsSync(protomapsSource)) {
      console.error(`  ✗ Protomaps source not found: ${protomapsSource}`);
      console.error('    Use --protomaps-url <URL> for remote extraction, or');
      console.error('    use --protomaps-file <path> for a local PMTiles file, or');
      console.error('    download the Protomaps planet file to data/protomaps/planet.pmtiles');
      throw new Error('Protomaps source not found');
    }

    extractBaseTiles(corridorPath, basePmtilesPath, baseMbtilesPath, protomapsSource, args.verbose);
    fs.copyFileSync(baseMbtilesPath, outputBaseMbtiles);
  }

  // Write manifest
  const manifestFiles = [
    { name: 'base.mbtiles', path: outputBaseMbtiles },
    { name: 'contours.mbtiles', path: outputContoursMbtiles },
  ];

  const manifest = writeManifest(trailId, outputDir, bounds, manifestFiles);

  console.log(`\n  ✓ Complete: ${trailId}`);
  console.log(`    Total size: ${formatBytes(manifest.totalSize)}`);
  console.log(`    Files: ${manifest.files.length}`);
  manifest.files.forEach(f => console.log(`      ${f.name}: ${formatBytes(f.size)}`));
}

async function main(): Promise<void> {
  console.log('Topographic Tile Pipeline');
  console.log('========================\n');

  const args = parseArgs();

  // Check dependencies
  console.log('Checking dependencies...');
  checkDependencies(args);
  console.log('  ✓ All dependencies found\n');

  // Ensure output directories exist
  ensureDir(TILES_WORK_DIR);
  ensureDir(TILES_OUTPUT_DIR);

  // Find trail directories
  if (!fs.existsSync(TRAILS_DATA_DIR)) {
    console.error(`Trail data directory not found: ${TRAILS_DATA_DIR}`);
    process.exit(1);
  }

  let trailDirs: string[];

  if (args.trail) {
    // Process single trail
    // Try exact directory name first, then check trail IDs
    let trailDir = path.join(TRAILS_DATA_DIR, args.trail);
    if (!fs.existsSync(trailDir)) {
      // Search by trail ID in trail.json files
      const allDirs = fs.readdirSync(TRAILS_DATA_DIR)
        .map(name => path.join(TRAILS_DATA_DIR, name))
        .filter(p => fs.statSync(p).isDirectory());

      const found = allDirs.find(dir => {
        const configPath = path.join(dir, 'trail.json');
        if (!fs.existsSync(configPath)) return false;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return config.id === args.trail;
      });

      if (!found) {
        console.error(`Trail not found: ${args.trail}`);
        console.error('Available trails:');
        allDirs.forEach(dir => {
          const configPath = path.join(dir, 'trail.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            console.error(`  ${config.id} (${path.basename(dir)}/)`);
          }
        });
        process.exit(1);
      }
      trailDir = found;
    }
    trailDirs = [trailDir];
  } else {
    // Process all trails
    trailDirs = fs.readdirSync(TRAILS_DATA_DIR)
      .map(name => path.join(TRAILS_DATA_DIR, name))
      .filter(p => fs.statSync(p).isDirectory());
  }

  console.log(`Processing ${trailDirs.length} trail(s)\n`);

  // Copy shared style.json to output
  const styleSrcPath = path.join(PROJECT_ROOT, 'scripts/topo-style.json');
  const styleDestPath = path.join(TILES_OUTPUT_DIR, 'style.json');
  if (fs.existsSync(styleSrcPath)) {
    fs.copyFileSync(styleSrcPath, styleDestPath);
    console.log(`Style copied to ${styleDestPath}\n`);
  }

  // Process each trail
  const results: { trailId: string; success: boolean; error?: string }[] = [];

  for (const trailDir of trailDirs) {
    try {
      await processTrail(trailDir, args);
      results.push({ trailId: path.basename(trailDir), success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Error: ${message}`);
      results.push({ trailId: path.basename(trailDir), success: false, error: message });
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(40));
  console.log('Summary');
  console.log('═'.repeat(40));

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (succeeded.length > 0) {
    console.log(`\n✓ Succeeded (${succeeded.length}):`);
    succeeded.forEach(r => console.log(`  ${r.trailId}`));
  }

  if (failed.length > 0) {
    console.log(`\n✗ Failed (${failed.length}):`);
    failed.forEach(r => console.log(`  ${r.trailId}: ${r.error}`));
  }

  console.log(`\nOutput: ${TILES_OUTPUT_DIR}`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
