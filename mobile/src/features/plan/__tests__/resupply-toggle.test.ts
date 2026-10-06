/**
 * Two checkbox taps queued before either edit has run must both land: each
 * editor reads the selection off the document `apply` hands it, which is the
 * previous edit's result, not the list the screen rendered with.
 */

import type { PlanDocument } from '@lib/plan-types';
import { DEFAULT_PREFS, usePlanInputsStore } from '../plan-inputs-store';
import { usePlansStore, type PlanDefaults } from '../../../state/plans-store';
import { queueResupplyToggle, resupplyToggleEditor } from '../resupply-toggle';

const DEFAULTS: PlanDefaults = { name: 'CDT', direction: 'NOBO' };
const ALL = ['w_a', 'w_b', 'w_c'];

function planWith(resupplyStops?: string[]): PlanDocument {
  return {
    id: 'p1',
    trailId: 'cdt',
    name: 'CDT',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    ...(resupplyStops ? { resupplyStops } : {}),
    updatedAt: '2026-09-01T00:00:00Z',
    version: 1,
  };
}

/** A stand-in for `apply` that queues editors and runs them only on `drain`. */
function deferredApply() {
  const queue: ((p: PlanDocument) => PlanDocument)[] = [];
  const apply = jest.fn(async (_trailId: string, edit: (p: PlanDocument) => PlanDocument) => {
    queue.push(edit);
    return null;
  });
  usePlansStore.setState({ apply: apply as never });
  return {
    drain(): void {
      for (const edit of queue.splice(0)) {
        const current = usePlansStore.getState().byTrail.cdt ?? planWith();
        usePlansStore.setState({ byTrail: { cdt: edit(current) } });
      }
    },
  };
}

beforeEach(() => {
  usePlansStore.setState({ byTrail: { cdt: planWith(['w_a', 'w_b', 'w_c']) } });
  usePlanInputsStore.setState({ byTrail: {} });
});

describe('queueResupplyToggle', () => {
  it('keeps both of two quick taps', () => {
    const { drain } = deferredApply();
    // Both taps happen before either write has run.
    queueResupplyToggle('cdt', ALL, 'w_a', DEFAULTS);
    queueResupplyToggle('cdt', ALL, 'w_b', DEFAULTS);
    drain();
    expect(usePlansStore.getState().byTrail.cdt?.resupplyStops).toEqual(['w_c']);
  });

  it('starts a first plan from every option ticked', () => {
    usePlansStore.setState({ byTrail: { cdt: planWith() } });
    const { drain } = deferredApply();
    queueResupplyToggle('cdt', ALL, 'w_b', DEFAULTS);
    queueResupplyToggle('cdt', ALL, 'w_c', DEFAULTS);
    drain();
    expect(usePlansStore.getState().byTrail.cdt?.resupplyStops).toEqual(['w_a']);
  });
});

describe('resupplyToggleEditor', () => {
  it('falls back to the legacy device selection only while the document has none', () => {
    usePlanInputsStore.setState({
      byTrail: { cdt: { ...DEFAULT_PREFS, resupplyStops: ['w_c'] } },
    });
    const edit = resupplyToggleEditor('cdt', ALL, 'w_a');
    expect(edit(planWith()).resupplyStops).toEqual(['w_a', 'w_c']);
    expect(edit(planWith(['w_b'])).resupplyStops).toEqual(['w_a', 'w_b']);
  });
});
