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
import { JSDOM } from 'jsdom';
import type { TrailTileConfig } from '../src/lib/types.js';
import {
  PROJECT_ROOT,
  run,
  ensureDir,
  cleanWorkDir,
  formatBytes,
  checkDependencies,
  clipDem,
  generateContours,
  classifyAndTileContours,
  extractBaseTiles,
  writeManifest,
  mgaEpsgForLon,
} from './tile-pipeline.js';

// --- Path setup ---

const TRAILS_DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const TILES_WORK_DIR = path.join(PROJECT_ROOT, 'data/tiles');
const TILES_OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');

// --- MGA Zone mapping for Australian trails ---
// Optional overrides for trails where auto-detection from centroid longitude
// isn't suitable. Auto-detection uses mgaEpsgForLon() from tile-pipeline.ts.
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

// --- Utility functions (local helpers not shared) ---

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

  // Get tile config: use explicit override if available, otherwise auto-detect from centroid
  let tileConfig = TRAIL_TILE_CONFIGS[trailId];
  if (!tileConfig) {
    // Read GPX to compute centroid longitude for MGA zone auto-detection
    const gpxPath_ = path.join(trailDir, config.gpxFile);
    const pts = readGpxTrackPoints(gpxPath_);
    if (pts.length === 0) {
      throw new Error(`No track points found in GPX for trail: ${trailId}`);
    }
    const lonCenter = pts.reduce((sum, p) => sum + p.lon, 0) / pts.length;
    const epsg = mgaEpsgForLon(lonCenter);
    const mgaZone = epsg - 28300;
    tileConfig = { mgaZone, epsg };
    console.log(`  MGA zone auto-detected: zone ${mgaZone} (EPSG:${epsg}) from centroid lon ${lonCenter.toFixed(2)}`);
  }

  // Set up working directories
  // Work dir uses filesystem dir name (internal, not uploaded)
  const workDir = path.join(TILES_WORK_DIR, dirName);
  // Output dir uses the canonical trail ID so R2 keys match what the app requests
  const outputDir = path.join(TILES_OUTPUT_DIR, trailId);
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

  // Clean up work directory
  cleanWorkDir(workDir);

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
  checkDependencies({ skipContours: args.skipContours, skipBase: args.skipBase });
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
