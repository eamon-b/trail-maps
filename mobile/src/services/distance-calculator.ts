import { findNearestByDistance, type TrackPoint, type TrailWaypoint } from '../lib/trail-utils';

export interface WaypointDistance {
  waypoint: TrailWaypoint;
  /** Trail distance from current position in km */
  trailDistanceKm: number;
  /** Elevation gain to this waypoint in meters */
  elevationGain: number;
  /** Elevation loss to this waypoint in meters */
  elevationLoss: number;
}

export interface NextWaypointsByType {
  campsite?: WaypointDistance;
  water?: WaypointDistance;
  town?: WaypointDistance;
  shelter?: WaypointDistance;
}

/**
 * Calculate trail distances and elevation changes from current position to upcoming waypoints.
 */
export function calculateDistancesToWaypoints(
  currentKm: number,
  waypoints: TrailWaypoint[],
  trackPoints: TrackPoint[],
): WaypointDistance[] {
  const upcoming = waypoints.filter(wp => (wp.totalDistance ?? 0) > currentKm);

  const currentIdx = findNearestByDistance(trackPoints, currentKm);

  return upcoming.map(wp => {
    const wpKm = wp.totalDistance ?? 0;
    const wpIdx = findNearestByDistance(trackPoints, wpKm);

    let gain = 0;
    let loss = 0;
    const startIdx = Math.min(currentIdx, wpIdx);
    const endIdx = Math.max(currentIdx, wpIdx);
    for (let i = startIdx + 1; i <= endIdx && i < trackPoints.length; i++) {
      const diff = trackPoints[i].ele - trackPoints[i - 1].ele;
      if (diff > 0) gain += diff;
      else loss += Math.abs(diff);
    }

    return {
      waypoint: wp,
      trailDistanceKm: wpKm - currentKm,
      elevationGain: Math.round(gain),
      elevationLoss: Math.round(loss),
    };
  });
}

/**
 * Get the next waypoint of each important type.
 */
export function getNextWaypointsByType(
  currentKm: number,
  waypoints: TrailWaypoint[],
  trackPoints: TrackPoint[],
): NextWaypointsByType {
  const distances = calculateDistancesToWaypoints(currentKm, waypoints, trackPoints);

  const typeMapping: Record<string, keyof NextWaypointsByType> = {
    campsite: 'campsite',
    water: 'water',
    'water-tank': 'water',
    town: 'town',
    shelter: 'shelter',
    hut: 'shelter',
  };

  const result: NextWaypointsByType = {};

  for (const wd of distances) {
    const key = typeMapping[wd.waypoint.type];
    if (key && !result[key]) {
      result[key] = wd;
    }
  }

  return result;
}
