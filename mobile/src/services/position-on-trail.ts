/**
 * Snap a GPS coordinate onto a trail track.
 *
 * Extracted from the old app's HikeDashboard / useLocation flow so the geometry
 * has one pure, testable home: given (lat, lon) and a distance-sorted track,
 * return the nearest track point's cumulative km ("current km") plus how far the
 * fix sits from the trail in metres ("off-trail metres").
 *
 * The search mirrors the proven old-app strategy:
 *  - a windowed scan around a caller-supplied hint index (cheap for the common
 *    case where the hiker has barely moved since the last fix), then
 *  - a coarse-then-refine full scan fallback when the window result is too far
 *    (a fresh session, a big jump, or a genuine off-trail excursion).
 *
 * Distances use the shared `@lib/distance` haversine (metres); `dist` on each
 * point is cumulative kilometres. Kept React-free so it is unit-testable and
 * usable from any hook or service.
 */

import { haversineDistance } from '@lib/distance';

/** Minimal track-point shape needed to snap a coordinate. */
export interface SnapPoint {
  lat: number;
  lon: number;
  /** Cumulative distance along the trail in km. */
  dist: number;
}

export interface SnapResult {
  /** Index of the nearest track point (feed back as the next hint). */
  index: number;
  /** Cumulative km at the nearest track point. */
  currentKm: number;
  /** Straight-line distance from the fix to the nearest track point, in metres. */
  offTrailMeters: number;
}

/**
 * On-trail boundary in metres. At or below this the fix counts as on the trail;
 * beyond it the position is "off trail". Matches the old app's `normal`
 * off-trail preset `onTrail` value.
 */
export const OFF_TRAIL_THRESHOLD_M = 50;

/** Half-width (in points) of the windowed scan around the hint index. */
const WINDOW_SIZE = 50;
/** Window result must be within this many metres to be trusted over a full scan. */
const WINDOW_TRUST_M = 500;

/**
 * Snap (lat, lon) to the nearest point on `points`.
 *
 * @param hintIndex Optional previous nearest index — enables the cheap windowed
 *   scan. Pass the `index` from the previous result to keep tracking cheap.
 * @returns null when there is no geometry to snap to.
 */
export function snapToTrail(
  lat: number,
  lon: number,
  points: readonly SnapPoint[],
  hintIndex?: number,
): SnapResult | null {
  if (points.length === 0) return null;

  // --- Windowed scan around the hint -------------------------------------
  if (hintIndex != null && hintIndex >= 0 && hintIndex < points.length) {
    const start = Math.max(0, hintIndex - WINDOW_SIZE);
    const end = Math.min(points.length - 1, hintIndex + WINDOW_SIZE);
    let nearestIdx = start;
    let nearestDist = Infinity;
    for (let i = start; i <= end; i++) {
      const d = haversineDistance(lat, lon, points[i].lat, points[i].lon);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    // Trust the window only when it lands us reasonably close; a far result
    // means the hiker jumped or wandered — fall through to the full scan.
    if (nearestDist < WINDOW_TRUST_M) {
      return {
        index: nearestIdx,
        currentKm: points[nearestIdx].dist,
        offTrailMeters: nearestDist,
      };
    }
  }

  // --- Coarse-then-refine full scan --------------------------------------
  let nearestIdx = 0;
  let nearestDist = Infinity;
  const step = Math.max(1, Math.floor(points.length / 500));
  for (let i = 0; i < points.length; i += step) {
    const d = haversineDistance(lat, lon, points[i].lat, points[i].lon);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }
  // Refine around the coarse winner.
  const refineStart = Math.max(0, nearestIdx - step);
  const refineEnd = Math.min(points.length - 1, nearestIdx + step);
  for (let i = refineStart; i <= refineEnd; i++) {
    const d = haversineDistance(lat, lon, points[i].lat, points[i].lon);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }

  return {
    index: nearestIdx,
    currentKm: points[nearestIdx].dist,
    offTrailMeters: nearestDist,
  };
}

/** Whether an off-trail distance (metres) counts as off the trail. */
export function isOffTrail(offTrailMeters: number | null): boolean {
  return offTrailMeters != null && offTrailMeters > OFF_TRAIL_THRESHOLD_M;
}
