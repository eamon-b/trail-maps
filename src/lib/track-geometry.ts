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

/**
 * Minimal point shape for elevation calculations.
 *
 * The two cumulative fields are the fix for a simplified track: summing
 * point-to-point steps over a thinned line loses most of its small climbs
 * (measured at 14-35% of the total on the phone's 5,000-point copy). When they
 * are present they were computed on the *full-resolution* track before it was
 * thinned, so the climb over any span is the difference of its two ends — O(1),
 * and the same number the full-resolution walk gives. They are optional: the
 * web and imported trails carry full-resolution points and walk them directly.
 *
 * Either both are present or neither is.
 */
export interface ElevationPoint extends DistancePoint {
  /** Elevation in metres */
  ele: number;
  /** Cumulative ascent from the start of the route to this point, in metres. */
  cumAscent?: number;
  /** Cumulative descent from the start of the route to this point, in metres. */
  cumDescent?: number;
}

/** Whether a point carries the pre-computed cumulative climb pair. */
export function hasCumulativeElevation(
  point: ElevationPoint | undefined,
): point is ElevationPoint & { cumAscent: number; cumDescent: number } {
  return (
    point !== undefined &&
    typeof point.cumAscent === 'number' &&
    typeof point.cumDescent === 'number'
  );
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

/** Shared empty set, so the common no-breaks call allocates nothing. */
export const NO_BREAK_STARTS: ReadonlySet<number> = new Set<number>();

/**
 * Calculate elevation gain and loss between two km positions on the trail.
 *
 * `breakStarts` holds the indices into `trackPoints` of the first point after
 * each route break (see `routeBreakStarts` in `route-breaks.ts`). The step into
 * one is a ferry or an unbridged river, not trail, so its elevation change is
 * not climbed — the same rule `buildTrail` applies to `totalAscent`. Omit it
 * for a continuous route.
 *
 * When the endpoints carry {@link ElevationPoint.cumAscent}/`cumDescent` — the
 * phone's thinned tracks do — the answer is their difference instead of a walk
 * of the (lossy) steps in between, and `breakStarts` is not consulted.
 */
export function calculateElevationBetween(
  startKm: number,
  endKm: number,
  trackPoints: ElevationPoint[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): { gain: number; loss: number } {
  const startIdx = findNearestByDistance(trackPoints, startKm);
  const endIdx = findNearestByDistance(trackPoints, endKm);

  let gain = 0;
  let loss = 0;
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);

  // Pre-computed cumulative climb: the difference of the two ends. The break
  // steps were already left out when the sums were built, so `breakStarts` has
  // nothing left to skip here.
  const loPoint = trackPoints[lo];
  const hiPoint = trackPoints[hi];
  if (hasCumulativeElevation(loPoint) && hasCumulativeElevation(hiPoint)) {
    return {
      gain: Math.round(Math.max(0, hiPoint.cumAscent - loPoint.cumAscent)),
      loss: Math.round(Math.max(0, hiPoint.cumDescent - loPoint.cumDescent)),
    };
  }

  for (let i = lo + 1; i <= hi && i < trackPoints.length; i++) {
    if (breakStarts.has(i)) continue;
    const diff = trackPoints[i].ele - trackPoints[i - 1].ele;
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
  }

  return { gain: Math.round(gain), loss: Math.round(loss) };
}

/**
 * Attach cumulative ascent/descent to every point of a full-resolution track,
 * so a thinned copy of it can still report the climb it really has.
 *
 * The running sums skip the step into each of `breakStarts` for exactly the
 * reason `calculateElevationBetween` does — a ferry is not climbed — which is
 * also what makes breaks need no handling at query time once the fields exist.
 *
 * Returns new objects; the input is not mutated. Run this *before* thinning:
 * Douglas-Peucker returns references to the points it keeps, so the values ride
 * along.
 */
export function annotateCumulativeElevation<T extends ElevationPoint>(
  points: readonly T[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): Array<T & { cumAscent: number; cumDescent: number }> {
  let cumAscent = 0;
  let cumDescent = 0;
  return points.map((point, i) => {
    if (i > 0 && !breakStarts.has(i)) {
      const diff = point.ele - points[i - 1].ele;
      if (diff > 0) cumAscent += diff;
      else cumDescent -= diff;
    }
    return { ...point, cumAscent, cumDescent };
  });
}
