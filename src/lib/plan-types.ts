/**
 * Shared planning types used by the web trip planner and the mobile app.
 *
 * These interfaces are designed to be JSON-serialisable so that plan state
 * can be stored in localStorage / SQLite and later encoded in URL params or
 * QR codes.
 */

import type { PlanDirection } from './plan-direction';
import type { WaypointAccess } from './types';

/** Pace preset. Maps to a flat-ground walking speed (km/h). */
export type Pace = 'slow' | 'average' | 'fast';

/**
 * Flat-ground base walking speed (km/h) per pace preset. This is the Naismith
 * base speed threaded into `estimateHikingTime` / the time index: Slow walks the
 * same terrain-aware formula at 3 km/h flat-speed, Fast at 5. The daily target is
 * expressed in *hours* (used raw), so pace shortens/lengthens the km a day covers
 * without inflating its hours. 'average' == 4 preserves the identity "flat day
 * hours ≈ your daily hours" (8 h flat ≈ 32 km).
 *
 * Lives here rather than beside either UI so the web plan page and the phone's
 * plan screen cannot drift apart on what "Average" means.
 */
export const PACE_KMH: Record<Pace, number> = {
  slow: 3,
  average: 4,
  fast: 5,
};

/** Whether a stored value is one of the three presets — a persistence guard. */
export function isPace(value: unknown): value is Pace {
  return value === 'slow' || value === 'average' || value === 'fast';
}

/** A planned overnight stop for the web planner. Ordered by km. */
export interface StopData {
  km: number;              // totalDistance position on trail
  waypointName: string;    // display name
}

/** Configuration for section hiking — start/end boundaries. */
export interface SectionConfig {
  startKm: number;
  endKm: number;
  startName: string;
  endName: string;
}

/** Runtime-computed day segment between two stops (or trail start/end). */
export interface ComputedDay {
  dayNumber: number;
  date?: string;           // ISO date if startDate set, otherwise undefined
  startName: string;
  endName: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours: number;
  waterSources: number;
}

/** Persisted plan state (JSON-serialisable). */
export interface PlanState {
  name: string;
  startDate: string | null;   // ISO date string or null
  stops: StopData[];           // sorted by km, excludes trail start/end (implicit)
  /**
   * Hiking direction. Absent = 'NOBO' (plans saved before the direction
   * toggle existed). Stop km stay NOBO-absolute regardless of direction —
   * see src/lib/plan-direction.ts for the km-space contract.
   */
  direction?: PlanDirection;
  /**
   * The resupply options the hiker has ticked, as waypoint ids. Absent means
   * "nothing chosen yet", which resolves to every option — see
   * `resolveResupplyStops`. Ids are direction-agnostic, so a saved selection
   * survives a direction flip untouched.
   */
  resupplyStops?: string[];
  /**
   * The hiker's pace preset. Absent on a plan saved before the input existed =
   * 'average'. That default is the *initial value of an input they can see and
   * change*, not a constant the page decides for them.
   */
  pace?: Pace;
  /**
   * Walking hours per day. Absent on a plan saved before the input existed = 8,
   * on the same footing as `pace`.
   */
  dailyHours?: number;
}

/** Gap between consecutive resupply points. */
export interface ResupplyGap {
  fromName: string;
  toName: string;
  fromKm: number;
  toKm: number;
  distanceKm: number;
  estimatedDays: number;
  isLong: boolean;         // gap > longThresholdDays at pace
}

/** Gap between consecutive water sources. */
export interface WaterGap {
  fromName: string;
  toName: string;
  fromKm: number;
  toKm: number;
  distanceKm: number;
  isDryStretch: boolean;   // >= dryStretchThreshold km
}

/** Minimal track point shape required by plan calculators. */
export interface PlanTrackPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number; // cumulative km along trail
}

/** Minimal waypoint shape required by plan calculators. */
export interface PlanWaypoint extends WaypointAccess {
  /** Stable waypoint id, when the caller has one — a resupply selection is a list of these. */
  id?: string;
  name?: string;
  type?: string;
  lat?: number;
  lon?: number;
  totalDistance?: number; // cumulative km along trail
  description?: string;
}
