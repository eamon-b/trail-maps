import type { GpxPoint, GpxWaypoint } from './types';

export const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculate 2D distance between two points using Haversine formula
 * Returns distance in meters
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculate 2D (horizontal) distance between two coordinate pairs using Haversine formula
 * Returns distance in meters
 */
export function haversineDistance2D(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculate distance between two GpxPoints (2D, ignoring elevation)
 */
export function pointToPointDistance(p1: GpxPoint, p2: GpxPoint): number {
  return haversineDistance2D(p1.lat, p1.lon, p2.lat, p2.lon);
}

/**
 * Calculate 3D distance between two points using Haversine formula
 * Returns distance in meters
 */
export function haversineDistance3D(
  lat1: number,
  lon1: number,
  ele1: number,
  lat2: number,
  lon2: number,
  ele2: number
): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const horizontalDist = EARTH_RADIUS_METERS * c;

  const elevationDiff = ele2 - ele1;
  return Math.sqrt(horizontalDist ** 2 + elevationDiff ** 2);
}

/**
 * Calculate distance between a waypoint and a track point
 */
export function waypointToPointDistance(
  waypoint: GpxWaypoint,
  point: GpxPoint
): number {
  return haversineDistance3D(
    waypoint.lat,
    waypoint.lon,
    waypoint.ele,
    point.lat,
    point.lon,
    point.ele
  );
}

/**
 * Check if a waypoint is close to any point in a list of points
 * @param waypoint The waypoint to check
 * @param points List of track points
 * @param maxDistanceKm Maximum distance in kilometers
 * @returns true if waypoint is within maxDistanceKm of any point
 */
export function isWaypointNearPoints(
  waypoint: GpxWaypoint,
  points: GpxPoint[],
  maxDistanceKm: number
): boolean {
  const maxDistanceMeters = maxDistanceKm * 1000;

  for (const point of points) {
    if (waypointToPointDistance(waypoint, point) < maxDistanceMeters) {
      return true;
    }
  }

  return false;
}

/**
 * Find all waypoints that are close to any point in the track segment
 */
export function findCloseWaypoints(
  points: GpxPoint[],
  waypoints: GpxWaypoint[],
  maxDistanceKm: number
): GpxWaypoint[] {
  return waypoints.filter(waypoint =>
    isWaypointNearPoints(waypoint, points, maxDistanceKm)
  );
}
