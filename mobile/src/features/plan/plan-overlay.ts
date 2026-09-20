/**
 * The plan as the map and the elevation profile need it.
 *
 * Both surfaces draw the same two things — which markers are stops, and where
 * the day boundaries fall — and both have to cross the same km boundary to do
 * it. A `PlanStop` is stored NOBO-absolute so a plan survives a direction flip
 * untouched (`@lib/plan-direction`), while the guide trail is
 * direction-applied: its waypoints' `totalDistance` counts from whichever end
 * the hiker is walking from. Converting in one place is what stops the map and
 * the profile from disagreeing about which hut tonight is.
 *
 * Pure and React-free, so the conversion is testable without a renderer, a
 * canvas, or a native map.
 */

import { findStopIndex } from '@lib/plan-editor';
import { stopsToActive, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import type { PlanDocument } from '@lib/plan-types';

/** The minimum of a waypoint this module needs: the map's and the list's shape both fit. */
export interface OverlayWaypoint {
  id?: string;
  name: string;
  totalDistance?: number;
}

/**
 * Feature ids of the waypoints that are stops of the plan.
 *
 * The id is `waypointFeatureId`'s — the bundled waypoint id, or the
 * `name-index` composite the map falls back to for legacy data without one —
 * because that is the id the marker features carry, and the caller's array
 * order is the same one the collection is built from.
 *
 * Matching goes through the shared editor's `findStopIndex` rather than a bare
 * id lookup, so a stop migrated from the km-keyed `PlanState` (no waypoint id
 * at all) still rings its waypoint.
 */
export function plannedStopFeatureIds(
  plan: PlanDocument | undefined,
  waypoints: readonly OverlayWaypoint[],
  direction: PlanDirection,
  totalKm: number,
): Set<string> {
  const ids = new Set<string>();
  if (!plan || plan.stops.length === 0) return ids;

  waypoints.forEach((wp, i) => {
    const noboKm = toNoboKm(wp.totalDistance ?? 0, direction, totalKm);
    if (findStopIndex(plan, { waypointId: wp.id, km: noboKm }) === -1) return;
    ids.add(wp.id ?? `${wp.name}-${i}`);
  });
  return ids;
}

/**
 * Day-boundary km, in the ACTIVE direction, sorted.
 *
 * Every stop ends a day, so the stop km are the boundaries; the trail's own
 * start and end are implicit and are not ticked (the profile already ends
 * there).
 */
export function plannedStopKms(
  plan: PlanDocument | undefined,
  direction: PlanDirection,
  totalKm: number,
): number[] {
  if (!plan || plan.stops.length === 0) return [];
  return stopsToActive(plan.stops, direction, totalKm)
    .map((stop) => stop.km)
    .sort((a, b) => a - b);
}
