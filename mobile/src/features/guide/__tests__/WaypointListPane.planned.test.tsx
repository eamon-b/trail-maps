/**
 * Planned resupply stops in the datasheet: the row pill, the `Planned` chip
 * (which only exists once a plan does), and the empty state that points at the
 * Plan screen. The real stores drive it, so what is asserted here is the whole
 * path from a stored selection to a rendered pill — from the plan document,
 * which is where the selection lives and what a sync brings in, and from the
 * device-local prefs of a build that predates it.
 */

import React from 'react';
import TestRenderer, {
  act,
  type ReactTestRenderer,
  type TestInstance,
} from 'react-test-renderer';
import { WaypointListPane } from '../WaypointListPane';
import { usePlanInputsStore } from '../../plan/plan-inputs-store';
import { usePlansStore } from '../../../state/plans-store';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({ trailId: 'heysen', direction: 'default' }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => ({ currentKm: null }),
}));

jest.mock('../../../state/favorites-store', () => ({
  useFavoritesStore: (selector: (s: unknown) => unknown) => selector({ byTrail: {} }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../use-water-status', () => ({
  useWaterStatus: () => new Map(),
}));

jest.mock('../use-visible-pois', () => ({
  useVisiblePois: () => [],
}));

/**
 * Hahndorf is off the route; the turn-off that serves it is on it. Mount Barker
 * is a second town off the same turn-off — a different place, reached the same
 * way, and never planned by ticking Hahndorf.
 */
const trail = {
  track: { totalDistance: 30 },
  waypoints: [
    { id: 'w_start', name: 'Trailhead', type: 'trailhead', totalDistance: 0 },
    {
      id: 'w_turnoff',
      name: 'Hahndorf turn-off',
      type: 'town-access',
      totalDistance: 12,
      accessName: 'Mount Barker Road',
    },
    {
      id: 'w_town',
      name: 'Hahndorf',
      type: 'town',
      totalDistance: 12,
      offTrailKm: 4,
      accessMode: 'hitch',
      accessName: 'Mount Barker Road',
    },
    {
      id: 'w_other',
      name: 'Mount Barker',
      type: 'town-access',
      totalDistance: 12,
      offTrailKm: 9,
      accessMode: 'hitch',
      accessName: 'Mount Barker Road',
    },
    { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 20 },
  ],
} as unknown as TrailJson;

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join(' ');
}

function textOf(node: TestInstance): string {
  const out: string[] = [];
  node.findAll(() => true).forEach((n) => collectText(n.props.children, out));
  return out.filter((text, i) => text !== out[i - 1]).join(' ');
}

/** The filter chips, by label — chips are the pressables carrying a selected state. */
function chipLabels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityState != null)
    .map((n) => textOf(n));
}

function pressChip(tree: ReactTestRenderer, label: string): void {
  const [chip] = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityState != null &&
      textOf(n) === label,
  );
  act(() => {
    (chip.props.onPress as () => void)();
  });
}

/** Row labels in render order ("Open X"). */
function rowLabels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.onPress != null)
    .map((n) => n.props.accessibilityLabel as string);
}

/** A stored plan whose only interesting field is the resupply selection. */
function planWith(resupplyStops: string[]): PlanDocument {
  return {
    id: 'p1',
    trailId: 'heysen',
    name: 'Heysen',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    resupplyStops,
    updatedAt: '2026-09-01T00:00:00Z',
    version: 1,
  };
}

let mounted: ReactTestRenderer | null = null;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WaypointListPane trail={trail} />);
  });
  act(() => {
    jest.runOnlyPendingTimers();
  });
  mounted = tree;
  return tree;
}

describe('WaypointListPane planned resupply', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    usePlanInputsStore.setState({ byTrail: {} });
    usePlansStore.setState({ byTrail: {} });
  });

  afterEach(() => {
    // Unmount before the next test writes to the store: a live subscriber would
    // re-render outside act().
    act(() => mounted?.unmount());
    mounted = null;
    jest.useRealTimers();
  });

  it('shows no Planned chip and no pill before a plan is made', () => {
    const tree = render();
    expect(chipLabels(tree)).not.toContain('Planned');
    expect(allText(tree)).not.toContain('Resupply');
  });

  it('pills the ticked stop and its turn-off, but not the next town along the road', () => {
    usePlansStore.setState({ byTrail: { heysen: planWith(['w_town']) } });
    const tree = render();
    expect(chipLabels(tree)).toContain('Planned');

    // The town and the turn-off that serves it are planned — the turn-off is the
    // km the food has to reach. Mount Barker, a separate town off the same road,
    // is not: nobody chose it.
    pressChip(tree, 'Planned');
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rowLabels(tree)).toEqual(['Open Hahndorf turn-off', 'Open Hahndorf']);
    expect(rowLabels(tree)).not.toContain('Open Mount Barker');
    expect(allText(tree)).toContain('Resupply');
  });

  it('points at the Plan screen when the plan is empty', () => {
    usePlansStore.setState({ byTrail: { heysen: planWith([]) } });
    const tree = render();
    pressChip(tree, 'Planned');
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(allText(tree)).toContain(
      'No planned resupply stops. Choose them from the Plan screen.',
    );
  });

  it('still reads a selection made before the plan document carried one', () => {
    // No document at all — only what an older build persisted on this device.
    usePlanInputsStore.setState({
      byTrail: { heysen: { dailyHours: 8, pace: 'average', resupplyStops: ['w_town'] } },
    });
    const tree = render();
    expect(chipLabels(tree)).toContain('Planned');
  });

  it('prefers the document over the device-local leftovers', () => {
    usePlanInputsStore.setState({
      byTrail: { heysen: { dailyHours: 8, pace: 'average', resupplyStops: ['w_town'] } },
    });
    usePlansStore.setState({ byTrail: { heysen: planWith([]) } });
    const tree = render();
    pressChip(tree, 'Planned');
    act(() => {
      jest.runOnlyPendingTimers();
    });
    // The document says nothing is planned, and it wins.
    expect(allText(tree)).toContain(
      'No planned resupply stops. Choose them from the Plan screen.',
    );
  });
});
