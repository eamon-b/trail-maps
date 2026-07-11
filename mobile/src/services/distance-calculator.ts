import { calculateElevationBetween } from '@lib/track-geometry';
import { estimateHikingTime } from '@lib/day-calculator';
import type { TrackPoint, TrailWaypoint } from '../lib/trail-utils';

export interface WaypointDistance {
  waypoint: TrailWaypoint;
  /** Trail distance from current position in km */
  trailDistanceKm: number;
  /** Elevation gain to this waypoint in meters */
  elevationGain: number;
  /** Elevation loss to this waypoint in meters */
  elevationLoss: number;
  /**
   * Naismith walking time from the current position, in minutes
   * (distance/4 km/h + ascent/600 m/h + Tranter descent correction —
   * the same estimate measure-service uses).
   */
  etaMinutes: number;
}

/**
 * Format an ETA in minutes for the next-waypoint cards: "~50 min" under an
 * hour, "~2 h 10 min" above. Sub-5-minute answers all read "~5 min" — GPS
 * and pace noise make anything finer a lie.
 */
export function formatEtaMinutes(minutes: number): string {
  if (minutes < 60) {
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    return `~${rounded} min`;
  }
  const h = Math.floor(minutes / 60);
  const m = Math.round((minutes % 60) / 5) * 5;
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
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
    const distanceKm = wpKm - currentKm;
    const { gain, loss } = calculateElevationBetween(currentKm, wpKm, trackPoints);

    return {
      waypoint: wp,
      trailDistanceKm: distanceKm,
      elevationGain: gain,
      elevationLoss: loss,
      etaMinutes: estimateHikingTime(distanceKm, gain, loss) * 60,
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
