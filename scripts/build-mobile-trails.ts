/**
 * Build mobile-optimized trail JSON files.
 *
 * Reads the generated trail JSON from public/data/generated/,
 * reduces track.points via Douglas-Peucker to ~5000 points,
 * truncates coordinate precision, slims OSM points of interest to the fields
 * the app reads (`slimPoi`), and writes to mobile/assets/trails/.
 *
 * The noise and duplicate-flagging passes have already run in build-trails.ts;
 * this script only shrinks what they produced.
 *
 * Usage: tsx scripts/build-mobile-trails.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { slimPoi } from '../src/lib/poi-display.js';
import { simplifyToTarget, truncatePoints } from '../src/lib/track-simplify.js';
import { routeBreakStarts, splitAtRouteBreaks } from '../src/lib/route-breaks.js';
import {
  annotateCumulativeElevation,
  findNearestByDistance,
} from '../src/lib/track-geometry.js';
import type { RouteBreak, TrackPoint, TrailPOI } from '../src/lib/trail-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GENERATED_DIR = path.join(__dirname, '..', 'public', 'data', 'generated');
const MOBILE_TRAILS_DIR = path.join(__dirname, '..', 'mobile', 'assets', 'trails');

// Target ~5000 points for main track (enough for elevation profile + ~200m resolution on 1000km trail)
const TARGET_POINTS = 5000;

// The same budget again for the map line. The web's `displayPoints` is no
// longer a fixed ~3,000 whatever the trail's length — since the tolerance
// ceiling went into `calculateAdaptiveTolerance`, a long trail keeps as many as
// it needs (the CDT ~21,000) so its line stops reading as straight chords. The
// phone should not pay for that in bundle size: what it draws only has to be no
// coarser than the `points` array it already ships, which is this budget.
const DISPLAY_TARGET_POINTS = TARGET_POINTS;

// Name corrections for index.json
const NAME_FIXES: Record<string, { name: string; shortName: string }> = {
  bibbulmun: { name: 'Bibbulmun Track', shortName: 'Bibb' },
  larapinta: { name: 'Larapinta Trail', shortName: 'Larapinta' },
};

export interface TrailJson {
  config: Record<string, unknown>;
  /** Present only for trails with a data/trails/<dir>/pois.json. Shipped slimmed. */
  pois?: TrailPOI[];
  track: {
    points: TrackPoint[];
    displayPoints: TrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
    breaks?: RouteBreak[];
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

/**
 * Simplify a copy of the main track to the phone's point budget, without
 * letting Douglas-Peucker walk across a route break.
 *
 * Simplifying the whole array at once drops the points either side of a break —
 * the endpoints of two separate lines — and joins them with one that crosses the
 * water. Measured on Te Araroa, a single pass to 5,000 points loses a boundary
 * point at three of its six breaks. So each stretch is simplified on its own and
 * the breaks are re-anchored to the concatenated result, which is what
 * `buildTrail` does for `displayPoints` (see trail-ingest.ts).
 *
 * The budget is shared out by point count, so a 1,100-point stretch and a
 * 35,000-point one are thinned by roughly the same factor rather than to the
 * same size.
 *
 * `which` names the array being thinned, because the breaks are indexed
 * separately into each (`index` into `points`, `displayIndex` into
 * `displayPoints`). The returned `boundaries` are the new first-point-after-a-
 * break offsets, one per break, for the caller to write back into whichever
 * field it just re-anchored.
 */
function simplifyMainTrack(
  points: TrackPoint[],
  breaks: RouteBreak[] | undefined,
  targetPoints: number,
  which: 'points' | 'displayPoints'
): { points: TrackPoint[]; boundaries: number[] } {
  if (!breaks || breaks.length === 0) {
    return { points: simplifyToTarget(points, targetPoints), boundaries: [] };
  }

  const stretches = splitAtRouteBreaks(points, breaks, which);
  const simplified = stretches.map(stretch =>
    // At least two points, or the stretch stops being a line at all.
    simplifyToTarget(stretch, Math.max(2, Math.round((targetPoints * stretch.length) / points.length)))
  );

  const rebuilt = simplified.flat();
  let offset = 0;
  const boundaries = simplified.slice(0, -1).map(stretch => {
    offset += stretch.length;
    return offset;
  });

  return { points: rebuilt, boundaries };
}

/**
 * Copy the cumulative climb from a full-resolution track onto a subset of it.
 *
 * `displayPoints` is what Douglas-Peucker kept of `points`, so it is a
 * subsequence of it and a single forward walk matching on coordinates lines the
 * two up — including where a trail doubles back over its own coordinates, which
 * a lat/lon lookup map would collapse. If the walk ever fails to find the next
 * point ahead (a display copy that is not a subsequence — not something
 * `buildTrail` produces, but nothing here depends on that), it gives up and
 * falls back to the nearest full-resolution point by km for the rest.
 */
function copyCumulativeOntoSubset(
  source: (TrackPoint & { cumAscent: number; cumDescent: number })[],
  subset: TrackPoint[]
): TrackPoint[] {
  let cursor = 0;
  let walking = true;

  return subset.map(point => {
    let matched = -1;
    if (walking) {
      let i = cursor;
      while (i < source.length && (source[i].lat !== point.lat || source[i].lon !== point.lon)) i++;
      if (i < source.length) {
        matched = i;
        cursor = i + 1;
      } else {
        walking = false;
      }
    }
    if (matched < 0) matched = findNearestByDistance(source, point.dist);
    return {
      ...point,
      cumAscent: source[matched].cumAscent,
      cumDescent: source[matched].cumDescent,
    };
  });
}

export function processTrail(trail: TrailJson): TrailJson {
  // Cumulative climb, measured on the full-resolution track *before* anything is
  // thinned away. Douglas-Peucker keeps the shape of the line, not its ups and
  // downs, so summing the steps of a 5,000-point copy at runtime reported only
  // 65-86% of the real ascent (issue #69). Carried on the points it keeps, the
  // climb over any span is the difference of its two ends instead — which is the
  // full-resolution number, and matches the waypoint rows and the web.
  const annotatedPoints = annotateCumulativeElevation(
    trail.track.points,
    routeBreakStarts(trail.track.breaks, 'points'),
  );

  // Simplify main track points
  const simplifiedMain = simplifyMainTrack(
    annotatedPoints,
    trail.track.breaks,
    TARGET_POINTS,
    'points',
  );
  const simplifiedPoints = simplifiedMain.points;

  // And the map line to its own budget. Thinning it keeps a subsequence of a
  // subsequence of the full-resolution track, so the cumulative climb below
  // still lines up point for point.
  const simplifiedDisplay = simplifyMainTrack(
    trail.track.displayPoints,
    trail.track.breaks,
    DISPLAY_TARGET_POINTS,
    'displayPoints',
  );

  // Custom-route stats are measured over displayPoints, which is thinned too, so
  // it needs the same numbers — read off the full-resolution points it came from.
  const displayPoints = copyCumulativeOntoSubset(annotatedPoints, simplifiedDisplay.points);

  // Both index fields now point into arrays this script rebuilt, so each break
  // carries the offset from whichever pass re-anchored it.
  const breaks = trail.track.breaks?.map((routeBreak, i) => ({
    ...routeBreak,
    index: simplifiedMain.boundaries[i] ?? routeBreak.index,
    displayIndex: simplifiedDisplay.boundaries[i] ?? routeBreak.displayIndex,
  }));

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
    ...trail,
    config: trail.config,
    track: {
      points: truncatePoints(simplifiedPoints),
      // Both arrays are thinned here, so both of a break's indices are
      // re-anchored to the result (see `breaks` above).
      displayPoints: truncatePoints(displayPoints),
      totalDistance: Math.round(trail.track.totalDistance * 10) / 10,
      totalAscent: Math.round(trail.track.totalAscent),
      totalDescent: Math.round(trail.track.totalDescent),
      ...(breaks ? { breaks } : {}),
    },
    waypoints: trail.waypoints.map(truncateWaypoint),
    alternates,
    sideTrips,
    // A trail that was never enriched keeps no `pois` key at all: absent means
    // "never fetched", which the app reads differently from "found nothing".
    ...(trail.pois ? { pois: trail.pois.map(slimPoi) } : {}),
  };
}

export function main() {
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

    // POI payload is the one part of the asset that grew in 2026-09; print it
    // so a fetch that doubles a trail's POI count is visible in the build log.
    const poiCount = optimized.pois?.length ?? 0;
    const poiKb = poiCount > 0 ? JSON.stringify(optimized.pois).length / 1024 : 0;

    console.log(
      `  ${entry.id}: ${(originalSize / 1024 / 1024).toFixed(2)}MB -> ${(optimizedSize / 1024 / 1024).toFixed(2)}MB` +
        ` (${originalPointCount} -> ${optimized.track.points.length} pts` +
        `, POIs: ${poiCount} (${poiKb.toFixed(1)} KB))`,
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

// Guarded so the module can be imported by a test without writing to
// mobile/assets/trails as a side effect of the import.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
