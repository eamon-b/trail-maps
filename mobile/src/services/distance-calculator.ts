/**
 * Trail distances, elevation change, and Naismith ETA from a current km
 * position to the upcoming waypoints of each important type (next water, camp,
 * town/resupply, shelter).
 *
 * Ported from the old app and adapted to Tracknotes' waypoint shape: parameter
 * types are structural (`DistanceWaypoint`, `ElevationPoint`) so the bundled
 * trail JSON's waypoints and track points are accepted without conversion.
 *
 * Direction-awareness is inherited for free: the guide feeds already
 * direction-applied waypoints (mirrored `totalDistance`) and a track whose
 * `dist` runs in the travelled direction, so "upcoming" (`totalDistance >
 * currentKm`) always means ahead of the hiker.
 */

import { calculateElevationBetween, type ElevationPoint } from '@lib/track-geometry';
import { estimateHikingTime } from '@lib/day-calculator';

/** Minimal waypoint shape needed to rank the next-of-type cards. */
export interface DistanceWaypoint {
  id?: string;
  name: string;
  type: string;
  /** Cumulative distance along the trail in km. */
  totalDistance?: number;
}

export interface WaypointDistance<W extends DistanceWaypoint = DistanceWaypoint> {
  waypoint: W;
  /** Trail distance from the current position in km. */
  trailDistanceKm: number;
  /** Elevation gain to this waypoint in metres. */
  elevationGain: number;
  /** Elevation loss to this waypoint in metres. */
  elevationLoss: number;
  /**
   * Naismith walking time from the current position, in minutes
   * (distance / 4 km/h + ascent / 600 m/h + Tranter descent correction).
   */
  etaMinutes: number;
}

/**
 * Format an ETA in minutes: "~50 min" under an hour, "~2 h 10 min" above.
 * Sub-5-minute answers all read "~5 min" — GPS and pace noise make anything
 * finer a lie.
 */
export function formatEtaMinutes(minutes: number): string {
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `~${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
}

export interface NextWaypointsByType<W extends DistanceWaypoint = DistanceWaypoint> {
  campsite?: WaypointDistance<W>;
  water?: WaypointDistance<W>;
  town?: WaypointDistance<W>;
  shelter?: WaypointDistance<W>;
}

/**
 * Trail distances and elevation changes from `currentKm` to every waypoint
 * ahead, ordered as supplied (callers pass distance-sorted waypoints).
 */
export function calculateDistancesToWaypoints<W extends DistanceWaypoint>(
  currentKm: number,
  waypoints: readonly W[],
  trackPoints: readonly ElevationPoint[],
): WaypointDistance<W>[] {
  const upcoming = waypoints.filter((wp) => (wp.totalDistance ?? 0) > currentKm);

  return upcoming.map((wp) => {
    const wpKm = wp.totalDistance ?? 0;
    const distanceKm = wpKm - currentKm;
    const { gain, loss } = calculateElevationBetween(currentKm, wpKm, trackPoints as ElevationPoint[]);

    return {
      waypoint: wp,
      trailDistanceKm: distanceKm,
      elevationGain: gain,
      elevationLoss: loss,
      etaMinutes: estimateHikingTime(distanceKm, gain, loss) * 60,
    };
  });
}

/** Waypoint `type` → the next-of-type bucket it feeds. */
const TYPE_MAPPING: Record<string, keyof NextWaypointsByType> = {
  campsite: 'campsite',
  camp: 'campsite',
  campground: 'campsite',
  water: 'water',
  'water-tank': 'water',
  spring: 'water',
  creek: 'water',
  town: 'town',
  food: 'town',
  resupply: 'town',
  shelter: 'shelter',
  hut: 'shelter',
};

/**
 * The next waypoint of each important type. Accepts pre-computed distances to
 * avoid recalculating when the caller already has them.
 */
export function getNextWaypointsByType<W extends DistanceWaypoint>(
  currentKm: number,
  waypoints: readonly W[],
  trackPoints: readonly ElevationPoint[],
  precomputedDistances?: WaypointDistance<W>[],
): NextWaypointsByType<W> {
  const distances =
    precomputedDistances ?? calculateDistancesToWaypoints(currentKm, waypoints, trackPoints);

  const result: NextWaypointsByType<W> = {};
  for (const wd of distances) {
    const key = TYPE_MAPPING[wd.waypoint.type];
    if (key && !result[key]) {
      result[key] = wd;
    }
  }
  return result;
}
