/**
 * Day calculator engine for the multi-day trip planner.
 *
 * Pure functions: trail + stops → computed days with distance, elevation,
 * water sources, and hiking time estimates.
 *
 * Shared between the web planner and the mobile app. Parameter types are
 * structural so both platforms' trail/stop shapes are accepted as-is:
 * the web StopData ({ km, waypointName }) and the mobile StopData
 * ({ id, waypointName, waypointType, km, customLocation? }) both satisfy
 * PlanStopInput.
 */

import type { SectionConfig, ComputedDay, PlanTrackPoint, PlanWaypoint } from './plan-types';
import { calculateElevationBetween } from './track-geometry';

/** Trail shape accepted by computeDays (subset of the full Trail interfaces). */
export interface PlanTrail {
  config: { name: string };
  track: {
    points: PlanTrackPoint[];
    totalDistance: number;
  };
  waypoints?: PlanWaypoint[];
}

/** Minimal stop shape accepted by computeDays. */
export interface PlanStopInput {
  /** totalDistance position on trail in km */
  km: number;
  waypointName?: string | null;
  customLocation?: { name: string };
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
 * Insert a stop in km-sorted order. Returns a new array.
 */
export function addStop<T extends { km: number }>(stops: T[], newStop: T): T[] {
  const result = [...stops];
  const idx = result.findIndex(s => s.km > newStop.km);
  if (idx === -1) {
    result.push(newStop);
  } else {
    result.splice(idx, 0, newStop);
  }
  return result;
}

/**
 * Remove a stop by index. Returns a new array.
 */
export function removeStop<T>(stops: T[], index: number): T[] {
  return stops.filter((_, i) => i !== index);
}

/** Resolve a stop's display name. */
function stopDisplayName(stop: PlanStopInput): string {
  return stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
}

/**
 * Compute days from trail data and planned stops.
 *
 * Day 1 starts at trail km 0 (or section start), last day ends at trail total
 * distance (or section end). Each stop boundary creates a day transition.
 * Stops are sorted by km and clamped to the computed range, so out-of-order
 * or out-of-range stops never produce negative day distances.
 *
 * @param trail - Trail data with track points and waypoints
 * @param stops - Planned overnight stops (trail/section start and end are implicit)
 * @param startDate - Optional ISO date string for day 1
 * @param section - Optional section boundaries; when set, scopes computation to the section range
 */
export function computeDays(
  trail: PlanTrail,
  stops: PlanStopInput[],
  startDate?: string | null,
  section?: SectionConfig | null,
): ComputedDay[] {
  const trackPoints = trail.track.points;
  const waypoints = trail.waypoints ?? [];

  const rangeStartKm = section ? section.startKm : 0;
  const rangeEndKm = section ? section.endKm : trail.track.totalDistance;
  const rangeStartName: string = section
    ? section.startName
    : (waypoints[0]?.name ?? (trail.config.name + ' Start'));
  const rangeEndName: string = section
    ? section.endName
    : (waypoints[waypoints.length - 1]?.name ?? (trail.config.name + ' End'));

  interface Boundary {
    name: string;
    km: number;
  }

  // Sort stops by km and clamp to the range bounds
  const sortedStops = [...stops]
    .sort((a, b) => a.km - b.km)
    .filter(s => s.km > rangeStartKm && s.km < rangeEndKm);

  const boundaries: Boundary[] = [
    { name: rangeStartName, km: rangeStartKm },
    ...sortedStops.map(s => ({ name: stopDisplayName(s), km: s.km })),
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

    let date: string | undefined;
    if (startDate) {
      // Use UTC to avoid timezone shifts
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
