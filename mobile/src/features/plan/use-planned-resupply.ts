/**
 * The one read of "which waypoints are planned resupply stops".
 *
 * Every surface that highlights a plan — map markers, elevation ticks, the list
 * pane's pill and chip, the waypoint detail banner, the hike distance strip —
 * calls this hook and nothing else, so "planned" cannot come to mean different
 * things on different screens. `null` means no plan has been made, which every
 * caller must read as "nothing is planned", never "everything is".
 *
 * The turn-off resolution (a ticked place also plans the point on the route you
 * leave at to reach it, because that is the km the food has to reach — and only
 * that point, never another town on the same hitch) lives in
 * `@lib/resupply-plan`, so no surface here learns what an option group is.
 *
 * `useWaypointResupplyPlan` at the foot of the file is the detail screen's
 * version of the same read: it answers what to show AND what a tap should do,
 * so those two can never disagree.
 */

import { useCallback, useMemo } from 'react';
import {
  allResupplyOptionIds,
  listResupplyOptions,
  plannedResupplyIds,
  type ResupplyCandidateWaypoint,
  type ResupplyOptionGroup,
} from '@lib/resupply-plan';
import { selectPrefs, selectResupplyStopIds, usePlanInputsStore } from './plan-inputs-store';

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
 * Tick or untick one id in a stored selection, producing the list to persist.
 *
 * With no selection yet (`current` undefined) the baseline is every option, the
 * same default the picker shows and the legs card computes from — so the first
 * tap makes that default explicit and changes this one id in it, rather than
 * silently unplanning the rest.
 *
 * The result keeps `allIds`' trail order and is pruned to ids the trail still
 * offers. Callers say which way they want the id to end up, never "flip the
 * stored value": the screens show the *derived* planned state, and a flip of
 * the stored one can disagree with what the hiker is looking at.
 */
export function setResupplyStopSelected(
  current: string[] | undefined,
  allIds: string[],
  id: string,
  selected: boolean,
): string[] {
  const base = new Set(current ?? allIds);
  if (selected) base.add(id);
  else base.delete(id);
  return allIds.filter((candidate) => base.has(candidate));
}

/**
 * Flip one id in a stored selection — for the picker, whose checkboxes show the
 * stored value itself (with "nothing chosen" drawn as everything ticked).
 */
export function toggleResupplyStop(
  current: string[] | undefined,
  allIds: string[],
  id: string,
): string[] {
  return setResupplyStopSelected(current, allIds, id, !new Set(current ?? allIds).has(id));
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

/**
 * What the waypoint detail screen shows and does about the resupply plan.
 *
 * The screen must not read one thing and write another: it shows the *derived*
 * planned state (`plannedResupplyIds`, which also plans a ticked place's
 * turn-off) while the store holds the hiker's ticks. So this hook answers both
 * halves together —
 *
 *  - `isPlanned` drives the banner, and `plannedVia` names the ticked place
 *    when this waypoint is planned only because it serves one. A turn-off
 *    cannot be unticked on its own (it was never ticked), so it is offered no
 *    toggle: the banner says where the plan came from and the place it serves
 *    is where to change it.
 *  - `toggle` is null unless the trail actually offers this waypoint as an
 *    option. A resupply-family waypoint the options list does not hold (no id,
 *    or no km to place it at) would otherwise store the whole option list on
 *    its first tap and invent a plan nobody made.
 *  - `isSelected` is the hiker's own tick, so the button's label and its action
 *    are the same fact.
 */
export interface WaypointResupplyPlan {
  /** Highlighted as a planned stop anywhere in the app. */
  isPlanned: boolean;
  /** The ticked option(s) this waypoint is planned through, when it is not one itself. */
  plannedVia: string | null;
  /** In the hiker's selection — what the toggle's label describes. */
  isSelected: boolean;
  /** Tick or untick this waypoint, or null when no toggle should be offered. */
  toggle: (() => void) | null;
}

export function useWaypointResupplyPlan(
  trailId: string,
  trail: PlannedResupplyTrail,
  waypointId: string | null | undefined,
): WaypointResupplyPlan {
  const selected = usePlanInputsStore(selectResupplyStopIds(trailId));
  const stored = usePlanInputsStore(selectPrefs(trailId)).resupplyStops;
  const setResupplyStops = usePlanInputsStore((s) => s.setResupplyStops);
  // Keyed on the trail alone, as `usePlannedResupplyIds` is: ticking a box must
  // not regroup the CDT's 70 options.
  const groups = useMemo(() => listResupplyOptions(trail.waypoints), [trail]);
  const allIds = useMemo(() => allResupplyOptionIds(groups), [groups]);
  const planned = useMemo(() => plannedResupplyIds(groups, selected), [groups, selected]);

  const optionId = waypointId != null && allIds.includes(waypointId) ? waypointId : null;
  const isSelected = optionId != null && (selected?.has(optionId) ?? false);
  const isPlanned = optionId != null && (planned?.has(optionId) ?? false);
  const plannedVia =
    optionId != null && isPlanned && !isSelected
      ? tickedNamesAround(groups, selected, optionId)
      : null;

  const toggle = useCallback(() => {
    if (!optionId) return;
    setResupplyStops(trailId, setResupplyStopSelected(stored, allIds, optionId, !isSelected));
  }, [allIds, isSelected, optionId, setResupplyStops, stored, trailId]);

  return {
    isPlanned,
    plannedVia,
    isSelected,
    toggle: optionId != null && plannedVia == null ? toggle : null,
  };
}

/** The ticked options sharing a group with `optionId`, named the way a stop is. */
function tickedNamesAround(
  groups: readonly ResupplyOptionGroup[],
  selected: ReadonlySet<string> | null,
  optionId: string,
): string | null {
  if (!selected) return null;
  const group = groups.find((g) => g.options.some((o) => o.id === optionId));
  const names = (group?.options ?? [])
    .filter((o) => o.id !== optionId && selected.has(o.id))
    .map((o) => o.name);
  return names.length > 0 ? names.join(' / ') : null;
}
