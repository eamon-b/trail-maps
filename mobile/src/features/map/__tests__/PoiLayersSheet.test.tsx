/**
 * The layers sheet is the only place the POI filter is edited, so what it has
 * to get right is: the counts agree with what the map will draw, a category
 * with nothing to show cannot be switched on, the master switch governs the
 * rest, and the OSM provenance is stated.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Switch } from 'react-native';
import { defaultPoiFilterState, OSM_ATTRIBUTION } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { PoiLayersSheet } from '../PoiLayersSheet';
import { useSettingsStore } from '../../../state/settings-store';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), isDark: false }),
}));

const poi = (id: number, category: TrailPOI['category'], extra: Partial<TrailPOI> = {}): TrailPOI =>
  ({
    id,
    type: 'node',
    category,
    lat: -35,
    lon: 138,
    name: null,
    tags: {},
    distanceAlongTrail: id,
    distanceFromTrail: 0.1,
    ...extra,
  }) as TrailPOI;

const POIS: TrailPOI[] = [
  poi(1, 'water'),
  poi(2, 'water'),
  poi(3, 'camping'),
  // Already covered by a curated waypoint: never drawn, so never counted.
  poi(4, 'camping', { duplicateOf: 'w_1' }),
];

/** Mounted trees, torn down after each test: a live tree stays subscribed to
 *  the store, and the next test's setState would then update it outside act(). */
const mounted: ReactTestRenderer[] = [];

const render = (): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <PoiLayersSheet visible onClose={jest.fn()} pois={POIS} />,
    );
  });
  mounted.push(tree);
  return tree;
};

/** Rendered text, in tree order. */
function texts(tree: ReactTestRenderer): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as { children?: unknown } | null)?.children;
    if (children) walk(children);
  };
  walk(tree.toJSON());
  return found;
}

/** Every rendered <Switch>, keyed by its accessibility label. */
function switches(tree: ReactTestRenderer): Map<string, Record<string, unknown>> {
  return new Map(
    tree.root
      .findAllByType(Switch)
      .map((n) => [n.props.accessibilityLabel as string, n.props as Record<string, unknown>]),
  );
}

beforeEach(() => {
  useSettingsStore.setState({ poiFilter: defaultPoiFilterState() });
});

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((tree) => tree.unmount());
  });
});

describe('PoiLayersSheet', () => {
  it('lists every category with the number of markers its switch controls', () => {
    const rendered = texts(render());
    // Counts exclude the duplicate: "1 point" of camping is one pin.
    expect(rendered).toEqual(
      expect.arrayContaining(['Water', '2 points', 'Camping', '1 point', 'Emergency', '0 points']),
    );
    // All six, whether or not the trail has any.
    expect(rendered).toEqual(
      expect.arrayContaining(['Water', 'Camping', 'Resupply', 'Food & drink', 'Transport', 'Emergency']),
    );
  });

  it('says where the data comes from and how much to trust it', () => {
    const rendered = texts(render()).join(' ');
    expect(rendered).toContain('OpenStreetMap');
    expect(rendered).toContain(OSM_ATTRIBUTION);
    expect(rendered).toContain('Uncurated');
  });

  it('writes the master switch straight to the settings store', () => {
    const tree = render();
    const master = switches(tree).get('Show points of interest')!;
    expect(master.value).toBe(true);
    act(() => {
      (master.onValueChange as (v: boolean) => void)(false);
    });
    expect(useSettingsStore.getState().poiFilter.enabled).toBe(false);
  });

  it('writes a category switch straight to the settings store', () => {
    const tree = render();
    const water = switches(tree).get('Water points of interest')!;
    act(() => {
      (water.onValueChange as (v: boolean) => void)(false);
    });
    expect(useSettingsStore.getState().poiFilter.categories.water).toBe(false);
    expect(useSettingsStore.getState().poiFilter.categories.camping).toBe(true);
  });

  it('disables a category the trail has none of', () => {
    // Shown rather than hidden: "Emergency · 0 points" is the answer to "why do
    // I see none?" — but it is not something to switch on.
    const rows = switches(render());
    expect(rows.get('Emergency points of interest')!.disabled).toBe(true);
    expect(rows.get('Water points of interest')!.disabled).toBe(false);
  });

  it('disables every category while the master switch is off', () => {
    act(() => {
      useSettingsStore.setState({
        poiFilter: { ...defaultPoiFilterState(), enabled: false },
      });
    });
    const rows = switches(render());
    expect(rows.get('Water points of interest')!.disabled).toBe(true);
    expect(rows.get('Water points of interest')!.value).toBe(false);
    // ...the master itself stays usable, or there would be no way back.
    expect(rows.get('Show points of interest')!.disabled).toBeUndefined();
  });
});
