/**
 * The Today screen: the day's rows, the way into a waypoint, and the empty
 * states (no plan for today, a rest day).
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ComputedDay } from '@lib/plan-types';
import type { TodayPlanState } from '../use-today-plan';
import TodayScreen from '../../../../app/guide/[trailId]/today';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ trailId: 'syn' }),
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

let mockState: TodayPlanState;
jest.mock('../use-today-plan', () => ({ useTodayPlan: () => mockState }));

const day: ComputedDay = {
  dayNumber: 2,
  date: '2026-10-11',
  startName: 'Camp A',
  endName: 'Camp B',
  startKm: 20,
  endKm: 60,
  distanceKm: 40,
  ascentM: 300,
  descentM: 100,
  estimatedHours: 11,
  waterSources: 1,
  restDays: 0,
};

const base = { date: '2026-10-11', trail: {} as never, hasStartDate: true, hasStops: true };

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<TodayScreen />);
    jest.runOnlyPendingTimers();
  });
  return tree;
}

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
});

afterEach(() => jest.useRealTimers());

it('lists the day camp to camp and opens a waypoint', () => {
  mockState = {
    ...base,
    today: { kind: 'walk', day },
    rows: [
      { key: 's', waypoint: { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite' }, name: 'Camp A', type: 'campsite', role: 'start', km: 20, fromStartKm: 0, legKm: 0, legAscentM: 0, legDescentM: 0, totalAscentM: 0, totalDescentM: 0 },
      { key: 'v', waypoint: { id: 'wa', name: 'Creek', lat: 0, lon: 0, type: 'water' }, name: 'Creek', type: 'water', role: 'via', km: 30, fromStartKm: 10, legKm: 10, legAscentM: 100, legDescentM: 0, totalAscentM: 100, totalDescentM: 0 },
      { key: 'e', waypoint: { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite' }, name: 'Camp B', type: 'campsite', role: 'end', km: 60, fromStartKm: 40, legKm: 30, legAscentM: 200, legDescentM: 100, totalAscentM: 300, totalDescentM: 100 },
    ],
  };
  const tree = render();
  const shown = texts(tree);
  expect(shown).toContain('Day 2 · 2026-10-11');
  expect(shown).toContain('Camp A → Camp B');
  expect(shown).toContain('Tonight');
  expect(shown.some((s) => s.startsWith('10') && s.includes('↑ 100'))).toBe(true);

  const [creek] = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Creek'),
  );
  act(() => (creek.props.onPress as () => void)());
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/guide/[trailId]/waypoint/[waypointId]',
    params: { trailId: 'syn', waypointId: 'wa' },
  });
});

it('says why there is nothing for today', () => {
  mockState = { ...base, today: null, rows: [], hasStartDate: false };
  const shown = texts(render());
  expect(shown).toContain('Nothing planned for today');
  expect(shown.some((s) => s.includes('no start date'))).toBe(true);
});

it('shows a rest day', () => {
  mockState = { ...base, today: { kind: 'rest', day, restDay: 1, restDays: 1 }, rows: [] };
  const shown = texts(render());
  expect(shown).toContain('Rest day');
  expect(shown).toContain('A rest day at Camp B.');
});
