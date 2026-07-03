/**
 * Shared track geometry helpers.
 *
 * Single source of truth for nearest-point lookup and elevation accumulation
 * along a distance-sorted track. Used by the web viewers, the plan
 * calculators, and the mobile app (via Metro watchFolders / the @lib alias).
 *
 * Parameter types are structural ({ dist }, { dist, ele }) so both the web
 * TrackPoint/PlanTrackPoint shapes and the mobile TrackPoint shape work
 * without conversion.
 */

/** Minimal point shape for distance-based lookup. */
export interface DistancePoint {
  /** Cumulative distance along the trail in km */
  dist: number;
}

/** Minimal point shape for elevation calculations. */
export interface ElevationPoint extends DistancePoint {
  /** Elevation in metres */
  ele: number;
}

/**
 * Find the index of the track point nearest to a given km distance.
 * Uses binary search for efficiency on sorted distance arrays.
 * Ties (target exactly halfway between two points) resolve to the earlier point.
 */
export function findNearestByDistance(points: DistancePoint[], targetKm: number): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return 0;

  let lo = 0;
  let hi = points.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < targetKm) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first point with dist >= targetKm; check if lo-1 is closer
  if (lo > 0) {
    const diffBefore = Math.abs(points[lo - 1].dist - targetKm);
    const diffAfter = Math.abs(points[lo].dist - targetKm);
    return diffBefore <= diffAfter ? lo - 1 : lo;
  }

  return lo;
}

/**
 * Calculate elevation gain and loss between two km positions on the trail.
 */
export function calculateElevationBetween(
  startKm: number,
  endKm: number,
  trackPoints: ElevationPoint[],
): { gain: number; loss: number } {
  const startIdx = findNearestByDistance(trackPoints, startKm);
  const endIdx = findNearestByDistance(trackPoints, endKm);

  let gain = 0;
  let loss = 0;
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  for (let i = lo + 1; i <= hi && i < trackPoints.length; i++) {
    const diff = trackPoints[i].ele - trackPoints[i - 1].ele;
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
  }

  return { gain: Math.round(gain), loss: Math.round(loss) };
}
