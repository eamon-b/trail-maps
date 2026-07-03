/**
 * Types for the multi-day campsite planner.
 *
 * StopData is persisted as JSON in the plans table (stops_json column).
 * SectionConfig and ComputedDay are shared with the web planner and live in
 * src/lib/plan-types.ts (resolved via the @lib alias / Metro watchFolders).
 */

export type { SectionConfig, ComputedDay } from '@lib/plan-types';

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
