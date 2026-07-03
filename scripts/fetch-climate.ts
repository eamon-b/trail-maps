/**
 * Pre-fetch climate data for trail locations at build time.
 *
 * This script queries the Open-Meteo Historical Weather API to get
 * 30-year averages for temperature and precipitation along each trail.
 * Results are saved to data/trails/{trail}/climate.json files which
 * can be committed to the repository.
 *
 * Usage: tsx scripts/fetch-climate.ts [--force] [trail-id]
 *   - With no arguments: processes trails that don't have climate.json
 *   - With --force: re-fetches data even if climate.json already exists
 *   - With trail-id: processes only that trail
 */

import * as fs from 'fs';
import * as path from 'path';
import { aggregateDailyToMonthly, type MonthlyClimate } from '../src/lib/climate-aggregate.js';

interface ClimateLocation {
  name: string;
  waypointName?: string;
  lat: number;
  lon: number;
}

interface TrailConfig {
  id: string;
  name: string;
  climateLocations?: ClimateLocation[];
  [key: string]: unknown;
}

interface ProcessedTrail {
  config: TrailConfig;
  track: {
    points: { lat: number; lon: number; ele: number; dist: number }[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: Array<{
    name: string;
    lat: number;
    lon: number;
    totalDistance?: number;
    elevation?: number;
    [key: string]: unknown;
  }>;
  climate: TrailClimate | null;
  pois?: unknown[];
}

interface ClimateLocationData {
  name: string;
  lat: number;
  lon: number;
  elevation?: number;
  distanceAlongTrail?: number;
  monthly: MonthlyClimate[];
}

interface TrailClimate {
  generatedAt: string;
  dataYears: { start: number; end: number };
  locations: ClimateLocationData[];
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  elevation: number;
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
  };
}

// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
const CLIMATE_FILENAME = 'climate.json';

const OPEN_METEO_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
const DELAY_BETWEEN_QUERIES_MS = 1000; // Rate limiting
const RATE_LIMIT_RETRY_DELAY_MS = 61000; // Wait 61 seconds on 429 errors
const MAX_RETRIES = 3;
const DATA_START_YEAR = 1994;
const DATA_END_YEAR = 2023;

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch historical climate data from Open-Meteo for a single location.
 * Throws RateLimitError on 429 responses so callers can handle retry logic.
 */
async function fetchHistoricalClimate(lat: number, lon: number): Promise<OpenMeteoResponse> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    start_date: `${DATA_START_YEAR}-01-01`,
    end_date: `${DATA_END_YEAR}-12-31`,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'auto',
  });

  const url = `${OPEN_METEO_ENDPOINT}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      throw new RateLimitError(`Rate limit exceeded: ${errorText.slice(0, 200)}`);
    }
    throw new Error(`Open-Meteo API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Fetch climate data with automatic retry on rate limit errors.
 */
async function fetchWithRetry(lat: number, lon: number): Promise<OpenMeteoResponse> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchHistoricalClimate(lat, lon);
    } catch (error) {
      if (!(error instanceof RateLimitError)) {
        throw error; // Non-rate-limit errors should propagate immediately
      }
      if (attempt === MAX_RETRIES) {
        throw error; // Final attempt failed, propagate the rate limit error
      }
      console.log(` rate limited, waiting 60s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      process.stdout.write(`  Retrying...`);
    }
  }

  // TypeScript satisfaction - unreachable due to throw in loop
  throw new Error('Max retries exceeded');
}

/**
 * Find distance along trail for a waypoint by name.
 */
function findWaypointDistance(
  waypointName: string,
  waypoints: ProcessedTrail['waypoints']
): { distance: number; elevation: number } | null {
  const wp = waypoints.find(w =>
    w.name.toLowerCase() === waypointName.toLowerCase()
  );

  if (wp && wp.totalDistance != null) {
    return {
      distance: wp.totalDistance,
      elevation: wp.elevation || 0,
    };
  }

  return null;
}

/**
 * Process a single trail directory - fetch climate data for all configured locations.
 * Saves climate data to data/trails/{trail}/climate.json
 */
async function processTrail(trailDir: string, force: boolean): Promise<boolean> {
  const trailName = path.basename(trailDir);
  const configPath = path.join(trailDir, 'trail.json');
  const climatePath = path.join(trailDir, CLIMATE_FILENAME);

  console.log(`\nProcessing: ${trailName}`);

  // Check if trail.json exists
  if (!fs.existsSync(configPath)) {
    console.log('  No trail.json config found. Skipping.');
    return false;
  }

  // Check if climate.json already exists (unless --force is used)
  if (fs.existsSync(climatePath) && !force) {
    console.log('  climate.json already exists. Skipping (use --force to re-fetch).');
    return false;
  }

  const config: TrailConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (!config.climateLocations || config.climateLocations.length === 0) {
    console.log('  No climateLocations configured. Skipping.');
    return false;
  }

  console.log(`  Found ${config.climateLocations.length} climate location(s)`);

  // Try to load waypoint data from generated file for distance enrichment
  let waypoints: ProcessedTrail['waypoints'] = [];
  const generatedPath = path.join(GENERATED_DIR, `${config.id}.json`);
  if (fs.existsSync(generatedPath)) {
    try {
      const generated: ProcessedTrail = JSON.parse(fs.readFileSync(generatedPath, 'utf-8'));
      waypoints = generated.waypoints || [];
    } catch {
      // Ignore errors reading generated file
    }
  }

  const locations: ClimateLocationData[] = [];

  for (let i = 0; i < config.climateLocations.length; i++) {
    const loc = config.climateLocations[i];
    process.stdout.write(`  Fetching ${loc.name}...`);

    try {
      const response = await fetchWithRetry(loc.lat, loc.lon);
      const monthly = aggregateDailyToMonthly(response.daily);

      const locationData: ClimateLocationData = {
        name: loc.name,
        lat: loc.lat,
        lon: loc.lon,
        elevation: response.elevation,
        monthly,
      };

      // Add distance along trail if waypoint reference exists
      if (loc.waypointName && waypoints.length > 0) {
        const wpData = findWaypointDistance(loc.waypointName, waypoints);
        if (wpData) {
          locationData.distanceAlongTrail = wpData.distance;
          // Use waypoint elevation if API elevation seems off
          if (wpData.elevation && Math.abs(wpData.elevation - response.elevation) > 200) {
            locationData.elevation = wpData.elevation;
          }
        }
      }

      locations.push(locationData);
      console.log(' done');
    } catch (error) {
      console.log(` FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Rate limiting between API calls
    if (i < config.climateLocations.length - 1) {
      await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  if (locations.length === 0) {
    console.log('  No climate data fetched.');
    return false;
  }

  // Sort locations by distance along trail (if available)
  locations.sort((a, b) => (a.distanceAlongTrail || 0) - (b.distanceAlongTrail || 0));

  // Build climate data structure
  const climate: TrailClimate = {
    generatedAt: new Date().toISOString(),
    dataYears: { start: DATA_START_YEAR, end: DATA_END_YEAR },
    locations,
  };

  // Save climate data to separate file
  fs.writeFileSync(climatePath, JSON.stringify(climate, null, 2));
  console.log(`  Saved ${climatePath}`);

  // Update trail.json to reference climate file if not already set
  if (config.climateFile !== CLIMATE_FILENAME) {
    config.climateFile = CLIMATE_FILENAME;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  Updated trail.json with climateFile reference`);
  }

  console.log(`  Locations: ${locations.length}`);

  return true;
}

async function main() {
  console.log('Climate Fetch Script');
  console.log('====================');
  console.log(`Data range: ${DATA_START_YEAR}-${DATA_END_YEAR}`);

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const trailArgs = args.filter(arg => arg !== '--force');
  const specificTrail = trailArgs[0];

  if (force) {
    console.log('Force mode: will re-fetch existing climate data');
  }

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`\nError: Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }

  // Find trail directories to process
  let trailDirs: string[];

  if (specificTrail) {
    // Find trail directory by matching trail ID in trail.json
    const allDirs = fs.readdirSync(DATA_DIR)
      .map(name => path.join(DATA_DIR, name))
      .filter(p => fs.statSync(p).isDirectory());

    const matchingDir = allDirs.find(dir => {
      const configPath = path.join(dir, 'trail.json');
      if (!fs.existsSync(configPath)) return false;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return config.id === specificTrail;
      } catch {
        return false;
      }
    });

    if (!matchingDir) {
      console.error(`\nError: Trail not found: ${specificTrail}`);
      console.error(`No trail.json with id="${specificTrail}" found in ${DATA_DIR}`);
      process.exit(1);
    }
    trailDirs = [matchingDir];
  } else {
    trailDirs = fs.readdirSync(DATA_DIR)
      .map(name => path.join(DATA_DIR, name))
      .filter(p => fs.statSync(p).isDirectory());
  }

  if (trailDirs.length === 0) {
    console.log('\nNo trail directories found to process.');
    return;
  }

  console.log(`\nFound ${trailDirs.length} trail(s) to process.`);

  let updatedCount = 0;

  for (let i = 0; i < trailDirs.length; i++) {
    const trailDir = trailDirs[i];
    try {
      const updated = await processTrail(trailDir, force);
      if (updated) updatedCount++;
    } catch (error) {
      console.error(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Delay between trails to be nice to Open-Meteo
    if (i < trailDirs.length - 1) {
      await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  console.log(`\n====================`);
  console.log(`Done. Updated ${updatedCount} trail(s) with climate data.`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
