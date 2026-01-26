/**
 * Pre-fetch elevation data for trail GPX files at build time.
 *
 * This script fills in missing elevation data for trail points by querying
 * the Open Elevation API. Results are saved back to the processed trail JSON files.
 *
 * Usage: tsx scripts/fetch-elevation.ts [trail-id]
 *   - With no arguments: processes all trails
 *   - With trail-id: processes only that trail
 */

import * as fs from 'fs';
import * as path from 'path';

interface TrailPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
}

interface ProcessedTrail {
  config: {
    id: string;
    name: string;
    [key: string]: unknown;
  };
  track: {
    points: TrailPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: Record<string, unknown>[];
  climate: Record<string, unknown> | null;
}

interface ElevationResult {
  latitude: number;
  longitude: number;
  elevation: number;
}

// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'public/data/generated');

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

function recalculateElevationStats(points: TrailPoint[]): {
  totalAscent: number;
  totalDescent: number;
} {
  let totalAscent = 0;
  let totalDescent = 0;

  for (let i = 1; i < points.length; i++) {
    const elevDiff = points[i].ele - points[i - 1].ele;
    if (elevDiff > 0) {
      totalAscent += elevDiff;
    } else {
      totalDescent += Math.abs(elevDiff);
    }
  }

  return { totalAscent, totalDescent };
}

async function processTrail(trailPath: string): Promise<boolean> {
  const trailId = path.basename(trailPath, '.json');
  console.log(`\nProcessing: ${trailId}`);

  const content = fs.readFileSync(trailPath, 'utf-8');
  const trail: ProcessedTrail = JSON.parse(content);

  // Find points with missing or zero elevation
  const pointsNeedingElevation: { index: number; lat: number; lon: number }[] = [];

  for (let i = 0; i < trail.track.points.length; i++) {
    const point = trail.track.points[i];
    if (point.ele === 0 || point.ele === null || point.ele === undefined) {
      pointsNeedingElevation.push({ index: i, lat: point.lat, lon: point.lon });
    }
  }

  if (pointsNeedingElevation.length === 0) {
    console.log(`  All ${trail.track.points.length} points already have elevation data.`);
    return false;
  }

  console.log(`  Found ${pointsNeedingElevation.length} points needing elevation data.`);

  // Process in batches
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
        const pointIndex = batch[j].index;
        const elevation = results[j]?.elevation;

        if (elevation !== null && elevation !== undefined) {
          trail.track.points[pointIndex].ele = elevation;
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

  if (successCount > 0) {
    // Recalculate elevation statistics
    const { totalAscent, totalDescent } = recalculateElevationStats(trail.track.points);
    trail.track.totalAscent = totalAscent;
    trail.track.totalDescent = totalDescent;

    // Save updated trail data
    fs.writeFileSync(trailPath, JSON.stringify(trail, null, 2));
    console.log(`  Updated ${trailPath}`);
    console.log(`  New stats: ${Math.round(totalAscent)}m ascent, ${Math.round(totalDescent)}m descent`);
    return true;
  }

  return false;
}

async function main() {
  console.log('Elevation Data Fetch Script');
  console.log('===========================');

  const args = process.argv.slice(2);
  const specificTrail = args[0];

  if (!fs.existsSync(GENERATED_DIR)) {
    console.error(`\nError: Generated data directory not found: ${GENERATED_DIR}`);
    console.error('Run "npm run build:trails" first to generate trail data.');
    process.exit(1);
  }

  // Find trail files to process
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
    trailFiles = fs.readdirSync(GENERATED_DIR)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .map(f => path.join(GENERATED_DIR, f));
  }

  if (trailFiles.length === 0) {
    console.log('\nNo trail files found to process.');
    return;
  }

  console.log(`\nFound ${trailFiles.length} trail(s) to process.`);

  let updatedCount = 0;

  for (const trailFile of trailFiles) {
    try {
      const updated = await processTrail(trailFile);
      if (updated) updatedCount++;
    } catch (error) {
      console.error(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.log(`\n===========================`);
  console.log(`Done. Updated ${updatedCount} trail(s).`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
