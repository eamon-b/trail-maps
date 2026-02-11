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
 * Calculate elevation gain and loss between two km positions on the trail.
 */
export function calculateElevationBetween(
  startKm: number,
  endKm: number,
  trackPoints: TrackPoint[],
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

/**
 * Calculate trail distances and elevation changes from current position to upcoming waypoints.
 */
export function calculateDistancesToWaypoints(
  currentKm: number,
  waypoints: TrailWaypoint[],
  trackPoints: TrackPoint[],
): WaypointDistance[] {
  const upcoming = waypoints.filter(wp => (wp.totalDistance ?? 0) > currentKm);

  return upcoming.map(wp => {
    const wpKm = wp.totalDistance ?? 0;
    const { gain, loss } = calculateElevationBetween(currentKm, wpKm, trackPoints);

    return {
      waypoint: wp,
      trailDistanceKm: wpKm - currentKm,
      elevationGain: gain,
      elevationLoss: loss,
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
