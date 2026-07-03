/**
 * Shared planning types for the web trip planner.
 *
 * These interfaces are designed to be JSON-serialisable so that plan state
 * can be stored in localStorage and later encoded in URL params or QR codes.
 */

/** A planned overnight stop. Ordered by km. */
export interface StopData {
  km: number;              // totalDistance position on trail
  waypointName: string;    // display name
}

/** Runtime-computed day segment between two stops (or trail start/end). */
export interface ComputedDay {
  dayNumber: number;
  date: string | null;     // ISO date if startDate set, otherwise null
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
export interface PlanWaypoint {
  name?: string;
  type?: string;
  lat?: number;
  lon?: number;
  totalDistance?: number; // cumulative km along trail
  description?: string;
}
