/**
 * The resupply picker's checkbox tap, as a plan edit.
 *
 * `apply` queues edits per trail, so two quick taps run one after the other —
 * but only an editor that reads the selection off the document it is handed
 * sees the first tap's result. Building the new list from the selection the
 * screen rendered with (and only then queueing it) let the second tap start
 * from the list before the first, and the first tick was lost.
 */

import { setResupplyStops } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import { usePlansStore, type PlanDefaults } from '../../state/plans-store';
import { selectPrefs, usePlanInputsStore } from './plan-inputs-store';
import { toggleResupplyStop } from './use-planned-resupply';

/**
 * An editor that flips `id` in whatever selection the plan holds when the edit
 * runs. Only while the document has none does it fall back to the device-local
 * selection an older build left behind (read then, too, not at tap time), the
 * same precedence every reader uses.
 */
export function resupplyToggleEditor(
  trailId: string,
  allIds: string[],
  id: string,
): (plan: PlanDocument) => PlanDocument {
  return (plan) => {
    const legacy = selectPrefs(trailId)(usePlanInputsStore.getState()).resupplyStops;
    return setResupplyStops(plan, toggleResupplyStop(plan.resupplyStops ?? legacy, allIds, id));
  };
}

/** Queue one checkbox tap. Floating on purpose: `apply` never rejects. */
export function queueResupplyToggle(
  trailId: string,
  allIds: string[],
  id: string,
  defaults: PlanDefaults,
): void {
  void usePlansStore.getState().apply(trailId, resupplyToggleEditor(trailId, allIds, id), defaults);
}
