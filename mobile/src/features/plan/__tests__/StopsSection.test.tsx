/**
 * The Stops list: rows are checkboxes over the plan, a ticked row opens the
 * stop editor, and the services strip says what OSM knows — including the
 * difference between "nothing here" and "we have no data for this trail".
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailPOI } from '@lib/trail-types';
import { toggleStop } from '@lib/plan-editor';
import { StopsSection } from '../StopsSection';
import type { StopCandidate } from '../plan-stops';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('');
}

function byLabel(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label);
}

/**
 * The stop rows. Filtered to host views because a Pressable surfaces the same
 * props on its element, its inner component and the host view it renders —
 * three matches per row otherwise.
 */
/**
 * A Pressable surfaces the same props on its element, its component and the
 * host node it renders, so lookups are narrowed to host nodes. The local
 * `react-test-renderer` shim does not declare `type`, hence the cast.
 */
function isHost(node: TestInstance): boolean {
  return typeof (node as unknown as { type?: unknown }).type === 'string';
}

function checked(node: TestInstance): boolean {
  return (node.props.accessibilityState as { checked: boolean }).checked;
}

function rows(tree: ReactTestRenderer) {
  return tree.root.findAll(
    (n) =>
      isHost(n) &&
      n.props.accessibilityRole === 'checkbox' &&
      // The expanded editor's "Booked" tick is a checkbox too.
      n.props.accessibilityLabel !== 'Booked',
  );
}

/** Same de-duplication for anything looked up by accessibility label. */
function hostByLabel(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll((n) => isHost(n) && n.props.accessibilityLabel === label);
}

const candidates: StopCandidate[] = [
  { key: 'w_a', waypointId: 'w_a', name: 'Ellery Creek', type: 'campsite', activeKm: 10, noboKm: 10 },
  { key: 'w_b', waypointId: 'w_b', name: 'Serpentine Chalet', type: 'campsite', activeKm: 30, noboKm: 30 },
];

const pois: TrailPOI[] = [
  {
    type: 'node',
    id: 1,
    name: 'Ellery Store',
    category: 'resupply',
    lat: -23.5,
    lon: 133.1,
    distanceAlongTrail: 10.2,
    distanceFromTrail: 120,
    tags: { shop: 'convenience' },
  } as unknown as TrailPOI,
];

function emptyPlan(): PlanDocument {
  return {
    id: 'p1',
    trailId: 'larapinta',
    name: 'Larapinta',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    updatedAt: '2026-09-20T00:00:00Z',
    version: 1,
  };
}

const noop = () => {};

function render(overrides: Partial<React.ComponentProps<typeof StopsSection>> = {}) {
  const props: React.ComponentProps<typeof StopsSection> = {
    candidates,
    plan: undefined,
    pois: undefined,
    units: 'km',
    showAll: false,
    onShowAll: noop,
    onToggle: noop,
    onNights: noop,
    onNote: noop,
    onBooked: noop,
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<StopsSection {...props} />);
  });
  return tree;
}

describe('StopsSection', () => {
  it('renders one unchecked checkbox row per candidate, with its km', () => {
    const tree = render();
    expect(rows(tree)).toHaveLength(2);
    expect(rows(tree).map(checked)).toEqual([false, false]);
    const text = allText(tree);
    expect(text).toContain('Ellery Creek');
    expect(text).toContain('30.0 km');
  });

  it('ticks the rows the plan already holds, and opens their editor', () => {
    const plan = toggleStop(emptyPlan(), { id: 'w_a', km: 10, name: 'Ellery Creek' });
    const tree = render({ plan });

    expect(rows(tree).map(checked)).toEqual([true, false]);
    // The stop editor rides along with the ticked row only.
    expect(hostByLabel(tree, 'Stop note')).toHaveLength(1);
    expect(hostByLabel(tree, 'More nights')).toHaveLength(1);
  });

  it('reports a tap with the candidate that was tapped', () => {
    const onToggle = jest.fn();
    const tree = render({ onToggle });
    act(() => (byLabel(tree, 'Serpentine Chalet')[0].props.onPress as () => void)());
    expect(onToggle).toHaveBeenCalledWith(candidates[1]);
  });

  it('routes the editor callbacks back with their candidate', () => {
    const onNights = jest.fn();
    const onBooked = jest.fn();
    const plan = toggleStop(emptyPlan(), { id: 'w_b', km: 30, name: 'Serpentine Chalet' });
    const tree = render({ plan, onNights, onBooked });

    act(() => (byLabel(tree, 'More nights')[0].props.onPress as () => void)());
    expect(onNights).toHaveBeenCalledWith(candidates[1], 2);

    act(() => (byLabel(tree, 'Booked')[0].props.onPress as () => void)());
    expect(onBooked).toHaveBeenCalledWith(candidates[1], true);
  });

  it('says services are unknown, not absent, for a trail with no POI data', () => {
    const tree = render({ pois: undefined });
    expect(allText(tree)).toContain('No OSM data for this trail');
    expect(hostByLabel(tree, 'Shop')).toHaveLength(0);
  });

  it('lights the services a nearby POI provides and greys the rest', () => {
    const tree = render({ pois });
    expect(allText(tree)).toContain('© OpenStreetMap contributors');
    // Ellery Creek (km 10) has the shop 200 m along; Serpentine Chalet does not.
    expect(hostByLabel(tree, 'Shop')).toHaveLength(1);
    expect(hostByLabel(tree, 'No shop')).toHaveLength(1);
    // Neither has water.
    expect(hostByLabel(tree, 'No water')).toHaveLength(2);
  });

  it('drives the All waypoints switch', () => {
    const onShowAll = jest.fn();
    const tree = render({ onShowAll });
    const toggle = byLabel(tree, 'Show all waypoints')[0];
    expect(toggle.props.value).toBe(false);
    act(() => (toggle.props.onValueChange as (v: boolean) => void)(true));
    expect(onShowAll).toHaveBeenCalledWith(true);
  });

  it('pages a long list rather than mounting thousands of rows', () => {
    const many: StopCandidate[] = Array.from({ length: 120 }, (_, i) => ({
      key: `w_${i}`,
      waypointId: `w_${i}`,
      name: `Camp ${i}`,
      type: 'campsite',
      activeKm: i,
      noboKm: i,
    }));
    const tree = render({ candidates: many });
    expect(rows(tree)).toHaveLength(50);

    const more = tree.root.findAll(
      (n) => typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Show more places'),
    )[0];
    act(() => (more.props.onPress as () => void)());
    expect(rows(tree)).toHaveLength(100);
  });
});
