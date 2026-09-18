/**
 * The picker route against the real store: what the four actions persist.
 *
 * `All` and `Reset` produce the same legs and differ only in whether a plan
 * exists — an explicit full list highlights every stop on every screen, an
 * absent one highlights nothing — so the distinction is worth a test.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { usePlanInputsStore } from '../plan-inputs-store';
import ResupplyStopsScreen from '../../../../app/guide/[trailId]/resupply';

const trail = {
  config: { id: 'cdt', name: 'CDT' },
  waypoints: [
    { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
    { id: 'w_salida', name: 'Salida', type: 'town', totalDistance: 100, accessName: 'Monarch Pass' },
    { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
    { id: 'w_camp', name: 'Camp', type: 'campsite', totalDistance: 180 },
  ],
  track: { points: [], totalDistance: 300 },
};

let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../guide/GuideContext', () => ({
  useGuide: () => ({ trailId: 'cdt', direction: 'default', trail }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ResupplyStopsScreen />);
    // FlatList schedules its first cell pass on a timer; run it inside act so
    // the update is not reported as an un-acted render.
    jest.runOnlyPendingTimers();
  });
  return tree;
}

/** The pressable controls, keyed by the label they speak. */
function controls(tree: ReactTestRenderer): Map<string, () => void> {
  const found = new Map<string, () => void>();
  tree.root
    .findAll(
      (n) =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string',
    )
    .forEach((n) => {
      const label = n.props.accessibilityLabel as string;
      if (!found.has(label)) found.set(label, n.props.onPress as () => void);
    });
  return found;
}

function stored(): string[] | undefined {
  return usePlanInputsStore.getState().byTrail.cdt?.resupplyStops;
}

describe('resupply picker route', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockParams = {};
    // Block bodies throughout: a persisted `set` returns the storage write's
    // promise, and act() would treat a returned thenable as an async act.
    act(() => {
      usePlanInputsStore.setState({ byTrail: {} });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with every option ticked and no plan made', () => {
    const tree = render();
    expect(stored()).toBeUndefined();
    const checked = tree.root
      .findAll((n) => n.props.accessibilityRole === 'checkbox' && !!n.props.accessibilityState)
      .map((n) => (n.props.accessibilityState as { checked: boolean }).checked);
    expect(checked.every(Boolean)).toBe(true);
  });

  it('All stores every option id in trail order', () => {
    const tree = render();
    act(() => {
      controls(tree).get('All')!();
    });
    expect(stored()).toEqual(['w_pass', 'w_salida', 'w_creede']);
  });

  it('None stores an empty list — a plan with nothing in it', () => {
    const tree = render();
    act(() => {
      controls(tree).get('None')!();
    });
    expect(stored()).toEqual([]);
  });

  it('Reset drops the selection back to no plan at all', () => {
    const tree = render();
    act(() => {
      controls(tree).get('All')!();
    });
    act(() => {
      controls(tree).get('Reset')!();
    });
    expect(stored()).toBeUndefined();
  });

  it('a first tap plans everything but the row that was tapped', () => {
    const tree = render();
    const [row] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Creede' && typeof n.props.onPress === 'function',
    );
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(stored()).toEqual(['w_pass', 'w_salida']);
  });

  it('dims the rows a section param leaves out', () => {
    mockParams = { startKm: '0', endKm: '150' };
    const tree = render();
    const texts: string[] = [];
    tree.root.findAll(() => true).forEach((n) => {
      if (typeof n.props.children === 'string') texts.push(n.props.children);
    });
    expect(texts).toContain('outside section');
  });
});
