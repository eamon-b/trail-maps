import type { Trail, TrailWaypoint } from '../lib/trail-utils';
import { calculateElevationBetween } from './distance-calculator';
import { estimateHikingTime, countWaterSources } from '@lib/day-calculator';

export interface MeasureResult {
  startKm: number;
  endKm: number;
  startName?: string;
  endName?: string;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  netElevationM: number;
  estimatedHours: number;
  waypointsBetween: TrailWaypoint[];
  waterSourceCount: number;
}

/**
 * Measure between two points on a trail.
 * Returns distance, elevation stats, estimated time, waypoints between, and water source count.
 */
export function measureBetweenPoints(trail: Trail, startKm: number, endKm: number): MeasureResult {
  // Ensure startKm < endKm
  const lo = Math.min(startKm, endKm);
  const hi = Math.max(startKm, endKm);

  const distanceKm = Math.round((hi - lo) * 10) / 10;
  const { gain, loss } = calculateElevationBetween(lo, hi, trail.track.points);
  const hours = estimateHikingTime(distanceKm, gain, loss);
  const waterSourceCount = countWaterSources(lo, hi, trail.waypoints);

  // Find waypoints between the two points
  const waypointsBetween = trail.waypoints.filter(wp => {
    const km = wp.totalDistance ?? 0;
    return km > lo && km < hi;
  });

  // Find nearest waypoint names for start/end (within 2km)
  const startWp = trail.waypoints.reduce<TrailWaypoint | null>((best, wp) => {
    const km = wp.totalDistance ?? 0;
    const dist = Math.abs(km - lo);
    if (dist >= 2) return best;
    if (!best) return wp;
    return dist < Math.abs((best.totalDistance ?? 0) - lo) ? wp : best;
  }, null);

  const endWp = trail.waypoints.reduce<TrailWaypoint | null>((best, wp) => {
    const km = wp.totalDistance ?? 0;
    const dist = Math.abs(km - hi);
    if (dist >= 2) return best;
    if (!best) return wp;
    return dist < Math.abs((best.totalDistance ?? 0) - hi) ? wp : best;
  }, null);

  return {
    startKm: lo,
    endKm: hi,
    startName: startWp?.name,
    endName: endWp?.name,
    distanceKm,
    ascentM: gain,
    descentM: loss,
    netElevationM: gain - loss,
    estimatedHours: hours,
    waypointsBetween,
    waterSourceCount,
  };
}
