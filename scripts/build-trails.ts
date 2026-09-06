import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { haversineDistance as haversineDistanceMeters } from '../src/lib/distance.js';
import { parseGpx } from '../src/lib/gpx-parser.js';
import { classifyWaypoint } from '../src/lib/waypoint-classifier.js';
import { buildTrail, flattenGpx, type ParsedGpxResult } from '../src/lib/trail-ingest.js';
import { escapeHtml, escapeJsString } from '../src/lib/escape.js';
import type { GpxPoint } from '../src/lib/types.js';
import type {
  ProcessedTrail,
  TrailConfig,
  TrailWaypoint as Waypoint,
} from '../src/lib/trail-types.js';
import { jsdomXmlAdapter } from './lib/xml-adapter-jsdom.js';
import {
  assignWaypointIds,
  stringifyRegistry,
  type WaypointRegistry,
} from './lib/waypoint-ids.js';
import {
  applyCuratedDescriptions,
  DESCRIPTIONS_FILENAME,
  loadCuratedDescriptions,
} from './lib/waypoint-descriptions.js';
import { readTrailPOIsForBuild } from './lib/trail-pois-file.js';

/** Calculate haversine distance in km */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

interface CaltopoData {
  waypointCategories: Map<string, string>;
  waypointDescriptions: Map<string, string>;
}


// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const WAYPOINT_IDS_PATH = path.join(PROJECT_ROOT, 'data/waypoint-ids.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
const TRAIL_PAGES_DIR = path.join(PROJECT_ROOT, 'src/web/trails');
const TRAIL_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'trail-template.html');
const CLIMATE_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'climate-template.html');
const PLAN_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'plan-template.html');

/**
 * Parse CalTopo GeoJSON for waypoint categorization, descriptions, and route variants
 */
function parseCaltopoGeojson(jsonPath: string): CaltopoData {
  const result: CaltopoData = {
    waypointCategories: new Map<string, string>(),
    waypointDescriptions: new Map<string, string>(),
  };

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const geojson = JSON.parse(content);

    // Build folder ID -> name map
    const folderNames = new Map<string, string>();
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Folder') {
        folderNames.set(feature.id, feature.properties.title?.toLowerCase() || '');
      }
    }

    // Process markers (waypoints)
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Marker') {
        const rawName = feature.properties.title || '';
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Use classifyWaypoint with folder info to get type and cleaned name
        const classification = classifyWaypoint(rawName, { folderName });

        // Key by cleaned name for easier matching with GPX waypoints
        result.waypointCategories.set(classification.cleanedName, classification.type);

        // Extract description if available (also keyed by cleaned name)
        if (feature.properties.description) {
          result.waypointDescriptions.set(classification.cleanedName, feature.properties.description);
        }
      }
    }

  } catch (e) {
    // GeoJSON parsing failed, fall back to GPX-only
    console.log(`  Warning: Could not parse GeoJSON: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  return result;
}

/**
 * Find the first GPX file in a directory
 */
function findGpxFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  const gpxFile = files.find(f => f.toLowerCase().endsWith('.gpx'));
  return gpxFile || null;
}

/**
 * Find a CalTopo GeoJSON file in a directory.
 * If explicitFile is provided, use that. Otherwise, auto-detect by finding
 * JSON files with a features array (excluding trail.json and climate.json).
 */
function findGeojsonFile(trailDir: string, explicitFile?: string): string | null {
  // If explicitly specified, use that
  if (explicitFile) {
    const filePath = path.join(trailDir, explicitFile);
    if (fs.existsSync(filePath)) {
      return explicitFile;
    }
    console.log(`  Warning: Specified geojsonFile not found: ${explicitFile}`);
  }

  // Auto-detect: find JSON files that look like GeoJSON (have features array)
  const files = fs.readdirSync(trailDir);
  const jsonFiles = files.filter(f =>
    f.toLowerCase().endsWith('.json') &&
    f !== 'trail.json' &&
    f !== 'climate.json'
  );

  for (const file of jsonFiles) {
    try {
      const content = fs.readFileSync(path.join(trailDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.features)) {
        return file;  // This is a GeoJSON file
      }
    } catch {
      // Not valid JSON or can't read, skip
    }
  }

  return null;
}

/**
 * Generate trail.json config from GPX file analysis
 */
function generateTrailConfig(trailDir: string, gpxFile: string, gpxData: ParsedGpxResult, mainRoutePoints: GpxPoint[]): TrailConfig {
  const trailId = path.basename(trailDir).toLowerCase();

  // Calculate total distance from main route points
  let totalDistance = 0;
  for (let i = 1; i < mainRoutePoints.length; i++) {
    const prev = mainRoutePoints[i - 1];
    const curr = mainRoutePoints[i];
    totalDistance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);
  }

  // Derive name from GPX metadata or directory name
  const gpxName = gpxData.name;
  const dirName = path.basename(trailDir);
  const name = gpxName || dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    id: trailId,
    name,
    shortName: dirName.toUpperCase(),
    region: 'Unknown',  // User should fill this in
    lengthKm: Math.round(totalDistance * 10) / 10,
    gpxFile,
    description: `Trail data auto-generated from ${gpxFile}. Edit trail.json to customize.`,
  };
}


function validateDataDirectory(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Note: Data directory does not exist: ${DATA_DIR}`);
    console.log('Creating directory structure...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('');
    console.log('To add trail data, create directories like:');
    console.log('  data/trails/');
    console.log('    └── trail-id/');
    console.log('        ├── trail.json');
    console.log('        ├── track.gpx');
    console.log('        └── waypoints.csv');
    console.log('');
  }

  const entries = fs.readdirSync(DATA_DIR);
  const trailDirs = entries.filter(name => {
    const fullPath = path.join(DATA_DIR, name);
    return fs.statSync(fullPath).isDirectory();
  });

  if (trailDirs.length === 0) {
    console.log('Note: No trail directories found in', DATA_DIR);
    console.log('The build will complete but no trail data will be generated.');
    console.log('');
  }
}

function validateTrailDirectory(trailDir: string): { errors: string[]; needsAutoConfig: boolean } {
  const errors: string[] = [];
  const trailId = path.basename(trailDir);
  let needsAutoConfig = false;

  const configPath = path.join(trailDir, 'trail.json');
  if (!fs.existsSync(configPath)) {
    // Check if we can auto-generate config from GPX
    const gpxFile = findGpxFile(trailDir);
    if (gpxFile) {
      needsAutoConfig = true;
      console.log(`  ${trailId}: No trail.json found, will auto-generate from ${gpxFile}`);
    } else {
      errors.push(`${trailId}: Missing trail.json and no GPX file found for auto-generation`);
    }
    return { errors, needsAutoConfig };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.gpxFile) {
      // Try to find GPX file automatically
      const gpxFile = findGpxFile(trailDir);
      if (!gpxFile) {
        errors.push(`${trailId}: trail.json missing gpxFile and no GPX file found`);
      }
    } else if (!fs.existsSync(path.join(trailDir, config.gpxFile))) {
      errors.push(`${trailId}: GPX file not found: ${config.gpxFile}`);
    }

    // waypointsFile is now optional - waypoints can come from GPX

    if (!config.id || !config.name) {
      errors.push(`${trailId}: trail.json missing required id or name field`);
    }
  } catch (e) {
    errors.push(`${trailId}: Invalid trail.json - ${e instanceof Error ? e.message : 'parse error'}`);
  }

  return { errors, needsAutoConfig };
}

async function processTrail(trailDir: string, registry: WaypointRegistry, autoGenConfig: boolean = false): Promise<ProcessedTrail> {
  const configPath = path.join(trailDir, 'trail.json');

  // Find GPX file
  let gpxFile: string;
  if (autoGenConfig) {
    gpxFile = findGpxFile(trailDir)!;
  } else {
    const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    gpxFile = existingConfig.gpxFile || findGpxFile(trailDir)!;
  }

  // Parse GPX with the shared parser (jsdom backend). Coordinates are strict:
  // a malformed lat/lon fails the build instead of plotting at 0°N 0°E.
  const gpxPath = path.join(trailDir, gpxFile);
  const gpxContent = fs.readFileSync(gpxPath, 'utf-8');
  const gpxData = flattenGpx(parseGpx(gpxContent, jsdomXmlAdapter));

  // Load config first (needed for track classification patterns)
  let config: TrailConfig;
  if (autoGenConfig) {
    // For auto-gen, create a minimal config first, then update after classification
    config = {
      id: path.basename(trailDir).toLowerCase(),
      name: gpxData.name || path.basename(trailDir),
      shortName: path.basename(trailDir).toUpperCase(),
      region: 'Unknown',
      lengthKm: 0,
      gpxFile,
    };
  } else {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Fill in gpxFile if missing
    if (!config.gpxFile) {
      config.gpxFile = gpxFile;
    }
  }

  // Climate is read outside buildTrail (it is file-system state, not geometry)
  // and stitched onto the result below.
  let climate: Record<string, unknown> | null = null;
  const climateFile = config.climateFile || 'climate.json';
  const climatePath = path.join(trailDir, climateFile);
  if (fs.existsSync(climatePath)) {
    climate = JSON.parse(fs.readFileSync(climatePath, 'utf-8'));
  }

  const trail = buildTrail(gpxData, {
    config,
    log: message => console.log(message),
    warn: message => console.warn(message),

    // Auto-generated trail.json: regenerate the config once the main route is
    // known, and write it out for the user to customise later.
    finalizeConfig: autoGenConfig
      ? (_current, mainRoutePoints) => {
          const generated = generateTrailConfig(trailDir, gpxFile, gpxData, mainRoutePoints);
          fs.writeFileSync(configPath, JSON.stringify(generated, null, 2));
          console.log(`  ✓ Generated trail.json`);
          return generated;
        }
      : undefined,

    // CalTopo categorisation, then the CSV waypoint fallback.
    resolveWaypoints: (gpxWaypoints, resolvedConfig) =>
      resolveTrailWaypoints(trailDir, resolvedConfig, gpxWaypoints),

    // Stable ids come from the committed, append-only registry.
    mintWaypointIds: (waypoints, resolvedConfig) =>
      assignWaypointIds(resolvedConfig.id, waypoints, registry),

    // Curated descriptions are keyed by the ids just assigned.
    afterWaypointIds: (waypoints, resolvedConfig) =>
      applyTrailDescriptions(trailDir, resolvedConfig, waypoints),
  });

  return { ...trail, climate };
}

/**
 * Layer the build-only waypoint sources on top of the GPX waypoints:
 * CalTopo GeoJSON categories/descriptions first, then a CSV fallback for trails
 * whose GPX carries no `<wpt>` at all.
 */
function resolveTrailWaypoints(
  trailDir: string,
  config: TrailConfig,
  gpxWaypoints: Waypoint[]
): Waypoint[] {
  let waypoints = gpxWaypoints;

  // If GeoJSON exists, use it to enhance data
  const geojsonFile = findGeojsonFile(trailDir, config.geojsonFile);
  if (geojsonFile) {
    const geojsonPath = path.join(trailDir, geojsonFile);
    const caltopoData = parseCaltopoGeojson(geojsonPath);

    if (caltopoData.waypointCategories.size > 0) {
      console.log(`  ✓ Using ${geojsonFile} for waypoint categorization`);
      // Update waypoint types and descriptions from GeoJSON
      // Both GPX waypoints and GeoJSON categories are now keyed by cleaned name
      waypoints = waypoints.map(wp => {
        if (caltopoData.waypointCategories.has(wp.name)) {
          const desc = caltopoData.waypointDescriptions.get(wp.name);
          return {
            ...wp,
            type: caltopoData.waypointCategories.get(wp.name)!,
            description: desc || wp.description,
          };
        }
        return wp;
      });
    }
  }

  // Fall back to CSV waypoints if no GPX waypoints and CSV exists
  if (waypoints.length === 0 && config.waypointsFile) {
    const waypointsPath = path.join(trailDir, config.waypointsFile);
    if (fs.existsSync(waypointsPath)) {
      const waypointsContent = fs.readFileSync(waypointsPath, 'utf-8');
      const waypointsResult = Papa.parse(waypointsContent, { header: true });
      waypoints = (waypointsResult.data as Record<string, unknown>[])
        .filter(row => row.name && row.lat && row.lon)
        .map(row => ({
          name: String(row.name),
          lat: parseFloat(String(row.lat)),
          lon: parseFloat(String(row.lon)),
          type: String(row.type || 'waypoint'),
          description: row.description ? String(row.description) : undefined,
        }));
    }
  }

  return waypoints;
}

/**
 * Apply curated descriptions from data/trails/<trail>/descriptions.json.
 *
 * Keyed by the stable ids assigned just before this runs, and applied to the
 * source waypoint objects for the same reason ids are: every downstream view
 * copies from these objects. The curated text is the bundled half of the
 * description pipeline — the comments API serves the same ids as synced
 * overrides (see scripts/lib/waypoint-descriptions.ts).
 */
function applyTrailDescriptions(trailDir: string, config: TrailConfig, waypoints: Waypoint[]): void {
  const curatedDescriptions = loadCuratedDescriptions(trailDir, config.id);
  if (curatedDescriptions.length === 0) return;

  const { applied, unmatchedIds } = applyCuratedDescriptions(waypoints, curatedDescriptions);
  console.log(`  ✓ Applied ${applied} curated waypoint description(s) from ${DESCRIPTIONS_FILENAME}`);
  if (unmatchedIds.length > 0) {
    // Not fatal: an id can go stale when source data moves a waypoint far
    // enough to mint a new id. Loud, because the prose silently disappears.
    console.warn(
      `  ⚠ ${unmatchedIds.length} curated description(s) matched no waypoint: ${unmatchedIds.join(', ')}`
    );
  }
}

/**
 * Generate an HTML page for a trail from the template
 */
function generateTrailPage(trail: ProcessedTrail): void {
  if (!fs.existsSync(TRAIL_TEMPLATE_PATH)) {
    console.log('  Note: Trail template not found, skipping HTML generation');
    return;
  }

  const template = fs.readFileSync(TRAIL_TEMPLATE_PATH, 'utf-8');

  // Replace placeholders with escaped values
  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, escapeJsString(trail.config.id))
    .replace(/\{\{TRAIL_NAME\}\}/g, escapeHtml(trail.config.name))
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, escapeHtml(trail.config.shortName || trail.config.name))
    .replace(/\{\{TRAIL_REGION\}\}/g, escapeHtml(trail.config.region || 'Unknown'));

  // Create trail directory and write HTML
  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

/**
 * Generate a plan page for a trail from the plan template
 */
function generatePlanPage(trail: ProcessedTrail): void {
  if (!fs.existsSync(PLAN_TEMPLATE_PATH)) {
    console.log('  Note: Plan template not found, skipping plan page generation');
    return;
  }

  const template = fs.readFileSync(PLAN_TEMPLATE_PATH, 'utf-8');

  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, escapeJsString(trail.config.id))
    .replace(/\{\{TRAIL_NAME\}\}/g, escapeHtml(trail.config.name))
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, escapeHtml(trail.config.shortName || trail.config.name));

  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'plan.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

/**
 * Generate a climate page for a trail from the template
 */
function generateClimatePage(trail: ProcessedTrail): void {
  if (!fs.existsSync(CLIMATE_TEMPLATE_PATH)) {
    console.log('  Note: Climate template not found, skipping climate page generation');
    return;
  }

  const template = fs.readFileSync(CLIMATE_TEMPLATE_PATH, 'utf-8');

  // Replace placeholders with escaped values
  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, escapeJsString(trail.config.id))
    .replace(/\{\{TRAIL_NAME\}\}/g, escapeHtml(trail.config.name))
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, escapeHtml(trail.config.shortName || trail.config.name));

  // Create trail directory if it doesn't exist
  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'climate.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

async function main() {
  console.log('Trail Build Script');
  console.log('==================\n');

  // Validate data directory exists and has content
  validateDataDirectory();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Find all trail directories
  if (!fs.existsSync(DATA_DIR)) {
    console.log('No data directory found. Skipping trail processing.');
    // Write empty index
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  const trailDirs = fs.readdirSync(DATA_DIR)
    .map(name => path.join(DATA_DIR, name))
    .filter(p => fs.statSync(p).isDirectory());

  if (trailDirs.length === 0) {
    console.log('No trail directories found. Writing empty index.');
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  // Validate all trails before processing
  console.log(`Found ${trailDirs.length} trail directories\n`);
  console.log('Validating trail data...');

  const allErrors: string[] = [];
  const autoGenTrails = new Set<string>();

  for (const trailDir of trailDirs) {
    const { errors, needsAutoConfig } = validateTrailDirectory(trailDir);
    allErrors.push(...errors);
    if (needsAutoConfig) {
      autoGenTrails.add(trailDir);
    }
  }

  if (allErrors.length > 0) {
    console.error('\nValidation errors found:');
    allErrors.forEach(err => console.error(`  - ${err}`));
    console.error('\nFix these errors before building.');
    process.exit(1);
  }

  console.log('All trails validated successfully.\n');

  // Load the committed waypoint-id registry (deterministic mint + registry).
  let waypointRegistry: WaypointRegistry = {};
  if (fs.existsSync(WAYPOINT_IDS_PATH)) {
    try {
      waypointRegistry = JSON.parse(fs.readFileSync(WAYPOINT_IDS_PATH, 'utf-8'));
    } catch (e) {
      console.error(`Failed to parse ${WAYPOINT_IDS_PATH}: ${e instanceof Error ? e.message : 'parse error'}`);
      process.exit(1);
    }
  }

  const trailIndex: { id: string; name: string; shortName: string; lengthKm: number }[] = [];
  const failedTrails: string[] = [];

  for (const trailDir of trailDirs) {
    const trailId = path.basename(trailDir);
    const needsAutoGen = autoGenTrails.has(trailDir);
    console.log(`Processing: ${trailId}${needsAutoGen ? ' (auto-generating config)' : ''}`);

    try {
      const processed = await processTrail(trailDir, waypointRegistry, needsAutoGen);

      // OSM points of interest are fetched separately (npm run fetch:pois) and
      // committed to data/trails/<dir>/pois.json, because this directory is
      // gitignored and rewritten wholesale on every build. They are never
      // merged into `waypoints` and never enter the waypoint-id registry; the
      // file's hand-edited `rejected` keys are dropped here. A trail with no
      // pois.json gets no `pois` key at all.
      const pois = readTrailPOIsForBuild(trailDir);
      if (pois) {
        processed.pois = pois;
      }

      // Write processed data
      const outputPath = path.join(OUTPUT_DIR, `${processed.config.id}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(processed, null, 2));
      console.log(`  ✓ Written to ${outputPath}`);
      console.log(`    Distance: ${processed.track.totalDistance.toFixed(1)} km`);
      console.log(`    Elevation: +${Math.round(processed.track.totalAscent)}m / -${Math.round(processed.track.totalDescent)}m`);
      console.log(`    Waypoints: ${processed.waypoints.length} on-trail, ${processed.offTrailWaypoints.length} off-trail`);
      if (pois) {
        console.log(`    POIs: ${pois.length} (OpenStreetMap)`);
      }

      // Generate HTML pages for this trail
      generateTrailPage(processed);
      generateClimatePage(processed);
      generatePlanPage(processed);

      trailIndex.push({
        id: processed.config.id,
        name: processed.config.name,
        shortName: processed.config.shortName,
        lengthKm: processed.config.lengthKm,
      });
    } catch (error) {
      console.error(`  ✗ Error processing ${trailId}:`, error);
      failedTrails.push(trailId);
    }
  }

  // Write trail index
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(trailIndex, null, 2));
  console.log(`\nTrail index written to ${indexPath}`);

  // Write the (append-only) waypoint-id registry back, deterministically
  // sorted for stable git diffs.
  fs.writeFileSync(WAYPOINT_IDS_PATH, stringifyRegistry(waypointRegistry));
  const registryCount = Object.values(waypointRegistry).reduce((sum, e) => sum + e.length, 0);
  console.log(`Waypoint-id registry written to ${WAYPOINT_IDS_PATH} (${registryCount} entries)`);

  // A trail that threw wrote no output, so the generated data is stale/absent
  // for it — fail the build rather than letting a silent gap ship.
  if (failedTrails.length > 0) {
    console.error(`\n${failedTrails.length} trail(s) failed to build: ${failedTrails.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
