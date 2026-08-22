/**
 * Target-point-count track simplification and coordinate truncation.
 *
 * Lifted verbatim (behaviour-wise) from `scripts/build-mobile-trails.ts`, which
 * now imports it back. The runtime GPX importer uses the same budgets so an
 * imported trail costs the same on a phone as a bundled one.
 *
 * Kept separate from `gpx-optimizer.ts` because these operate on built track
 * points (`{lat, lon, ele, dist}`) rather than raw `GpxPoint`s, and because the
 * mobile bundle wants this without the optimizer's parse/serialize surface.
 */

import type { TrackPoint } from './trail-types';

const EARTH_RADIUS_METERS = 6371000;

/** The minimum a point needs for simplification: a position. */
export interface LatLonPoint {
  lat: number;
  lon: number;
}

/**
 * Perpendicular distance from a point to a line segment (equirectangular
 * approximation). Same approach as `gpx-optimizer.ts`.
 */
function perpendicularDistance(
  point: LatLonPoint,
  lineStart: LatLonPoint,
  lineEnd: LatLonPoint,
): number {
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const lat1 = toRadians(lineStart.lat);
  const lat2 = toRadians(lineEnd.lat);
  const latP = toRadians(point.lat);
  const lon1 = toRadians(lineStart.lon);
  const lon2 = toRadians(lineEnd.lon);
  const lonP = toRadians(point.lon);

  const cosAvg = Math.cos((lat1 + lat2) / 2);
  const x1 = lon1 * cosAvg * EARTH_RADIUS_METERS;
  const y1 = lat1 * EARTH_RADIUS_METERS;
  const x2 = lon2 * cosAvg * EARTH_RADIUS_METERS;
  const y2 = lat2 * EARTH_RADIUS_METERS;
  const xP = lonP * cosAvg * EARTH_RADIUS_METERS;
  const yP = latP * EARTH_RADIUS_METERS;

  const lineLengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lineLengthSquared === 0) {
    return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  }

  const t = Math.max(0, Math.min(1, ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lineLengthSquared));
  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);

  return Math.sqrt((xP - projX) ** 2 + (yP - projY) ** 2);
}

/**
 * Iterative Douglas-Peucker simplification. Returns references to the original
 * point objects (never copies), so callers can key off identity.
 */
export function simplifyTrack<T extends LatLonPoint>(points: T[], tolerance: number): T[] {
  if (points.length <= 2) return points;

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIndex = start;

    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    if (maxDist > tolerance) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify points to approximately `targetCount` using Douglas-Peucker with a
 * binary search over the tolerance (1m..500m, 20 iterations, stops once within
 * 10% of the target).
 */
export function simplifyToTarget<T extends LatLonPoint>(points: T[], targetCount: number): T[] {
  if (points.length <= targetCount) return points;

  // Binary search for the right tolerance
  let lo = 1; // 1 meter
  let hi = 500; // 500 meters
  let best = points;

  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const result = simplifyTrack(points, mid);

    if (result.length > targetCount) {
      lo = mid;
    } else {
      hi = mid;
      best = result;
    }

    // Close enough (within 10%)
    if (Math.abs(result.length - targetCount) < targetCount * 0.1) {
      best = result;
      break;
    }
  }

  return best;
}

/**
 * Truncate coordinate precision.
 * lat/lon: 6 decimal places (~0.1m), ele: 1 decimal, dist: 1 decimal
 */
export function truncatePoint(p: TrackPoint): TrackPoint {
  return {
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    ele: Math.round(p.ele * 10) / 10,
    dist: Math.round(p.dist * 10) / 10,
  };
}

export function truncatePoints(points: TrackPoint[]): TrackPoint[] {
  return points.map(truncatePoint);
}
