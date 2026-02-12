/**
 * Day calculator engine for the multi-day campsite planner.
 *
 * Pure functions: trail + stops → computed days with distance, elevation,
 * water sources, and hiking time estimates.
 */

import type { Trail, TrailWaypoint } from '../lib/trail-utils';
import { calculateElevationBetween } from './distance-calculator';
import {
  type StopData,
  type SectionConfig,
  type ComputedDay,
} from './plan-calculator-types';

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
  waypoints: TrailWaypoint[],
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
export function addStop(stops: StopData[], newStop: StopData): StopData[] {
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
export function removeStop(stops: StopData[], index: number): StopData[] {
  return stops.filter((_, i) => i !== index);
}

/** Resolve a stop's display name. */
function stopDisplayName(stop: StopData): string {
  return stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
}

/**
 * Compute days from trail data and planned stops.
 *
 * Day 1 starts at trail km 0 (or section start), last day ends at trail total distance (or section end).
 * Each stop boundary creates a day transition.
 *
 * @param trail - Full trail data with track points and waypoints
 * @param stops - Planned overnight stops, sorted by km
 * @param startDate - Optional ISO date string for day 1
 * @param section - Optional section boundaries; when set, scopes computation to the section range
 */
export function computeDays(
  trail: Trail,
  stops: StopData[],
  startDate?: string | null,
  section?: SectionConfig | null,
): ComputedDay[] {
  const trackPoints = trail.track.points;
  const waypoints = trail.waypoints;

  // Determine boundaries
  const rangeStartKm = section ? section.startKm : 0;
  const rangeEndKm = section ? section.endKm : trail.track.totalDistance;
  const rangeStartName = section
    ? section.startName
    : (waypoints.length > 0 ? waypoints[0].name : trail.config.name + ' Start');
  const rangeEndName = section
    ? section.endName
    : (waypoints.length > 0 ? waypoints[waypoints.length - 1].name : trail.config.name + ' End');

  // Filter stops to section range
  const sectionStops = section
    ? stops.filter(s => s.km > rangeStartKm && s.km < rangeEndKm)
    : stops;

  interface Boundary {
    name: string;
    km: number;
  }

  const boundaries: Boundary[] = [
    { name: rangeStartName, km: rangeStartKm },
    ...sectionStops.map(s => ({ name: stopDisplayName(s), km: s.km })),
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
