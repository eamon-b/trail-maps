/**
 * OpenStreetMap rows in the datasheet: where they land in the order, how they
 * are badged, which chips show them, the footer credit, and the route a tap
 * opens. Theme, router, contexts, stores and the DB-backed hooks are mocked, so
 * this is a pure render assertion over `useVisiblePois`' output — the global POI
 * switches are the settings store's business, tested there.
 */

import React from 'react';
import TestRenderer, {
  act,
  type ReactTestRenderer,
  type TestInstance,
} from 'react-test-renderer';
import type { TrailPOI } from '@lib/trail-types';
import { WaypointListPane } from '../WaypointListPane';
import { useVisiblePois } from '../use-visible-pois';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
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
  track: { totalDistance: 30 },
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

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join(' ');
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

describe('WaypointListPane POI rows', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockClear();
    mockVisiblePois.mockImplementation(() => pois);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('interleaves POIs by distance, waypoint first on a tie', () => {
    expect(rowLabels(render())).toEqual([
      'Open Trailhead',
      'Open Kanmantoo Tank (OpenStreetMap)',
      // Both sit at km 12: the curated waypoint leads, the OSM row reads as an
      // addendum to it.
      'Open Kennedy Creek',
      'Open Mount Crawford Camp (OpenStreetMap)',
      'Open Bakery (OpenStreetMap)',
      'Open Ridge Camp',
      'Open Unnamed water (OpenStreetMap)',
      'Open Stone Hut',
    ]);
  });

  it('badges every POI row OSM and shows its off-trail distance', () => {
    const text = allText(render());
    expect(text).toContain('OSM');
    expect(text).toContain('Food & drink');
    expect(text).toContain('0.4 km off trail');
    // No fix, so the position column is the plain cumulative km.
    expect(text).toContain('18.0 km');
  });

  it('carries the OSM credit as a footer while POI rows are on screen', () => {
    expect(allText(render())).toContain(
      'Rows marked OSM are OpenStreetMap points of interest · © OpenStreetMap contributors',
    );
  });

  it('scopes POI rows to the active chip', () => {
    const tree = render();
    pressChip(tree, 'Water');
    expect(rowLabels(tree)).toEqual([
      'Open Kanmantoo Tank (OpenStreetMap)',
      'Open Kennedy Creek',
      'Open Unnamed water (OpenStreetMap)',
    ]);
  });

  it('shows no POI rows — and no footer — under a family OSM has no counterpart for', () => {
    const tree = render();
    pressChip(tree, 'Shelter');
    expect(rowLabels(tree)).toEqual(['Open Stone Hut']);
    expect(allText(tree)).not.toContain('OpenStreetMap');
  });

  it('opens the POI detail route on tap', () => {
    const tree = render();
    const [row] = tree.root.findAll(
      (n) =>
        n.props.accessibilityLabel === 'Open Bakery (OpenStreetMap)' && n.props.onPress != null,
    );
    press(row);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/guide/[trailId]/poi/[poiKey]',
      params: { trailId: 'heysen', poiKey: 'node-3' },
    });
  });

  it('renders a trail without POIs exactly as before — waypoints only, no footer', () => {
    mockVisiblePois.mockImplementation(() => []);
    const tree = render();
    expect(rowLabels(tree)).toEqual([
      'Open Trailhead',
      'Open Kennedy Creek',
      'Open Ridge Camp',
      'Open Stone Hut',
    ]);
    expect(allText(tree)).not.toContain('OpenStreetMap');
    expect(allText(tree)).not.toContain('OSM');
  });
});
