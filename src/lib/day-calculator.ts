/**
 * Day calculator for the web trip planner.
 *
 * Pure functions: trail + stops → computed days with distance, elevation,
 * water sources, and hiking time estimates.
 *
 * Ported from mobile/src/services/day-calculator.ts with adjustments for
 * the web's TrackPoint/Waypoint shapes.
 */

import type { StopData, ComputedDay, PlanTrackPoint, PlanWaypoint } from './plan-types';

/** Trail shape accepted by computeDays (subset of the full Trail interface). */
export interface PlanTrail {
  config: { name: string };
  track: {
    points: PlanTrackPoint[];
    totalDistance: number;
  };
  waypoints?: PlanWaypoint[];
}

/**
 * Find the index of the track point nearest to a given km distance.
 * Uses binary search for efficiency on sorted distance arrays.
 */
function findNearestByDistance(points: PlanTrackPoint[], targetKm: number): number {
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

  // Check if the previous point is actually closer
  if (lo > 0 && Math.abs(points[lo - 1].dist - targetKm) < Math.abs(points[lo].dist - targetKm)) {
    return lo - 1;
  }
  return lo;
}

/**
 * Calculate elevation gain and loss between two km positions on the trail.
 */
export function calculateElevationBetween(
  startKm: number,
  endKm: number,
  trackPoints: PlanTrackPoint[],
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
 * Estimate hiking time using Naismith's rule with Tranter's correction for descent:
 *   time = distance/4 + ascent/600 + max(0, (descent-300)/600)
 * Returns hours rounded to 1 decimal.
 */
export function estimateHikingTime(distanceKm: number, ascentM: number, descentM: number): number {
  const hours = distanceKm / 4 + ascentM / 600 + Math.max(0, (descentM - 300) / 600);
  return Math.round(hours * 10) / 10;
}

/**
 * Count water sources between two km positions on the trail.
 * Includes waypoints of type 'water' and 'water-tank'.
 */
export function countWaterSources(
  startKm: number,
  endKm: number,
  waypoints: PlanWaypoint[],
): number {
  return waypoints.filter(wp => {
    const km = wp.totalDistance ?? 0;
    const isWater = wp.type === 'water' || wp.type === 'water-tank';
    return isWater && km > startKm && km <= endKm;
  }).length;
}

/**
 * Compute days from trail data and planned stops.
 *
 * Day 1 starts at trail km 0, last day ends at trail total distance.
 * Each stop boundary creates a day transition.
 *
 * @param trail - Trail data with track points and waypoints
 * @param stops - Planned overnight stops, sorted by km (trail start/end are implicit)
 * @param startDate - Optional ISO date string for day 1
 */
export function computeDays(
  trail: PlanTrail,
  stops: StopData[],
  startDate?: string | null,
): ComputedDay[] {
  const trackPoints = trail.track.points;
  const waypoints = trail.waypoints ?? [];

  const rangeStartKm = 0;
  const rangeEndKm = trail.track.totalDistance;
  const rangeStartName: string =
    waypoints[0]?.name ?? (trail.config.name + ' Start');
  const rangeEndName: string =
    waypoints[waypoints.length - 1]?.name ?? (trail.config.name + ' End');

  interface Boundary {
    name: string;
    km: number;
  }

  const boundaries: Boundary[] = [
    { name: rangeStartName, km: rangeStartKm },
    ...stops.map(s => ({ name: s.waypointName ?? 'Stop', km: s.km })),
    { name: rangeEndName, km: rangeEndKm },
  ];

  const days: ComputedDay[] = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const dayNumber = i + 1;

    const distanceKm = Math.round((end.km - start.km) * 10) / 10;
    const { gain, loss } = calculateElevationBetween(start.km, end.km, trackPoints);
    const hours = estimateHikingTime(distanceKm, gain, loss);
    const water = countWaterSources(start.km, end.km, waypoints);

    let date: string | null = null;
    if (startDate) {
      const d = new Date(startDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      date = d.toISOString().slice(0, 10);
    }

    days.push({
      dayNumber,
      date,
      startName: start.name,
      endName: end.name,
      startKm: start.km,
      endKm: end.km,
      distanceKm,
      ascentM: gain,
      descentM: loss,
      estimatedHours: hours,
      waterSources: water,
    });
  }

  return days;
}
