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
import { calculateElevationBetween, findNearestByDistance } from './track-geometry';
import type { ElevationPoint } from './track-geometry';

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
 * Estimate hiking time using Naismith's rule with Tranter's correction for descent
 * (unrounded). This is the raw internal variant used by the day splitter and the
 * time index, so boundary search does not staircase on the public 0.1 h rounding.
 *
 *   time = distance/baseKmh + ascent/600 + max(0, (descent-300)/600)
 *
 * The descent term's 300 m allowance is *per call* — it is a per-day allowance, so
 * callers must pass whole-day (whole-segment) ascent/descent, never per-point sums.
 *
 * @param baseKmh - flat-ground base speed (pace preset). Default 4 keeps every
 *   existing caller byte-identical.
 */
export function estimateHikingHoursRaw(
  distanceKm: number,
  ascentM: number,
  descentM: number,
  baseKmh = 4,
): number {
  return distanceKm / baseKmh + ascentM / 600 + Math.max(0, (descentM - 300) / 600);
}

/**
 * Estimate hiking time using Naismith's rule with Tranter's correction for descent:
 *   time = distance/baseKmh + ascent/600 + max(0, (descent-300)/600)
 * Returns hours rounded to 1 decimal.
 *
 * @param baseKmh - flat-ground base speed (pace preset). Default 4 preserves the
 *   original 4 km/h behavior for every existing caller.
 */
export function estimateHikingTime(
  distanceKm: number,
  ascentM: number,
  descentM: number,
  baseKmh = 4,
): number {
  const hours = estimateHikingHoursRaw(distanceKm, ascentM, descentM, baseKmh);
  return Math.round(hours * 10) / 10;
}

/**
 * Prefix-sum time index for O(log n) Naismith segment queries.
 *
 * Holds cumulative ascent/descent aligned to a distance-sorted track so that the
 * ascent/descent over any [fromKm, toKm] range can be recovered as a difference of
 * two prefix entries — reproducing exactly what `calculateElevationBetween` computes
 * (nearest-point snapping at each endpoint, no fractional-km interpolation, gain/loss
 * rounded to whole metres per query).
 */
export interface TimeIndex {
  /** The distance-sorted points the index was built from (used for nearest lookup). */
  points: ElevationPoint[];
  /** ascent[i] = cumulative positive elevation change from point 0 to point i. */
  ascent: number[];
  /** descent[i] = cumulative absolute negative elevation change from point 0 to point i. */
  descent: number[];
}

/**
 * Build a prefix-sum time index from a distance-sorted track.
 *
 * Cumulative ascent/descent are accumulated per point-to-point step exactly as
 * `calculateElevationBetween` walks the track (unrounded internally; each *query*
 * rounds its own gain/loss so results match the point-walk to the metre).
 */
export function buildTimeIndex(points: ElevationPoint[]): TimeIndex {
  const n = points.length;
  const ascent = new Array<number>(n);
  const descent = new Array<number>(n);
  if (n > 0) {
    ascent[0] = 0;
    descent[0] = 0;
    for (let i = 1; i < n; i++) {
      const diff = points[i].ele - points[i - 1].ele;
      ascent[i] = ascent[i - 1] + (diff > 0 ? diff : 0);
      descent[i] = descent[i - 1] + (diff < 0 ? -diff : 0);
    }
  }
  return { points, ascent, descent };
}

/**
 * Raw Naismith hours over [fromKm, toKm] using the prefix index.
 *
 * Semantics match `estimateHikingHoursRaw(toKm - fromKm, ...calculateElevationBetween(
 * fromKm, toKm, points))` to floating tolerance: endpoints snap to their nearest
 * points, ascent/descent come from the prefix difference over [min, max] index
 * (rounded to whole metres), and the distance term is the caller's km span so the
 * whole-day descent allowance is applied once per query (day-scoped).
 */
export function hoursBetweenIndexed(
  index: TimeIndex,
  fromKm: number,
  toKm: number,
  baseKmh = 4,
): number {
  const { points, ascent, descent } = index;
  if (points.length === 0) return 0;
  const startIdx = findNearestByDistance(points, fromKm);
  const endIdx = findNearestByDistance(points, toKm);
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  const gain = Math.round(ascent[hi] - ascent[lo]);
  const loss = Math.round(descent[hi] - descent[lo]);
  return estimateHikingHoursRaw(Math.abs(toKm - fromKm), gain, loss, baseKmh);
}

/**
 * The km at which cumulative raw hours from `fromKm` reaches `targetHours`.
 *
 * Time is always measured over the whole [fromKm, x] segment (via
 * `hoursBetweenIndexed`), so `fromKm` is treated as the day start and the descent
 * allowance stays day-scoped. `hoursBetweenIndexed(fromKm, ·)` is monotonically
 * non-decreasing in x, so this is a monotonic bisection with a final linear
 * interpolation across the converged bracket. The result is clamped to the track end.
 */
export function kmAtHours(
  index: TimeIndex,
  fromKm: number,
  targetHours: number,
  baseKmh = 4,
): number {
  const { points } = index;
  if (points.length === 0) return fromKm;
  const lastKm = points[points.length - 1].dist;
  if (targetHours <= 0) return fromKm;
  if (fromKm >= lastKm) return lastKm;

  const totalHours = hoursBetweenIndexed(index, fromKm, lastKm, baseKmh);
  if (targetHours >= totalHours) return lastKm;

  let lo = fromKm;
  let hi = lastKm;
  let loHours = 0; // hoursBetweenIndexed(fromKm, fromKm) === 0
  let hiHours = totalHours;
  // Bisection: converge the bracket, then linearly interpolate within it. The
  // hours function is piecewise-linear in x (nearest-point snapping holds ascent/
  // descent constant between point midpoints), so interpolation is exact there.
  for (let iter = 0; iter < 60 && hi - lo > 1e-7; iter++) {
    const mid = (lo + hi) / 2;
    const midHours = hoursBetweenIndexed(index, fromKm, mid, baseKmh);
    if (midHours < targetHours) {
      lo = mid;
      loHours = midHours;
    } else {
      hi = mid;
      hiHours = midHours;
    }
  }
  const span = hiHours - loHours;
  if (span <= 0) return lo;
  return lo + ((targetHours - loHours) / span) * (hi - lo);
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
 * @param baseKmh - Naismith flat-ground base speed (pace preset). Default 4 keeps
 *   every existing caller source- and behavior-compatible.
 */
export function computeDays(
  trail: PlanTrail,
  stops: PlanStopInput[],
  startDate?: string | null,
  section?: SectionConfig | null,
  baseKmh = 4,
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
    const hours = estimateHikingTime(distanceKm, gain, loss, baseKmh);
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
