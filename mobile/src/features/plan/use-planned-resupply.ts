/**
 * The one read of "which waypoints are planned resupply stops".
 *
 * Every surface that highlights a plan — map markers, elevation ticks, the list
 * pane's pill and chip, the waypoint detail banner, the hike distance strip —
 * calls this hook and nothing else, so "planned" cannot come to mean different
 * things on different screens. `null` means no plan has been made, which every
 * caller must read as "nothing is planned", never "everything is".
 *
 * The turn-off resolution (a ticked off-route town also plans the `-access`
 * point on the route, because that is the km the food has to reach) lives in
 * `@lib/resupply-plan`, so no surface here learns what an option group is.
 */

import { useMemo } from 'react';
import {
  allResupplyOptionIds,
  listResupplyOptions,
  plannedResupplyIds,
  type ResupplyCandidateWaypoint,
} from '@lib/resupply-plan';
import { selectResupplyStopIds, usePlanInputsStore } from './plan-inputs-store';

/** The only thing this module needs from a trail: its waypoints. */
export interface PlannedResupplyTrail {
  waypoints?: readonly ResupplyCandidateWaypoint[];
}

/**
 * Pure half of the hook: resolve a stored selection against a trail's options.
 * Direction does not matter — a flip mirrors km, not ids.
 */
export function plannedIdsFor(
  trail: PlannedResupplyTrail,
  selected: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  return plannedResupplyIds(listResupplyOptions(trail.waypoints), selected);
}

/**
 * Toggle one id in a stored selection, producing the list to persist.
 *
 * With no selection yet (`current` undefined), the first tap makes a plan with
 * every *other* option still ticked — tapping "Plan resupply here" on one town
 * should not silently unplan the rest. The result keeps `allIds`' trail order
 * and is pruned to ids the trail still offers.
 */
export function toggleResupplyStop(
  current: string[] | undefined,
  allIds: string[],
  id: string,
): string[] {
  const base = new Set(current ?? allIds);
  if (base.has(id)) base.delete(id);
  else base.add(id);
  return allIds.filter((candidate) => base.has(candidate));
}

/** Every resupply option id the trail offers, in trail order. */
export function resupplyOptionIdsFor(trail: PlannedResupplyTrail): string[] {
  return allResupplyOptionIds(listResupplyOptions(trail.waypoints));
}

/**
 * The trail's planned resupply waypoint ids, reactive to the stored selection.
 * `trailId` and `trail` are separate because the guide's trail is the
 * direction-applied one while the selection is keyed by the plain trail id.
 */
export function usePlannedResupplyIds(
  trailId: string,
  trail: PlannedResupplyTrail,
): ReadonlySet<string> | null {
  const selected = usePlanInputsStore(selectResupplyStopIds(trailId));
  // Grouping the whole CDT's 80 options is not free; key it on the trail alone
  // so ticking a box does not regroup.
  const groups = useMemo(() => listResupplyOptions(trail.waypoints), [trail]);
  return useMemo(() => plannedResupplyIds(groups, selected), [groups, selected]);
}
