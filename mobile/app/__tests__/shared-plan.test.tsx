/**
 * The shared-plan screen (`tracknotes://plan/<shareId>`).
 *
 * Three outcomes have to be unmistakable: a readable plan with the owner's
 * name on it, a trail this phone does not carry, and a link that no longer
 * works. The fourth thing tested is the one with lasting consequences — "Save
 * as my plan" must make a COPY under a new id, and must warn before it replaces
 * a plan the hiker already had.
 */

import React from 'react';
import { Alert, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import SharedPlanScreen, { LOAD_FAILED_MESSAGE, UNKNOWN_TRAIL_MESSAGE } from '../plan/[shareId]';
import { fetchSharedPlan } from '../../src/api/plans';
import { getTrailJson } from '../../src/services/trail-loader';
import { usePlansStore } from '../../src/state/plans-store';
import { ApiError } from '../../src/api/client';

jest.mock('../../src/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ shareId: 'SHARE1' }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
}));

jest.mock('../../src/api/client', () => ({
  ...jest.requireActual('../../src/api/client'),
  getBaseUrl: () => 'https://api.test',
}));

jest.mock('../../src/api/plans', () => ({ fetchSharedPlan: jest.fn() }));

jest.mock('../../src/services/trail-loader', () => ({
  getTrailJson: jest.fn(),
  getTrailIndexEntry: () => ({ id: 'heysen', name: 'Heysen Trail' }),
}));

jest.mock('../../src/api/uuid', () => ({ uuidv4: () => 'new-plan-id' }));

const mockFetchShared = fetchSharedPlan as jest.Mock;
const mockGetTrailJson = getTrailJson as jest.Mock;

const TRAIL = {
  config: { name: 'Heysen Trail', direction: 'NOBO' },
  track: {
    totalDistance: 30,
    points: [
      { lat: -35, lon: 138, ele: 100, dist: 0 },
      { lat: -35.1, lon: 138.1, ele: 150, dist: 10 },
      { lat: -35.2, lon: 138.2, ele: 120, dist: 20 },
      { lat: -35.3, lon: 138.3, ele: 180, dist: 30 },
    ],
    displayPoints: [],
  },
  waypoints: [{ id: 'w_1', name: 'Mount Hut', type: 'hut', totalDistance: 10 }],
};

const DOC: PlanDocument = {
  id: 'their-plan',
  trailId: 'heysen',
  name: 'Their Heysen',
  direction: 'NOBO',
  startDate: '2026-10-01',
  stops: [{ waypointId: 'w_1', km: 10, name: 'Mount Hut', nights: 1 }],
  updatedAt: '2026-09-01T00:00:00Z',
  version: 1,
};

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTrailJson.mockReturnValue(TRAIL);
  mockFetchShared.mockResolvedValue({
    document: DOC,
    trailId: 'heysen',
    ownerDisplayName: 'Trail Ghost',
  });
  usePlansStore.setState({ byTrail: {} });
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<SharedPlanScreen />);
    await new Promise((resolve) => setImmediate(resolve));
  });
  mounted = tree;
  return tree;
}

function renderedText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function pressSave(r: ReactTestRenderer) {
  const target = r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === 'Save as my plan' &&
      typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => {
    (target.props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('SharedPlanScreen', () => {
  it('shows the days and who shared them', async () => {
    const r = await mount();

    expect(mockFetchShared).toHaveBeenCalledWith({ baseUrl: 'https://api.test' }, 'SHARE1');
    const text = renderedText(r);
    expect(text).toContain('Their Heysen');
    expect(text).toContain('Shared by');
    expect(text).toContain('Trail Ghost');
    // One stop at km 10 splits the 30 km trail into two days.
    expect(text).toContain('2');
  });

  it('says so when the plan is for a trail this app does not have', async () => {
    mockGetTrailJson.mockReturnValue(null);
    const r = await mount();
    expect(renderedText(r)).toContain(UNKNOWN_TRAIL_MESSAGE);
  });

  it('reports a revoked or unknown link rather than an empty screen', async () => {
    mockFetchShared.mockRejectedValue(new ApiError(404, 'not_found', 'No such shared plan'));
    const r = await mount();
    expect(renderedText(r)).toContain('No such shared plan');
  });

  it('falls back to its own copy when the failure says nothing useful', async () => {
    mockFetchShared.mockRejectedValue(new Error('boom'));
    const r = await mount();
    expect(renderedText(r)).toContain(LOAD_FAILED_MESSAGE);
  });

  it('saves a COPY under a new id, not the shared document', async () => {
    const apply = jest.fn(async (_trailId: string, edit: (p: PlanDocument) => PlanDocument) =>
      edit(DOC),
    );
    usePlansStore.setState({ apply: apply as never });

    const r = await mount();
    await pressSave(r);

    expect(apply).toHaveBeenCalledTimes(1);
    const saved = (apply.mock.results[0].value as Promise<PlanDocument>) ?? null;
    await expect(saved).resolves.toMatchObject({
      id: 'new-plan-id',
      trailId: 'heysen',
      name: 'Their Heysen',
      stops: DOC.stops,
    });
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/guide/[trailId]/plan',
      params: { trailId: 'heysen' },
    });
  });

  it('warns before replacing a plan the hiker already has', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const apply = jest.fn(async () => DOC);
    usePlansStore.setState({
      apply: apply as never,
      byTrail: { heysen: { ...DOC, id: 'mine' } },
    });

    const r = await mount();
    await pressSave(r);

    expect(apply).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls[0];
    expect(title).toMatch(/Replace/i);

    // Confirming goes through to the same copy-and-store path.
    await act(async () => {
      (buttons as { text: string; onPress?: () => void }[])[1].onPress?.();
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(apply).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });
});
