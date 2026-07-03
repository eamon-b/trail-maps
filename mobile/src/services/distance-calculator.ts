import { calculateElevationBetween } from '@lib/track-geometry';
import type { TrackPoint, TrailWaypoint } from '../lib/trail-utils';

export { calculateElevationBetween };

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
 * Accepts pre-computed distances to avoid recalculating.
 */
export function getNextWaypointsByType(
  currentKm: number,
  waypoints: TrailWaypoint[],
  trackPoints: TrackPoint[],
  precomputedDistances?: WaypointDistance[],
): NextWaypointsByType {
  const distances = precomputedDistances ?? calculateDistancesToWaypoints(currentKm, waypoints, trackPoints);

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
