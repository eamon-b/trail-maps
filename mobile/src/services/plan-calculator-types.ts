/**
 * Types for the multi-day campsite planner.
 *
 * StopData is persisted as JSON in the plans table (stops_json column).
 * ComputedDay is derived at runtime from stops + trail data.
 */

/** A planned overnight stop, serialized into stops_json. Ordered by km. */
export interface StopData {
  id: string;
  waypointName: string | null;
  waypointType: string;
  km: number;
  customLocation?: {
    lat: number;
    lon: number;
    name: string;
  };
  notes?: string;
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
  date?: string;
  startName: string;
  endName: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours: number;
  waterSources: number;
  warnings: string[];
}

