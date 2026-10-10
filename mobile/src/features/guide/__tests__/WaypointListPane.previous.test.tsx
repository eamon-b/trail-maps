/**
 * The datasheet opens on what is still ahead: rows behind the hiker's fix are
 * folded behind "Show N previous", unfolded and folded again by that button,
 * and never folded without a fix. Same mocks as the POI-rows suite.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import type { TrailPOI } from '@lib/trail-types';
import { WaypointListPane } from '../WaypointListPane';
import { useVisiblePois } from '../use-visible-pois';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const mockPush = jest.fn();
let mockPosition: { currentKm: number | null; status: string } = {
  currentKm: null,
  status: 'no-permission',
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({ trailId: 'heysen', direction: 'default' }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => mockPosition,
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
  useVisiblePois: jest.fn(() => []),
}));

const mockVisiblePois = useVisiblePois as jest.MockedFunction<typeof useVisiblePois>;

function poi(overrides: Partial<TrailPOI> & Pick<TrailPOI, 'id' | 'category'>): TrailPOI {
  return {
    type: 'node',
    lat: -34.9,
    lon: 138.6,
    name: null,
    tags: {},
    distanceAlongTrail: 0,
    distanceFromTrail: 0.4,
    ...overrides,
  };
}

/** One POI of each family the chips reach, spread along the trail. */
const pois: TrailPOI[] = [
  poi({ id: 1, category: 'water', name: 'Kanmantoo Tank', distanceAlongTrail: 6 }),
  poi({ id: 2, category: 'camping', name: 'Mount Crawford Camp', distanceAlongTrail: 12 }),
  poi({ id: 3, category: 'restaurant', name: 'Bakery', distanceAlongTrail: 18 }),
  poi({ id: 4, category: 'water', distanceAlongTrail: 21 }),
];

const trail = {
  track: { totalDistance: 30, points: [] },
  waypoints: [
    { id: 'w_start', name: 'Trailhead', type: 'trailhead', totalDistance: 0 },
    { id: 'w_creek', name: 'Kennedy Creek', type: 'creek', totalDistance: 12 },
    { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 20 },
    { id: 'w_hut', name: 'Stone Hut', type: 'hut', totalDistance: 24 },
  ],
} as unknown as TrailJson;

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

/** Every string rendered under one node, in order. */
function textOf(node: TestInstance): string {
  const out: string[] = [];
  node.findAll(() => true).forEach((n) => collectText(n.props.children, out));
  // A composite and its host node both carry the same children, so every string
  // is collected twice in a row; keep the first of each pair.
  return out.filter((text, i) => text !== out[i - 1]).join(' ');
}

/** Row labels in render order — "Open X" for a waypoint, "… (OpenStreetMap)" for a POI. */
function rowLabels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.onPress != null)
    .map((n) => n.props.accessibilityLabel as string);
}

/** Press a filter chip by its label (chips are the pressables carrying a selected state). */
function pressChip(tree: ReactTestRenderer, label: string): void {
  const [chip] = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityState != null &&
      textOf(n) === label,
  );
  press(chip);
}

/** Fire a pressable's onPress inside act, the way a tap would. */
function press(node: TestInstance): void {
  act(() => {
    (node.props.onPress as () => void)();
  });
}

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WaypointListPane trail={trail} />);
  });
  // FlatList schedules its cell pass on a timer; flush it here so the rows are
  // settled before the assertions (and nothing lands after the test ends).
  act(() => {
    jest.runOnlyPendingTimers();
  });
  return tree;
}

describe('WaypointListPane previous rows', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockVisiblePois.mockImplementation(() => pois);
  });

  afterEach(() => {
    jest.useRealTimers();
    mockPosition = { currentKm: null, status: 'no-permission' };
  });

  function previousButton(tree: ReactTestRenderer): TestInstance | undefined {
    return tree.root.findAll(
      (n) =>
        typeof n.props.onPress === 'function' &&
        (n.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded != null,
    )[0];
  }

  it('lists the whole trail without a fix', () => {
    const tree = render();
    expect(rowLabels(tree)).toContain('Open Trailhead');
    expect(previousButton(tree)).toBeUndefined();
  });

  it('hides rows behind the hiker until "Show previous" is pressed', () => {
    mockPosition = { currentKm: 18, status: 'fix' };
    const tree = render();
    // Trailhead (0), Kanmantoo Tank (6), Kennedy Creek (12), Mount Crawford Camp (12) are behind;
    // the Bakery at 18 is level with the hiker and stays.
    const labels = rowLabels(tree);
    expect(labels.some((l) => l.includes('Trailhead'))).toBe(false);
    expect(labels.some((l) => l.includes('Kennedy Creek'))).toBe(false);
    expect(labels.some((l) => l.includes('Bakery'))).toBe(true);
    expect(labels).toContain('Open Ridge Camp');

    const button = previousButton(tree)!;
    expect(textOf(button)).toBe('Show 4 previous');
    press(button);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rowLabels(tree)).toContain('Open Trailhead');
    expect(textOf(previousButton(tree)!)).toBe('Hide previous');

    press(previousButton(tree)!);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rowLabels(tree)).not.toContain('Open Trailhead');
  });

  it('counts only the rows the active filter shows', () => {
    mockPosition = { currentKm: 18, status: 'fix' };
    const tree = render();
    pressChip(tree, 'Water');
    act(() => {
      jest.runOnlyPendingTimers();
    });
    // Kanmantoo Tank (6) and Kennedy Creek (12) are the water rows behind.
    expect(textOf(previousButton(tree)!)).toBe('Show 2 previous');
  });
});
