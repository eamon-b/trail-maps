/**
 * The picker route against the real stores: what the four actions persist.
 *
 * The selection is a field of the trail's plan document now, so this runs the
 * whole way down — screen, `plans-store.apply`, the shared editor, SQLite — and
 * asserts on the stored document. That is the point of the change: what the
 * hiker ticks here is what a linked browser reads.
 *
 * `All` and `Reset` produce the same legs and differ only in whether a plan
 * exists — an explicit full list highlights every stop on every screen, an
 * absent one highlights nothing — so the distinction is worth a test.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import { getDatabase } from '../../../db/database';
import * as plansRepo from '../../../db/plans-repo';
import type { SqlDatabase } from '../../../db/sql-database';
import { usePlansStore } from '../../../state/plans-store';
import { DEFAULT_PREFS, usePlanInputsStore } from '../plan-inputs-store';
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

jest.mock('../../../db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('../../../api/uuid', () => ({ uuidv4: () => 'plan-uuid' }));

const mockGetDatabase = getDatabase as jest.Mock;
let db: SqlDatabase;

let mounted: ReactTestRenderer | null = null;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ResupplyStopsScreen />);
    // FlatList schedules its first cell pass on a timer; run it inside act so
    // the update is not reported as an un-acted render.
    jest.runOnlyPendingTimers();
  });
  mounted = tree;
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

/** Press a control and let the write reach SQLite. */
async function press(tree: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    controls(tree).get(label)!();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The selection as it was STORED, read back out of the database. */
async function storedSelection(): Promise<string[] | undefined> {
  return (await plansRepo.getByTrail(db, 'cdt'))?.resupplyStops;
}

function cachedPlan(): PlanDocument | undefined {
  return usePlansStore.getState().byTrail.cdt;
}

describe('resupply picker route', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockParams = {};
    db = (await createMigratedTestDb()) as unknown as SqlDatabase;
    mockGetDatabase.mockResolvedValue(db);
    usePlansStore.setState({ byTrail: {}, lastError: {} });
    // Block bodies throughout: a persisted `set` returns the storage write's
    // promise, and act() would treat a returned thenable as an async act.
    act(() => {
      usePlanInputsStore.setState({ byTrail: {} });
    });
  });

  afterEach(() => {
    // Unmount before the next test resets the stores: a live subscriber would
    // re-render outside act().
    act(() => mounted?.unmount());
    mounted = null;
    jest.useRealTimers();
  });

  it('starts with every option ticked and no plan made', async () => {
    const tree = render();
    expect(await storedSelection()).toBeUndefined();
    const checked = tree.root
      .findAll((n) => n.props.accessibilityRole === 'checkbox' && !!n.props.accessibilityState)
      .map((n) => (n.props.accessibilityState as { checked: boolean }).checked);
    expect(checked.every(Boolean)).toBe(true);
  });

  it('All stores every option id in trail order, in the plan document', async () => {
    const tree = render();
    await press(tree, 'All');

    expect(await storedSelection()).toEqual(['w_pass', 'w_salida', 'w_creede']);
    // The plan was minted by this first edit, named after the trail.
    const plan = cachedPlan();
    expect(plan?.id).toBe('plan-uuid');
    expect(plan?.name).toBe('CDT');
    expect(plan?.resupplyStops).toEqual(['w_pass', 'w_salida', 'w_creede']);
  });

  it('None stores an empty list — a plan with nothing in it', async () => {
    const tree = render();
    await press(tree, 'None');
    expect(await storedSelection()).toEqual([]);
  });

  it('Reset drops the selection back to no plan at all', async () => {
    const tree = render();
    await press(tree, 'All');
    await press(tree, 'Reset');

    expect(await storedSelection()).toBeUndefined();
    // The plan itself survives — only the selection was reset.
    expect(cachedPlan()?.id).toBe('plan-uuid');
  });

  it('Reset also clears a selection left by a build before the document', async () => {
    act(() => {
      usePlanInputsStore.setState({
        byTrail: { cdt: { ...DEFAULT_PREFS, resupplyStops: ['w_creede'] } },
      });
    });
    const tree = render();
    await press(tree, 'Reset');

    // Otherwise it would come straight back as the fallback.
    expect(usePlanInputsStore.getState().byTrail.cdt?.resupplyStops).toBeUndefined();
    expect(await storedSelection()).toBeUndefined();
  });

  it('a first tap plans everything but the row that was tapped', async () => {
    const tree = render();
    const [row] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Creede' && typeof n.props.onPress === 'function',
    );
    await act(async () => {
      (row.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await storedSelection()).toEqual(['w_pass', 'w_salida']);
  });

  it('shows the selection a sync brought in, with nothing stored on this device', async () => {
    await plansRepo.upsertServer(db, {
      id: 'from-the-browser',
      trailId: 'cdt',
      name: 'CDT',
      direction: 'NOBO',
      startDate: null,
      stops: [],
      resupplyStops: ['w_creede'],
      updatedAt: '2026-09-21T00:00:00Z',
      version: 1,
    });

    const tree = render();
    // The mount hydrate lands a tick later; flush it and re-run the list pass.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
    });

    const checked = tree.root
      .findAll(
        (n) =>
          n.props.accessibilityRole === 'checkbox' &&
          typeof n.props.accessibilityLabel === 'string' &&
          !!n.props.accessibilityState,
      )
      .map((n) => [n.props.accessibilityLabel, (n.props.accessibilityState as { checked: boolean }).checked]);
    expect(checked).toContainEqual(['Creede', true]);
    expect(checked).toContainEqual(['Salida', false]);
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
