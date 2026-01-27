/**
 * Pre-fetch elevation data for trail GPX files at build time.
 *
 * This script fills in missing elevation data for trail points by querying
 * the Open Elevation API. Results are saved back to the source GPX files.
 *
 * Usage: tsx scripts/fetch-elevation.ts [trail-id]
 *   - With no arguments: processes all trails
 *   - With trail-id: processes only that trail
 */

import * as fs from 'fs';
import * as path from 'path';

interface TrailConfig {
  id: string;
  name: string;
  gpxFile: string;
  [key: string]: unknown;
}

interface ElevationResult {
  latitude: number;
  longitude: number;
  elevation: number;
}

interface PointLocation {
  index: number;
  lat: number;
  lon: number;
  startPos: number;
  endPos: number;
  currentEle: number | null;
  routeIndex: number;
}

interface GpxRoute {
  name: string;
  startPos: number;
  endPos: number;
}

interface ParsedGpx {
  routes: GpxRoute[];
  points: PointLocation[];
}

// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const TRAILS_DIR = path.join(PROJECT_ROOT, 'data/trails');

const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const BATCH_SIZE = 100; // Open Elevation recommends max 100 points per request
const DELAY_BETWEEN_BATCHES_MS = 500; // Be nice to the free API

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchElevationBatch(
  locations: { lat: number; lon: number }[]
): Promise<ElevationResult[]> {
  const response = await fetch(OPEN_ELEVATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: locations.map(loc => ({
        latitude: loc.lat,
        longitude: loc.lon,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`Open Elevation API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.results;
}

function parseGpx(gpxContent: string): ParsedGpx {
  // Parse all <trk> elements to get route names and positions
  const routes: GpxRoute[] = [];
  const trkRegex = /<trk>(.*?)<\/trk>/gs;
  let trkMatch;

  while ((trkMatch = trkRegex.exec(gpxContent)) !== null) {
    const trkContent = trkMatch[1];
    const nameMatch = trkContent.match(/<name>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/name>/);
    const name = nameMatch ? nameMatch[1] : `Route ${routes.length + 1}`;
    routes.push({
      name,
      startPos: trkMatch.index,
      endPos: trkMatch.index + trkMatch[0].length,
    });
  }

  // Parse all <trkpt> elements and assign each to its route
  const points: PointLocation[] = [];
  const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)">(.*?)<\/trkpt>/gs;
  let match;
  let index = 0;

  while ((match = trkptRegex.exec(gpxContent)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const innerContent = match[3];
    const startPos = match.index;
    const endPos = match.index + match[0].length;

    // Determine which route this point belongs to
    const routeIndex = routes.findIndex(r => startPos >= r.startPos && endPos <= r.endPos);

    // Check for existing elevation
    const eleMatch = innerContent.match(/<ele>([^<]*)<\/ele>/);
    const currentEle = eleMatch ? parseFloat(eleMatch[1]) : null;

    points.push({
      index,
      lat,
      lon,
      startPos,
      endPos,
      currentEle,
      routeIndex,
    });
    index++;
  }

  return { routes, points };
}

function updateGpxWithElevations(
  gpxContent: string,
  points: PointLocation[],
  elevations: Map<number, number>
): string {
  // Sort points by position in reverse order so we can replace from end to start
  // without affecting earlier positions
  const pointsToUpdate = points
    .filter(p => elevations.has(p.index))
    .sort((a, b) => b.startPos - a.startPos);

  let result = gpxContent;

  for (const point of pointsToUpdate) {
    const newEle = elevations.get(point.index)!;
    const originalText = gpxContent.slice(point.startPos, point.endPos);

    // Check if there's already an <ele> tag
    const eleMatch = originalText.match(/<ele>[^<]*<\/ele>/);
    let newText: string;

    if (eleMatch) {
      // Replace existing elevation
      newText = originalText.replace(/<ele>[^<]*<\/ele>/, `<ele>${newEle}</ele>`);
    } else {
      // Add elevation tag after the opening trkpt tag
      newText = originalText.replace(
        /(<trkpt[^>]*>)/,
        `$1<ele>${newEle}</ele>`
      );
    }

    result = result.slice(0, point.startPos) + newText + result.slice(point.endPos);
  }

  return result;
}

async function fetchElevationsForPoints(
  pointsNeedingElevation: PointLocation[]
): Promise<Map<number, number>> {
  const elevations = new Map<number, number>();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < pointsNeedingElevation.length; i += BATCH_SIZE) {
    const batch = pointsNeedingElevation.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pointsNeedingElevation.length / BATCH_SIZE);

    process.stdout.write(`  Fetching batch ${batchNum}/${totalBatches}...`);

    try {
      const results = await fetchElevationBatch(batch.map(p => ({ lat: p.lat, lon: p.lon })));

      for (let j = 0; j < batch.length; j++) {
        const elevation = results[j]?.elevation;

        if (elevation !== null && elevation !== undefined) {
          elevations.set(batch[j].index, elevation);
          successCount++;
        } else {
          failCount++;
        }
      }

      console.log(` done (${results.length} points)`);
    } catch (error) {
      console.log(` FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
      failCount += batch.length;
    }

    // Rate limiting
    if (i + BATCH_SIZE < pointsNeedingElevation.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`  Results: ${successCount} succeeded, ${failCount} failed`);
  return elevations;
}

function needsElevation(p: PointLocation): boolean {
  return p.currentEle === null || p.currentEle === 0 || (typeof p.currentEle === 'number' && isNaN(p.currentEle));
}

async function processGpxFile(gpxPath: string): Promise<boolean> {
  const gpxName = path.basename(gpxPath);
  console.log(`\nProcessing: ${gpxName}`);

  const gpxContent = fs.readFileSync(gpxPath, 'utf-8');
  const { routes, points } = parseGpx(gpxContent);

  console.log(`  Found ${routes.length} route(s):`);
  for (let i = 0; i < routes.length; i++) {
    const routePoints = points.filter(p => p.routeIndex === i);
    const routeNeedsEle = routePoints.filter(needsElevation);
    const status = routeNeedsEle.length > 0
      ? `${routeNeedsEle.length}/${routePoints.length} need elevation`
      : `${routePoints.length} points OK`;
    console.log(`    - ${routes[i].name} (${status})`);
  }

  // Check for points not matched to any route
  const unmatched = points.filter(p => p.routeIndex === -1);
  if (unmatched.length > 0) {
    console.log(`    - (unmatched points: ${unmatched.length})`);
  }

  const pointsNeedingElevation = points.filter(needsElevation);

  if (pointsNeedingElevation.length === 0) {
    console.log(`  All ${points.length} track points already have elevation data.`);
    return false;
  }

  console.log(`  Total: ${pointsNeedingElevation.length}/${points.length} points needing elevation data.`);

  // Fetch elevations
  const elevations = await fetchElevationsForPoints(pointsNeedingElevation);

  if (elevations.size > 0) {
    // Update GPX content with new elevations
    const updatedGpx = updateGpxWithElevations(gpxContent, points, elevations);

    // Save updated GPX file
    fs.writeFileSync(gpxPath, updatedGpx);
    console.log(`  Saved: ${gpxPath}`);
    return true;
  }

  return false;
}

async function main() {
  console.log('Elevation Data Fetch Script (GPX)');
  console.log('==================================');

  const args = process.argv.slice(2);
  const specificTrail = args[0];

  if (!fs.existsSync(TRAILS_DIR)) {
    console.error(`\nError: Trails directory not found: ${TRAILS_DIR}`);
    process.exit(1);
  }

  // Find trail directories to process
  const trailDirs = fs.readdirSync(TRAILS_DIR)
    .filter(f => {
      const trailPath = path.join(TRAILS_DIR, f);
      return fs.statSync(trailPath).isDirectory() &&
        fs.existsSync(path.join(trailPath, 'trail.json'));
    });

  if (trailDirs.length === 0) {
    console.log('\nNo trail directories found.');
    return;
  }

  // Filter to specific trail if provided
  const dirsToProcess = specificTrail
    ? trailDirs.filter(d => d === specificTrail || d.toLowerCase() === specificTrail.toLowerCase())
    : trailDirs;

  if (specificTrail && dirsToProcess.length === 0) {
    console.error(`\nError: Trail not found: ${specificTrail}`);
    console.error('Available trails:', trailDirs.join(', '));
    process.exit(1);
  }

  console.log(`\nFound ${dirsToProcess.length} trail(s) to process.`);

  let updatedCount = 0;

  for (const trailDir of dirsToProcess) {
    try {
      const trailJsonPath = path.join(TRAILS_DIR, trailDir, 'trail.json');
      const trailConfig: TrailConfig = JSON.parse(fs.readFileSync(trailJsonPath, 'utf-8'));

      const gpxPath = path.join(TRAILS_DIR, trailDir, trailConfig.gpxFile);

      if (!fs.existsSync(gpxPath)) {
        console.log(`\nSkipping ${trailDir}: GPX file not found (${trailConfig.gpxFile})`);
        continue;
      }

      const updated = await processGpxFile(gpxPath);
      if (updated) updatedCount++;
    } catch (error) {
      console.error(`  Error processing ${trailDir}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.log(`\n==================================`);
  console.log(`Done. Updated ${updatedCount} trail(s).`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
