/**
 * Build mobile-optimized trail JSON files.
 *
 * Reads the generated trail JSON from public/data/generated/,
 * reduces track.points via Douglas-Peucker to ~5000 points,
 * truncates coordinate precision, and writes to mobile/assets/trails/.
 *
 * Usage: tsx scripts/build-mobile-trails.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { simplifyToTarget, truncatePoints } from '../src/lib/track-simplify.js';
import type { TrackPoint } from '../src/lib/trail-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GENERATED_DIR = path.join(__dirname, '..', 'public', 'data', 'generated');
const MOBILE_TRAILS_DIR = path.join(__dirname, '..', 'mobile', 'assets', 'trails');

// Target ~5000 points for main track (enough for elevation profile + ~200m resolution on 1000km trail)
const TARGET_POINTS = 5000;

// Name corrections for index.json
const NAME_FIXES: Record<string, { name: string; shortName: string }> = {
  bibbulmun: { name: 'Bibbulmun Track', shortName: 'Bibb' },
  larapinta: { name: 'Larapinta Trail', shortName: 'Larapinta' },
};

interface TrailJson {
  config: Record<string, unknown>;
  /** Present only for trails with a data/trails/<dir>/pois.json; stripped below. */
  pois?: unknown;
  track: {
    points: TrackPoint[];
    displayPoints: TrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: Array<Record<string, unknown>>;
  alternates?: Array<{ points?: TrackPoint[]; [key: string]: unknown }>;
  sideTrips?: Array<{ points?: TrackPoint[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface IndexEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
}

/**
 * Truncate waypoint coordinate precision.
 */
function truncateWaypoint(wp: Record<string, unknown>): Record<string, unknown> {
  const result = { ...wp };
  if (typeof result.lat === 'number') result.lat = Math.round(result.lat * 1e6) / 1e6;
  if (typeof result.lon === 'number') result.lon = Math.round(result.lon * 1e6) / 1e6;
  if (typeof result.elevation === 'number') result.elevation = Math.round(result.elevation as number * 10) / 10;
  if (typeof result.distance === 'number') result.distance = Math.round(result.distance as number * 10) / 10;
  if (typeof result.totalDistance === 'number') result.totalDistance = Math.round(result.totalDistance as number * 10) / 10;
  if (typeof result.ascent === 'number') result.ascent = Math.round(result.ascent as number);
  if (typeof result.descent === 'number') result.descent = Math.round(result.descent as number);
  if (typeof result.totalAscent === 'number') result.totalAscent = Math.round(result.totalAscent as number);
  if (typeof result.totalDescent === 'number') result.totalDescent = Math.round(result.totalDescent as number);
  return result;
}

function processTrail(trail: TrailJson): TrailJson {
  // The app has no POI UI yet, so the `...trail` spread below would ship the
  // whole `pois` array into the bundled asset for nothing. Drop it here rather
  // than upstream: the web build still wants POIs in the generated JSON.
  const trailWithoutPois: TrailJson = { ...trail };
  delete trailWithoutPois.pois;

  // Simplify main track points
  const simplifiedPoints = simplifyToTarget(trail.track.points, TARGET_POINTS);

  // Process alternates
  const alternates = (trail.alternates ?? []).map((alt) => {
    if (!alt.points || alt.points.length === 0) return alt;
    return {
      ...alt,
      points: truncatePoints(simplifyToTarget(alt.points, Math.min(alt.points.length, 1000))),
    };
  });

  // Process side trips
  const sideTrips = (trail.sideTrips ?? []).map((st) => {
    if (!st.points || st.points.length === 0) return st;
    return {
      ...st,
      points: truncatePoints(simplifyToTarget(st.points, Math.min(st.points.length, 1000))),
    };
  });

  return {
    ...trailWithoutPois,
    config: trail.config,
    track: {
      points: truncatePoints(simplifiedPoints),
      displayPoints: truncatePoints(trail.track.displayPoints),
      totalDistance: Math.round(trail.track.totalDistance * 10) / 10,
      totalAscent: Math.round(trail.track.totalAscent),
      totalDescent: Math.round(trail.track.totalDescent),
    },
    waypoints: trail.waypoints.map(truncateWaypoint),
    alternates,
    sideTrips,
  };
}

function main() {
  // Read the index
  const indexPath = path.join(GENERATED_DIR, 'index.json');
  const index: IndexEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

  // Ensure output directory exists
  if (!fs.existsSync(MOBILE_TRAILS_DIR)) {
    fs.mkdirSync(MOBILE_TRAILS_DIR, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const mobileIndex: IndexEntry[] = [];

  let totalOriginal = 0;
  let totalOptimized = 0;

  for (const entry of index) {
    const inputPath = path.join(GENERATED_DIR, `${entry.id}.json`);
    if (!fs.existsSync(inputPath)) {
      console.warn(`  SKIP: ${entry.id}.json not found`);
      continue;
    }

    const rawJson = fs.readFileSync(inputPath, 'utf-8');
    const trail: TrailJson = JSON.parse(rawJson);
    const originalSize = rawJson.length;

    // Apply name fixes
    const nameFix = NAME_FIXES[entry.id];
    if (nameFix) {
      (trail.config as Record<string, unknown>).name = nameFix.name;
      (trail.config as Record<string, unknown>).shortName = nameFix.shortName;
    }

    const originalPointCount = trail.track.points.length;
    const optimized = processTrail(trail);
    const optimizedJson = JSON.stringify(optimized);
    const optimizedSize = optimizedJson.length;

    const outputPath = path.join(MOBILE_TRAILS_DIR, `${entry.id}.json`);
    fs.writeFileSync(outputPath, optimizedJson);

    totalOriginal += originalSize;
    totalOptimized += optimizedSize;

    console.log(
      `  ${entry.id}: ${(originalSize / 1024 / 1024).toFixed(2)}MB -> ${(optimizedSize / 1024 / 1024).toFixed(2)}MB` +
        ` (${originalPointCount} -> ${optimized.track.points.length} pts)`,
    );

    // Build mobile index entry
    mobileIndex.push({
      id: entry.id,
      name: nameFix?.name ?? entry.name,
      shortName: nameFix?.shortName ?? entry.shortName,
      lengthKm: entry.lengthKm,
      dataVersion: today,
    });
  }

  // Write mobile index
  const mobileIndexPath = path.join(MOBILE_TRAILS_DIR, 'index.json');
  fs.writeFileSync(mobileIndexPath, JSON.stringify(mobileIndex, null, 2));

  console.log('');
  console.log(`Total: ${(totalOriginal / 1024 / 1024).toFixed(2)}MB -> ${(totalOptimized / 1024 / 1024).toFixed(2)}MB`);
  console.log(`Wrote ${mobileIndex.length} trails + index.json to ${MOBILE_TRAILS_DIR}`);
}

main();
