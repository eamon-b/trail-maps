/**
 * `usePlannedResupplyIds` is the single read every "planned" surface makes, so
 * what matters here is that it answers from the plan DOCUMENT (the thing the
 * web writes and sync carries), falls back to the device-local selection an
 * older build left behind, and that a turn-off is planned whenever the place it
 * serves is.
 *
 * The plans store is real; only `apply` is stubbed, so a write is checked for
 * what it asks the editor to do without a SQLite round trip. `plans-store`'s
 * own tests cover the persistence.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { setResupplyStops } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import { DEFAULT_PREFS, usePlanInputsStore } from '../plan-inputs-store';
import { usePlansStore, type PlanDefaults } from '../../../state/plans-store';
import {
  plannedIdsFor,
  setResupplyStopSelected,
  toggleResupplyStop,
  usePlannedResupplyIds,
  useWaypointResupplyPlan,
  type PlannedResupplyTrail,
  type WaypointResupplyPlan,
} from '../use-planned-resupply';

const DEFAULTS: PlanDefaults = { name: 'CDT', direction: 'NOBO' };

/** A stored plan carrying a resupply selection and nothing else of interest. */
function planWith(resupplyStops: string[] | undefined): PlanDocument {
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

/** Put a document in the cache, the way a hydrate or a pull does. */
function storePlan(plan: PlanDocument | undefined): void {
  usePlansStore.setState({ byTrail: { cdt: plan } });
}

/** What an older build left on this device, and nothing writes any more. */
function storeLegacy(ids: string[]): void {
  usePlanInputsStore.setState({
    byTrail: { cdt: { ...DEFAULT_PREFS, resupplyStops: ids } },
  });
}

/**
 * Stand in for the real `apply`: run the editor over the cached document (or a
 * blank one) and cache the result, so a write is visible to the next render.
 */
function stubApply(): jest.Mock {
  const apply = jest.fn(async (trailId: string, edit: (p: PlanDocument) => PlanDocument) => {
    const base = usePlansStore.getState().byTrail[trailId] ?? planWith(undefined);
    const next = edit(base);
    usePlansStore.setState({ byTrail: { ...usePlansStore.getState().byTrail, [trailId]: next } });
    return next;
  });
  usePlansStore.setState({ apply: apply as never });
  return apply;
}

/**
 * Monarch Pass: one turn-off on the route, two towns a hitch away — each typed
 * `-access` and carrying its own off-trail distance, the way the CDT ships them
 * — plus a plain on-trail town further along and a resupply the options list
 * cannot place.
 */
const trail: PlannedResupplyTrail = {
  waypoints: [
    { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
    {
      id: 'w_salida',
      name: 'Salida',
      type: 'town-access',
      totalDistance: 100,
      offTrailKm: 22.5,
      accessMode: 'hitch',
      accessName: 'Monarch Pass (US 50)',
    },
    {
      id: 'w_poncha',
      name: 'Poncha Springs',
      type: 'resupply-access',
      totalDistance: 100,
      offTrailKm: 14,
      accessMode: 'hitch',
      accessName: 'Monarch Pass (US 50)',
    },
    { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
    // No km: a resupply the trail cannot offer as an option.
    { id: 'w_ghost', name: 'Ghost Ranch store', type: 'resupply' },
  ],
};

describe('plannedIdsFor', () => {
  it('is null when nothing has been chosen', () => {
    expect(plannedIdsFor(trail, null)).toBeNull();
  });

  it('plans the turn-off alongside the town it serves', () => {
    const planned = plannedIdsFor(trail, new Set(['w_salida']));
    expect([...planned!].sort()).toEqual(['w_pass', 'w_salida']);
  });

  it('leaves the other town on the same hitch alone', () => {
    // Poncha Springs is 14 km down a different road; ticking Salida says
    // nothing about it.
    expect(plannedIdsFor(trail, new Set(['w_salida']))!.has('w_poncha')).toBe(false);
  });

  it('leaves an untouched group alone', () => {
    const planned = plannedIdsFor(trail, new Set(['w_creede']));
    expect([...planned!]).toEqual(['w_creede']);
  });

  it('is empty — not null — for an explicit empty selection', () => {
    const planned = plannedIdsFor(trail, new Set<string>());
    expect(planned).not.toBeNull();
    expect(planned!.size).toBe(0);
  });
});

describe('toggleResupplyStop', () => {
  const allIds = ['w_pass', 'w_salida', 'w_poncha', 'w_creede'];

  it('first tap from no plan keeps every other option ticked', () => {
    expect(toggleResupplyStop(undefined, allIds, 'w_poncha')).toEqual([
      'w_pass',
      'w_salida',
      'w_creede',
    ]);
  });

  it('adds to an explicit list, in trail order', () => {
    expect(toggleResupplyStop(['w_creede'], allIds, 'w_salida')).toEqual(['w_salida', 'w_creede']);
  });

  it('removes from an explicit list', () => {
    expect(toggleResupplyStop(['w_salida', 'w_creede'], allIds, 'w_creede')).toEqual(['w_salida']);
  });

  it('prunes ids the trail no longer offers', () => {
    expect(toggleResupplyStop(['w_gone', 'w_creede'], allIds, 'w_salida')).toEqual([
      'w_salida',
      'w_creede',
    ]);
  });
});

describe('usePlannedResupplyIds', () => {
  let latest: ReadonlySet<string> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Harness() {
    latest = usePlannedResupplyIds('cdt', trail);
    return null;
  }

  function mount() {
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
  }

  beforeEach(() => {
    usePlanInputsStore.setState({ byTrail: {} });
    usePlansStore.setState({ byTrail: {} });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('is null until a plan is made', () => {
    mount();
    expect(latest).toBeNull();
  });

  it('follows the document', () => {
    mount();
    act(() => {
      storePlan(planWith(['w_poncha']));
    });
    expect([...latest!].sort()).toEqual(['w_pass', 'w_poncha']);

    act(() => {
      storePlan(planWith(undefined));
    });
    expect(latest).toBeNull();
  });

  it('highlights a selection that arrived from the server with no local prefs', () => {
    // Exactly what a pull leaves behind: a document in the cache, nothing in
    // the device-local store.
    storePlan(planWith(['w_salida']));
    mount();
    expect([...latest!].sort()).toEqual(['w_pass', 'w_salida']);
    expect(usePlanInputsStore.getState().byTrail.cdt).toBeUndefined();
  });

  it('falls back to a selection made before the document carried one', () => {
    storeLegacy(['w_creede']);
    mount();
    expect([...latest!]).toEqual(['w_creede']);
  });

  it('prefers the document once it has a selection of its own', () => {
    storeLegacy(['w_creede']);
    storePlan(planWith([]));
    mount();
    // An explicit empty selection is a plan with nothing in it, and it wins.
    expect(latest!.size).toBe(0);
  });
});

describe('setResupplyStopSelected', () => {
  const allIds = ['w_pass', 'w_salida', 'w_poncha', 'w_creede'];

  it('ticks into the every-option default without unplanning the rest', () => {
    expect(setResupplyStopSelected(undefined, allIds, 'w_poncha', true)).toEqual(allIds);
  });

  it('unticks out of the every-option default', () => {
    expect(setResupplyStopSelected(undefined, allIds, 'w_poncha', false)).toEqual([
      'w_pass',
      'w_salida',
      'w_creede',
    ]);
  });

  it('is idempotent — asking for the state it is already in changes nothing', () => {
    expect(setResupplyStopSelected(['w_creede'], allIds, 'w_creede', true)).toEqual(['w_creede']);
    expect(setResupplyStopSelected(['w_creede'], allIds, 'w_salida', false)).toEqual(['w_creede']);
  });
});

describe('useWaypointResupplyPlan', () => {
  let latest!: WaypointResupplyPlan;
  let renderer: ReactTestRenderer | null = null;

  function mount(waypointId: string | undefined) {
    function Harness() {
      latest = useWaypointResupplyPlan('cdt', trail, waypointId, DEFAULTS);
      return null;
    }
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
  }

  const press = () =>
    act(() => {
      latest.toggle?.();
    });

  const stored = () => usePlansStore.getState().byTrail.cdt?.resupplyStops;

  beforeEach(() => {
    usePlanInputsStore.setState({ byTrail: {} });
    usePlansStore.setState({ byTrail: {} });
    stubApply();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('plans a waypoint on the first tap, and unplans it on the second', () => {
    mount('w_creede');
    expect(latest.isPlanned).toBe(false);
    expect(latest.isSelected).toBe(false);

    press();
    // The rest of the trail stays ticked; what the button said would happen did.
    expect(stored()).toEqual(['w_pass', 'w_salida', 'w_poncha', 'w_creede']);
    expect(latest.isPlanned).toBe(true);
    expect(latest.isSelected).toBe(true);

    press();
    expect(stored()).toEqual(['w_pass', 'w_salida', 'w_poncha']);
    expect(latest.isPlanned).toBe(false);
  });

  it('removes a ticked stop in one press', () => {
    storePlan(planWith(['w_salida', 'w_creede']));
    mount('w_salida');
    expect(latest.isSelected).toBe(true);

    press();
    expect(stored()).toEqual(['w_creede']);
    expect(latest.isPlanned).toBe(false);
    expect(latest.isSelected).toBe(false);
  });

  it('shows a turn-off as planned via the place it serves, with no toggle', () => {
    storePlan(planWith(['w_salida']));
    mount('w_pass');

    expect(latest.isPlanned).toBe(true);
    expect(latest.isSelected).toBe(false);
    expect(latest.plannedVia).toBe('Salida');
    // Nothing was ticked here, so there is nothing to untick: the hiker changes
    // it on Salida. A Remove button would have added this id instead.
    expect(latest.toggle).toBeNull();
  });

  it('does not plan the other town on the same hitch', () => {
    storePlan(planWith(['w_salida']));
    mount('w_poncha');

    expect(latest.isPlanned).toBe(false);
    expect(latest.plannedVia).toBeNull();
    // It is still an option, so it can be ticked on its own.
    expect(latest.toggle).not.toBeNull();
  });

  it('offers no toggle for a resupply the trail does not offer as an option', () => {
    mount('w_ghost');
    expect(latest.toggle).toBeNull();
    expect(latest.isPlanned).toBe(false);
    expect(stored()).toBeUndefined();
  });

  it('offers no toggle for a waypoint with no id at all', () => {
    mount(undefined);
    expect(latest.toggle).toBeNull();
    expect(latest.isPlanned).toBe(false);
  });

  it('writes through the plans store, with the defaults a new plan needs', () => {
    const apply = stubApply();
    mount('w_creede');
    press();

    expect(apply).toHaveBeenCalledTimes(1);
    const [trailId, , defaults] = apply.mock.calls[0];
    expect(trailId).toBe('cdt');
    expect(defaults).toEqual(DEFAULTS);
    // The editor it handed over is the shared one, applied to the document.
    expect(stored()).toEqual(['w_pass', 'w_salida', 'w_poncha', 'w_creede']);
  });

  it('starts a first tick from the legacy selection, then leaves it behind', () => {
    storeLegacy(['w_salida']);
    mount('w_creede');
    press();

    // The tap adds to what the hiker could see, which was the legacy list.
    expect(stored()).toEqual(['w_salida', 'w_creede']);
    // And from here the document answers, not the leftovers.
    expect(latest.isSelected).toBe(true);
  });
});

describe('the editor the writers use', () => {
  it('drops the field entirely for "no plan made"', () => {
    const plan = planWith(['w_salida']);
    expect(setResupplyStops(plan, undefined).resupplyStops).toBeUndefined();
  });
});
