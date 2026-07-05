/**
 * Plan direction helpers — the km-space contract for direction-aware planning.
 *
 * Stored plan stops are ALWAYS in NOBO-absolute km (the trail as built, km 0
 * at the data's start). Runtime rendering happens entirely in "active" km —
 * the km of whichever direction the user is currently viewing. These helpers
 * are the only sanctioned conversion between the two spaces:
 *
 * - storage -> runtime: `stopsToActive` / `toActiveKm` (when loading stops
 *   into renderers/calculators)
 * - runtime -> storage: `toNoboKm` (when writing a stop the user picked in
 *   the active direction)
 *
 * For NOBO both conversions are the identity; for SOBO km mirrors about the
 * trail total. Values are compared with `KM_EPSILON`, which only needs to
 * absorb floating-point noise from the mirror (see its doc comment).
 *
 * Shared by the web plan viewer and (in future) the mobile app via `@lib`.
 */

/**
 * Hiking direction. 'NOBO' = the trail as stored in the data (km 0 at the
 * data's start), 'SOBO' = reversed. Uppercase to match the mobile
 * `plans.direction` SQLite column. Display labels come from the trail
 * config's `direction: { default, reversed }` (e.g. Westbound/Eastbound);
 * these values are the storage/runtime enum, not UI text.
 */
export type PlanDirection = 'NOBO' | 'SOBO';

/** Trail-config display labels for the two hiking directions. */
export interface DirectionLabels {
  /** Label for the trail as stored (NOBO), e.g. "Westbound". */
  default: string;
  /** Label for the reversed direction (SOBO), e.g. "Eastbound". */
  reversed: string;
}

/**
 * Display label for a hiking direction: the trail config's labels when
 * configured, otherwise the caller's fallbacks (viewers use different
 * fallback strings, e.g. 'NOBO'/'SOBO' vs 'Start → End'/'End → Start').
 */
export function getDirectionLabel(
  config: DirectionLabels | undefined,
  direction: PlanDirection,
  fallbacks: DirectionLabels,
): string {
  const labels = config ?? fallbacks;
  return direction === 'NOBO' ? labels.default : labels.reversed;
}

/**
 * Tolerance (km) for matching km positions across direction conversions.
 *
 * Stops are stored FROM the already-rounded build-time waypoint km, so both
 * sides of every comparison come from the same values; the only error to
 * absorb is floating-point noise from the SOBO mirror (~1e-14 km). 0.01
 * preserves the pre-existing stop-matching semantics: real neighbouring
 * waypoints sit as little as 10-50 m apart (e.g. Whites River Hut at
 * km 500.04 vs Munyang River water at km 500.07) and must stay distinct,
 * while co-located waypoints at identical km still match.
 */
export const KM_EPSILON = 0.01;

/** Convert a stored NOBO-absolute km to the active direction's km. */
export function toActiveKm(noboKm: number, direction: PlanDirection, totalDistance: number): number {
  return direction === 'SOBO' ? totalDistance - noboKm : noboKm;
}

/** Convert an active-direction km back to storage (NOBO-absolute) km. */
export function toNoboKm(activeKm: number, direction: PlanDirection, totalDistance: number): number {
  // The mirror is its own inverse, so this is the same arithmetic as
  // toActiveKm — kept as a separate function so call sites document which
  // km-space they are converting from.
  return direction === 'SOBO' ? totalDistance - activeKm : activeKm;
}

/**
 * Map stored (NOBO-absolute, km-ascending) stops into the active direction
 * and re-sort ascending so day computation walks them in hiking order.
 */
export function stopsToActive<S extends { km: number }>(
  stops: S[],
  direction: PlanDirection,
  totalDistance: number,
): S[] {
  return stops
    .map(stop => ({ ...stop, km: toActiveKm(stop.km, direction, totalDistance) }))
    .sort((a, b) => a.km - b.km);
}
