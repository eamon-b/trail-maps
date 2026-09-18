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
  resupplyOptionIdsFor,
  toggleResupplyStop,
  usePlannedResupplyIds,
  type PlannedResupplyTrail,
} from '../use-planned-resupply';

/**
 * Monarch Pass: one turn-off on the route, two towns a hitch away, plus a plain
 * on-trail town further along. The shape the CDT actually ships.
 */
const trail: PlannedResupplyTrail = {
  waypoints: [
    { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
    {
      id: 'w_salida',
      name: 'Salida',
      type: 'town',
      totalDistance: 100,
      offTrailKm: 22.5,
      accessMode: 'hitch',
      accessName: 'Monarch Pass (US 50)',
    },
    {
      id: 'w_poncha',
      name: 'Poncha Springs',
      type: 'town',
      totalDistance: 100,
      offTrailKm: 14,
      accessMode: 'hitch',
      accessName: 'Monarch Pass (US 50)',
    },
    { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
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

describe('resupplyOptionIdsFor', () => {
  it('lists every option the trail offers, in trail order', () => {
    expect(resupplyOptionIdsFor(trail)).toEqual(['w_pass', 'w_salida', 'w_poncha', 'w_creede']);
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
