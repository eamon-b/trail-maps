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
 * trail total. Values are compared with `KM_EPSILON` so 2-decimal rounding of
 * stored km never breaks stop matching.
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

/**
 * Tolerance (km) for matching km positions across direction conversions.
 * Big enough to absorb 2-decimal rounding of stored km (max error 0.005 per
 * value, 0.01 after a mirror), small enough to never conflate two waypoints.
 */
export const KM_EPSILON = 0.05;

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
