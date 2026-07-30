/**
 * Section stepper options — pure helper.
 *
 * `waypointOptions(trail)` spans only the km of real waypoints, which almost
 * never reach the trail's true termini. On the AAWT the first waypoint sits at
 * 13.2 km and the last at 680.1 km of a 688.3 km track, so a section built
 * straight from waypointOptions silently drops ~21 km of trail end, reports the
 * wrong section distance, and leaves the steppers unable to reach either
 * terminus. Worse, which end is dropped flips with direction.
 *
 * `sectionOptions` fixes that by bracketing the waypoint list with SYNTHETIC
 * boundary options at the true termini: a km-0 "Trail start" when the first
 * waypoint falls short of the start, and a km-`totalDistance` "Trail end" when
 * the last waypoint falls short of the end. The default section (first → last
 * of this list) is then always the whole track, 0 → totalDistance, and every
 * terminus is reachable.
 *
 * Direction: the trail handed in is already direction-applied, so reversing the
 * guide flips which real waypoint is nearest each terminus. The synthetics are
 * therefore decided fresh for the current direction; km 0 and km totalDistance
 * always mean "this trail's current start / end", so a flip re-brackets
 * correctly rather than mis-restoring a stale boundary.
 */

import { waypointOptions, type WaypointOption } from './plan-adapters';
import type { TrailJson } from '../../services/trail-assets';

/**
 * How close a terminal waypoint must be to a trail end to count as "already
 * there" — within this, no synthetic boundary is added (e.g. Cape to Cape,
 * whose termini ARE waypoints at km 0 and the full distance).
 */
export const TERMINUS_EPSILON_KM = 0.05;

/**
 * The trail's waypoints as ordered stepper options, bracketed by synthetic
 * "Trail start" / "Trail end" options whenever the outermost waypoints fall
 * short of the true termini. See the module header for why.
 */
export function sectionOptions(trail: TrailJson): WaypointOption[] {
  const result = waypointOptions(trail);
  const total = trail.track.totalDistance;

  const first = result[0];
  if (!first || first.km > TERMINUS_EPSILON_KM) {
    result.unshift({ id: 'section-start', name: 'Trail start', km: 0, type: 'trailhead' });
  }

  // Re-read the tail AFTER any unshift: with real waypoints present this is the
  // last real waypoint; with none it is the just-added synthetic start.
  const last = result[result.length - 1];
  if (!last || last.km < total - TERMINUS_EPSILON_KM) {
    result.push({ id: 'section-end', name: 'Trail end', km: total, type: 'trailhead' });
  }

  return result;
}
