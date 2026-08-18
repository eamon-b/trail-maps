/**
 * Water-status chip in the datasheet: it appears only on water waypoints that
 * have an aggregated verdict, carries the status label plus the report's age, and
 * exposes a spoken label. Theme, router, contexts, stores and the DB-backed hook
 * are mocked so this is a pure render assertion.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { WaypointListPane } from '../WaypointListPane';
import { useWaterStatus } from '../use-water-status';
import type { WaterAggregate } from '../water-aggregate';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({ trailId: 'aawt', direction: 'default' }),
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
  useWaterStatus: jest.fn(() => new Map()),
}));

// Populated per test, then handed to the mocked hook.
const waterStatus = new Map<string, WaterAggregate>();

const trail = {
  waypoints: [
    { id: 'w_creek', name: 'Kennedy Creek', type: 'creek', totalDistance: 4 },
    { id: 'w_tank', name: 'Rain Tank', type: 'water-tank', totalDistance: 9 },
    { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 12 },
    { name: 'Legacy Spring', type: 'spring', totalDistance: 15 },
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

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((n) => typeof n.props.accessibilityLabel === 'string')
    .map((n) => n.props.accessibilityLabel as string);
}

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WaypointListPane trail={trail} />);
  });
  return tree;
}

function aggregate(overrides: Partial<WaterAggregate> = {}): WaterAggregate {
  return {
    status: 'dry',
    weight: 1,
    latestAt: '2026-08-16T00:00:00.000Z',
    ageDays: 3,
    reportCount: 1,
    ...overrides,
  };
}

describe('WaypointListPane water chip', () => {
  beforeEach(() => {
    waterStatus.clear();
    (useWaterStatus as jest.MockedFunction<typeof useWaterStatus>).mockImplementation(
      () => waterStatus,
    );
  });

  it('renders no chip when there are no aggregated reports', () => {
    const tree = render();
    expect(allText(tree)).toContain('Kennedy Creek');
    expect(allText(tree)).not.toContain('Dry');
  });

  it('renders the status and age on a water waypoint with a verdict', () => {
    waterStatus.set('w_creek', aggregate({ status: 'dry', ageDays: 3 }));
    const tree = render();
    expect(allText(tree)).toContain('Dry · 3d');
    expect(labels(tree)).toContain('Water status: Dry, reported 3 days ago');
  });

  it('shows a chip per water waypoint with its own verdict', () => {
    waterStatus.set('w_creek', aggregate({ status: 'flowing', ageDays: 1 }));
    waterStatus.set('w_tank', aggregate({ status: 'low', ageDays: 40 }));
    const text = allText(render());
    expect(text).toContain('Flowing · 1d');
    expect(text).toContain('Low · 1mo');
  });

  it('never chips a non-water waypoint, even with a stray entry', () => {
    waterStatus.set('w_camp', aggregate({ status: 'flowing' }));
    const tree = render();
    expect(allText(tree)).toContain('Ridge Camp');
    expect(allText(tree)).not.toContain('Flowing');
  });

  it('ignores a waypoint with no bundled id (reports key on that id)', () => {
    waterStatus.set('Legacy Spring-3', aggregate({ status: 'dry' }));
    const tree = render();
    expect(allText(tree)).toContain('Legacy Spring');
    expect(allText(tree)).not.toContain('Dry');
  });
});
