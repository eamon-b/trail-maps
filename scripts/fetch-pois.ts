/**
 * Pre-fetch POI data for trail corridors at build time.
 *
 * This script queries the Overpass API to find water sources, camping,
 * resupply points, transport, and emergency services along each trail.
 * Results are saved to the processed trail JSON files.
 *
 * Usage: tsx scripts/fetch-pois.ts [trail-id]
 *   - With no arguments: processes all trails
 *   - With trail-id: processes only that trail
 */

import * as fs from 'fs';
import * as path from 'path';
import { haversineDistance as haversineDistanceMeters } from '../src/lib/distance.js';

/** Calculate haversine distance in km */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

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
  pois?: POI[];
}

interface POI {
  id: number;
  type: string;
  category: string;
  lat: number;
  lon: number;
  name: string | null;
  tags: Record<string, string>;
  distanceAlongTrail?: number;
}

interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'data/generated');

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const BUFFER_KM = 2; // Search within 2km of trail
const MAX_DEGREES_PER_QUERY = 1.0; // Keep queries smaller for reliability
const DELAY_BETWEEN_QUERIES_MS = 2000; // Overpass rate limiting

// POI type definitions matching the API
const POI_CATEGORIES: Record<string, string[]> = {
  water: [
    'node["amenity"="drinking_water"]',
    'node["natural"="spring"]',
    'node["man_made"="water_tap"]',
  ],
  camping: [
    'node["tourism"="camp_site"]',
    'node["tourism"="alpine_hut"]',
    'node["tourism"="wilderness_hut"]',
    'node["amenity"="shelter"]',
  ],
  resupply: [
    'node["shop"="supermarket"]',
    'node["shop"="convenience"]',
    'node["shop"="general"]',
    'node["amenity"="cafe"]',
    'node["amenity"="restaurant"]',
  ],
  transport: [
    'node["highway"="bus_stop"]',
    'node["railway"="station"]',
    'node["railway"="halt"]',
  ],
  emergency: [
    'node["amenity"="hospital"]',
    'node["amenity"="pharmacy"]',
    'node["amenity"="police"]',
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBoundsFromPoints(points: TrailPoint[], bufferKm: number): Bounds {
  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);

  // Approximate degrees per km
  const avgLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const latBuffer = bufferKm / 111;
  const lonBuffer = bufferKm / (111 * Math.cos(avgLat * Math.PI / 180));

  return {
    south: Math.min(...lats) - latBuffer,
    north: Math.max(...lats) + latBuffer,
    west: Math.min(...lons) - lonBuffer,
    east: Math.max(...lons) + lonBuffer,
  };
}

function splitBounds(bounds: Bounds, maxDegrees: number): Bounds[] {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;

  if (latSpan <= maxDegrees && lonSpan <= maxDegrees) {
    return [bounds];
  }

  const latChunks = Math.ceil(latSpan / maxDegrees);
  const lonChunks = Math.ceil(lonSpan / maxDegrees);
  const latStep = latSpan / latChunks;
  const lonStep = lonSpan / lonChunks;

  const chunks: Bounds[] = [];

  for (let i = 0; i < latChunks; i++) {
    for (let j = 0; j < lonChunks; j++) {
      chunks.push({
        south: bounds.south + i * latStep,
        north: bounds.south + (i + 1) * latStep,
        west: bounds.west + j * lonStep,
        east: bounds.west + (j + 1) * lonStep,
      });
    }
  }

  return chunks;
}

function buildOverpassQuery(bounds: Bounds, categories: string[]): string {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;

  const queries: string[] = [];
  for (const category of categories) {
    const selectors = POI_CATEGORIES[category] || [];
    for (const selector of selectors) {
      queries.push(`${selector}(${bbox});`);
    }
  }

  return `
    [out:json][timeout:30];
    (
      ${queries.join('\n      ')}
    );
    out center;
  `;
}

async function fetchPOIsForBounds(
  bounds: Bounds,
  categories: string[]
): Promise<{ elements: Array<{ id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> }> {
  const query = buildOverpassQuery(bounds, categories);

  const response = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Overpass API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  return response.json();
}

function categorizePOI(tags: Record<string, string>): string {
  if (tags.amenity === 'drinking_water' || tags.natural === 'spring' || tags.man_made === 'water_tap') {
    return 'water';
  }
  if (tags.tourism === 'camp_site' || tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut' || tags.amenity === 'shelter') {
    return 'camping';
  }
  if (tags.shop || tags.amenity === 'cafe' || tags.amenity === 'restaurant') {
    return 'resupply';
  }
  if (tags.highway === 'bus_stop' || tags.railway) {
    return 'transport';
  }
  if (tags.amenity === 'hospital' || tags.amenity === 'pharmacy' || tags.amenity === 'police') {
    return 'emergency';
  }
  return 'other';
}

function findNearestTrailPoint(
  poi: { lat: number; lon: number },
  points: TrailPoint[]
): { distance: number; distanceAlongTrail: number } {
  let minDistance = Infinity;
  let distanceAlongTrail = 0;

  for (const point of points) {
    const dist = haversineDistanceKm(poi.lat, poi.lon, point.lat, point.lon);
    if (dist < minDistance) {
      minDistance = dist;
      distanceAlongTrail = point.dist;
    }
  }

  return { distance: minDistance, distanceAlongTrail };
}

async function processTrail(trailPath: string): Promise<boolean> {
  const trailId = path.basename(trailPath, '.json');
  console.log(`\nProcessing: ${trailId}`);

  const content = fs.readFileSync(trailPath, 'utf-8');
  const trail: ProcessedTrail = JSON.parse(content);

  if (trail.track.points.length === 0) {
    console.log('  No track points found. Skipping.');
    return false;
  }

  // Get bounding box for trail with buffer
  const bounds = getBoundsFromPoints(trail.track.points, BUFFER_KM);
  console.log(`  Trail bounds: ${bounds.south.toFixed(2)},${bounds.west.toFixed(2)} to ${bounds.north.toFixed(2)},${bounds.east.toFixed(2)}`);

  // Split into chunks if needed
  const chunks = splitBounds(bounds, MAX_DEGREES_PER_QUERY);
  console.log(`  Querying ${chunks.length} area(s)...`);

  const categories = Object.keys(POI_CATEGORIES);
  const allPOIs: Map<number, POI> = new Map(); // Dedupe by OSM ID

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    process.stdout.write(`  Fetching chunk ${i + 1}/${chunks.length}...`);

    try {
      const result = await fetchPOIsForBounds(chunk, categories);
      const elements = result.elements || [];

      for (const el of elements) {
        const lat = el.lat || el.center?.lat;
        const lon = el.lon || el.center?.lon;
        if (!lat || !lon) continue;

        const tags = el.tags || {};
        const category = categorizePOI(tags);

        // Find distance to trail
        const { distance, distanceAlongTrail } = findNearestTrailPoint({ lat, lon }, trail.track.points);

        // Only include POIs within buffer distance
        if (distance <= BUFFER_KM) {
          allPOIs.set(el.id, {
            id: el.id,
            type: el.type,
            category,
            lat,
            lon,
            name: tags.name || null,
            tags,
            distanceAlongTrail,
          });
        }
      }

      console.log(` found ${elements.length} elements`);
    } catch (error) {
      console.log(` FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Rate limiting between chunks
    if (i < chunks.length - 1) {
      await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  const pois = Array.from(allPOIs.values());

  // Sort by distance along trail
  pois.sort((a, b) => (a.distanceAlongTrail || 0) - (b.distanceAlongTrail || 0));

  // Count by category
  const counts: Record<string, number> = {};
  for (const poi of pois) {
    counts[poi.category] = (counts[poi.category] || 0) + 1;
  }

  console.log(`  Total POIs found: ${pois.length}`);
  for (const [cat, count] of Object.entries(counts)) {
    console.log(`    - ${cat}: ${count}`);
  }

  // Save to trail data
  trail.pois = pois;
  fs.writeFileSync(trailPath, JSON.stringify(trail, null, 2));
  console.log(`  Updated ${trailPath}`);

  return pois.length > 0;
}

async function main() {
  console.log('POI Fetch Script');
  console.log('================');

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

    // Delay between trails to be nice to Overpass
    if (trailFiles.indexOf(trailFile) < trailFiles.length - 1) {
      await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  console.log(`\n================`);
  console.log(`Done. Updated ${updatedCount} trail(s) with POI data.`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
