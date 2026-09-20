/**
 * Shared planning types used by the web trip planner and the mobile app.
 *
 * These interfaces are designed to be JSON-serialisable so that plan state
 * can be stored in localStorage / SQLite and later encoded in URL params or
 * QR codes.
 */

import type { PlanDirection } from './plan-direction';
import type { WaypointAccess } from './types';

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
  /**
   * Rest days taken at this day's end stop: `nights - 1` of that stop, 0 at
   * the trail end. A rest day is not a day of its own; the next walking
   * day's `date` is pushed back by this many days.
   */
  restDays?: number;
}

/**
 * One overnight stop of a `PlanDocument`. Keyed by waypoint id when the trail
 * has one; `km` is the display position always and the key when the id is
 * absent (a plan migrated from a km-only `PlanState` that matched nothing).
 * `km` is NOBO-absolute — see `plan-direction.ts` for the km-space contract.
 */
export interface PlanStop {
  /** Registry id (`data/waypoint-ids.json`) or `uw_…` for an imported trail. */
  waypointId?: string;
  km: number;
  name: string;
  /** Nights spent here, >= 1. Two nights = one rest day. */
  nights: number;
  /** Free text, <= 500 chars after trimming. */
  note?: string;
  booked?: boolean;
}

/** Limits enforced on a `PlanDocument` by the editor, the web page and the server alike. */
export const PLAN_LIMITS = {
  nameMax: 80,
  noteMax: 500,
  stopsMax: 500,
  nightsMax: 14,
  /** Serialised JSON byte ceiling. */
  documentBytes: 64 * 1024,
} as const;

/**
 * The plan document: one per trail per user. It is the wire shape
 * (`PUT /v1/plans/:id`), the mobile `plans.document_json` column, the web
 * `localStorage` value and the shared-plan payload. Supersedes `PlanState`,
 * which is kept only for the one-off web migration.
 */
export interface PlanDocument {
  /** Client-minted uuid v4; the server's idempotency key, as for comments. */
  id: string;
  trailId: string;
  name: string;
  direction: PlanDirection;
  /** ISO date (`YYYY-MM-DD`) or null. */
  startDate: string | null;
  /** Sorted by km ascending; trail start and end are implicit. */
  stops: PlanStop[];
  /** Ticked resupply options, as waypoint ids — unchanged from `PlanState`. */
  resupplyStops?: string[];
  /** Server clock on the copy that last came from or went to the server; the client's own clock before that. */
  updatedAt: string;
  version: 1;
}

/**
 * Persisted plan state (JSON-serialisable).
 *
 * LEGACY: the web page saved this shape under `trail-plan-<trailId>` until
 * the day planner landed. New code reads and writes `PlanDocument`; this
 * type exists so `migratePlanState` in `plan-editor.ts` can read old saves.
 */
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
