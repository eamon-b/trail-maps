/**
 * Snap a GPS coordinate onto a trail track.
 *
 * Extracted from the old app's HikeDashboard / useLocation flow so the geometry
 * has one pure, testable home: given (lat, lon) and a distance-sorted track,
 * return the cumulative km of the nearest point ON THE LINE ("current km") plus
 * how far the fix sits from the trail in metres ("off-trail metres").
 *
 * The fix is snapped to the nearest SEGMENT, not the nearest vertex. Bundled
 * tracks are thinned to a few thousand points (the CDT keeps ~5,300 over
 * 4,800 km, ~900 m apart), so a vertex snap put a hiker standing on the line
 * hundreds of metres "off trail" — far past {@link OFF_TRAIL_THRESHOLD_M} — and
 * read their km off whichever end of the segment happened to be nearer.
 *
 * The search:
 *  - a windowed scan of the segments around a caller-supplied hint index (the
 *    common case: the hiker has barely moved since the last fix), then
 *  - an exact scan of every segment when the window result is too far (a fresh
 *    session, a big jump, or a genuine off-trail excursion). It used to be a
 *    coarse-then-refine scan of every Nth vertex, which could settle in the
 *    wrong part of the trail entirely; a full scan is a few multiplications per
 *    segment, and runs only when the window gives up.
 *
 * Distances to segments are measured in a local equirectangular projection
 * centred on the fix — accurate to well under a metre at the scale a snap
 * cares about — and the reported off-trail distance is the shared
 * `@lib/distance` haversine (metres) to the snapped point. `dist` on each point
 * is cumulative kilometres. Kept React-free so it is unit-testable and usable
 * from any hook or service.
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
  /**
   * Start vertex of the segment the fix snapped onto (feed back as the next
   * hint). A fix that lands exactly on a vertex reports that vertex.
   */
  index: number;
  /** Cumulative km at the snapped point, interpolated along the segment. */
  currentKm: number;
  /** Distance from the fix to the snapped point on the line, in metres. */
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

/** Metres per degree of latitude (and of longitude at the equator). */
const METRES_PER_DEGREE = 111_320;

/** The best candidate a scan has found so far. */
interface Candidate {
  index: number;
  /** Projection parameter along segment `index` → `index + 1`, 0..1. */
  t: number;
  /** Squared projected distance, in m², for ranking only. */
  distSq: number;
}

/** Longitude difference folded into [-180, 180], so a track across the antimeridian measures short. */
function deltaLon(a: number, b: number): number {
  let d = a - b;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/**
 * Scan segments starting at vertices `from`..`to` (inclusive) for the one
 * nearest the fix, in the local projection.
 *
 * `breakStarts` holds the first index after each route break: the step into
 * one is a ferry or an unbridged river, not trail, so the segment ending there
 * is never a candidate. A vertex with no walkable segment after it (the end of
 * the track, or the last point before a break) is still a candidate as a point.
 */
function scanSegments(
  lat: number,
  lon: number,
  points: readonly SnapPoint[],
  from: number,
  to: number,
  breakStarts: ReadonlySet<number> | undefined,
): Candidate {
  const kx = Math.cos((lat * Math.PI) / 180) * METRES_PER_DEGREE;
  const ky = METRES_PER_DEGREE;
  let best: Candidate = { index: from, t: 0, distSq: Infinity };

  for (let i = from; i <= to; i++) {
    const a = points[i];
    // The fix sits at the projection's origin, so a vertex's coordinates are
    // its offset from the fix.
    const ax = deltaLon(a.lon, lon) * kx;
    const ay = (a.lat - lat) * ky;

    let t = 0;
    let px = ax;
    let py = ay;
    const hasSegment = i + 1 < points.length && !breakStarts?.has(i + 1);
    if (hasSegment) {
      const b = points[i + 1];
      const dx = deltaLon(b.lon, a.lon) * kx;
      const dy = (b.lat - a.lat) * ky;
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 0) {
        // Foot of the perpendicular from the origin, clamped to the segment.
        t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
        px = ax + t * dx;
        py = ay + t * dy;
      }
    }

    const distSq = px * px + py * py;
    // `<` only: ties keep the earlier segment, as the vertex scan did.
    if (distSq < best.distSq) best = { index: i, t, distSq };
  }

  return best;
}

/** Turn a scan's winner into the public result. */
function toResult(lat: number, lon: number, points: readonly SnapPoint[], c: Candidate): SnapResult {
  const a = points[c.index];
  // A fix that projects onto a segment's far end is AT the next vertex, which is
  // what the result names: the hint stays on the vertex the hiker reached, and
  // `index` is always the start of the segment the snapped point lies on.
  if (c.t >= 1) {
    const b = points[c.index + 1];
    return {
      index: c.index + 1,
      currentKm: b.dist,
      offTrailMeters: haversineDistance(lat, lon, b.lat, b.lon),
    };
  }
  if (c.t <= 0) {
    return {
      index: c.index,
      currentKm: a.dist,
      offTrailMeters: haversineDistance(lat, lon, a.lat, a.lon),
    };
  }
  const b = points[c.index + 1];
  const snapLat = a.lat + c.t * (b.lat - a.lat);
  const snapLon = a.lon + c.t * deltaLon(b.lon, a.lon);
  return {
    index: c.index,
    currentKm: a.dist + c.t * (b.dist - a.dist),
    offTrailMeters: haversineDistance(lat, lon, snapLat, snapLon),
  };
}

/**
 * Snap (lat, lon) to the nearest point on the line through `points`.
 *
 * @param hintIndex Optional previous result `index` — enables the cheap
 *   windowed scan. Pass the `index` from the previous result to keep tracking
 *   cheap.
 * @param breakStarts The track's route breaks as `routeBreakStarts(breaks,
 *   'points')` (`@lib/route-breaks`), for whichever array `points` is. Without
 *   it a fix on a ferry could snap onto the straight line between the landings
 *   and report a km the trail never passes through.
 * @returns null when there is no geometry to snap to.
 */
export function snapToTrail(
  lat: number,
  lon: number,
  points: readonly SnapPoint[],
  hintIndex?: number,
  breakStarts?: ReadonlySet<number>,
): SnapResult | null {
  if (points.length === 0) return null;

  // --- Windowed scan around the hint -------------------------------------
  if (hintIndex != null && hintIndex >= 0 && hintIndex < points.length) {
    const start = Math.max(0, hintIndex - WINDOW_SIZE);
    const end = Math.min(points.length - 1, hintIndex + WINDOW_SIZE);
    const result = toResult(lat, lon, points, scanSegments(lat, lon, points, start, end, breakStarts));
    // Trust the window only when it lands us reasonably close; a far result
    // means the hiker jumped or wandered — fall through to the full scan.
    if (result.offTrailMeters < WINDOW_TRUST_M) return result;
  }

  // --- Exact full scan ----------------------------------------------------
  return toResult(lat, lon, points, scanSegments(lat, lon, points, 0, points.length - 1, breakStarts));
}

/** Whether an off-trail distance (metres) counts as off the trail. */
export function isOffTrail(offTrailMeters: number | null): boolean {
  return offTrailMeters != null && offTrailMeters > OFF_TRAIL_THRESHOLD_M;
}
