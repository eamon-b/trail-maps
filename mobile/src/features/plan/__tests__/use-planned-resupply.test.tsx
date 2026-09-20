/**
 * `usePlannedResupplyIds` is the single read every "planned" surface makes, so
 * what matters here is that it answers from the live store and that a turn-off
 * is planned whenever the place it serves is.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { usePlanInputsStore } from '../plan-inputs-store';
import {
  plannedIdsFor,
  setResupplyStopSelected,
  toggleResupplyStop,
  usePlannedResupplyIds,
  useWaypointResupplyPlan,
  type PlannedResupplyTrail,
  type WaypointResupplyPlan,
} from '../use-planned-resupply';

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

  beforeEach(() => {
    usePlanInputsStore.setState({ byTrail: {} });
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('is null until a plan is made', () => {
    expect(latest).toBeNull();
  });

  it('follows the store', () => {
    act(() => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_poncha']);
    });
    expect([...latest!].sort()).toEqual(['w_pass', 'w_poncha']);

    act(() => {
      usePlanInputsStore.getState().clearResupplyStops('cdt');
    });
    expect(latest).toBeNull();
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
      latest = useWaypointResupplyPlan('cdt', trail, waypointId);
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

  const stored = () => usePlanInputsStore.getState().byTrail.cdt?.resupplyStops;

  beforeEach(() => {
    usePlanInputsStore.setState({ byTrail: {} });
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
    act(() => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_salida', 'w_creede']);
    });
    mount('w_salida');
    expect(latest.isSelected).toBe(true);

    press();
    expect(stored()).toEqual(['w_creede']);
    expect(latest.isPlanned).toBe(false);
    expect(latest.isSelected).toBe(false);
  });

  it('shows a turn-off as planned via the place it serves, with no toggle', () => {
    act(() => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_salida']);
    });
    mount('w_pass');

    expect(latest.isPlanned).toBe(true);
    expect(latest.isSelected).toBe(false);
    expect(latest.plannedVia).toBe('Salida');
    // Nothing was ticked here, so there is nothing to untick: the hiker changes
    // it on Salida. A Remove button would have added this id instead.
    expect(latest.toggle).toBeNull();
  });

  it('does not plan the other town on the same hitch', () => {
    act(() => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_salida']);
    });
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
});
