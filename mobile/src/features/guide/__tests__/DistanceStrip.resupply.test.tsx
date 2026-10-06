/**
 * The distance strip's "Next resupply" chip: measured to the next planned
 * stop, with what lies beyond the turn-off — a walk in (timed with the trail)
 * or a ride (named, not timed). Everything around the chip is mocked; the
 * maths underneath (`tripAlongTrail`, `estimateHikingTime`) is real.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ResupplyStop } from '@lib/resupply-plan';
import { DistanceStrip } from '../DistanceStrip';

let mockStops: ResupplyStop[] | null = null;

// A flat 50 km line: times are pace alone (4 km/h).
const mockTrail = {
  config: { name: 'Flat' },
  track: {
    totalDistance: 50,
    points: [
      { lat: 0, lon: 0, ele: 0, dist: 0 },
      { lat: 0, lon: 0.45, ele: 0, dist: 50 },
    ],
  },
  waypoints: [],
};

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({ trailId: 'flat', direction: 'default', trail: mockTrail }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => ({
    status: 'fix',
    currentKm: 0,
    offTrailMeters: 0,
    position: { lat: 0, lon: 0 },
    error: null,
    start: jest.fn(),
    stop: jest.fn(),
  }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../plan/plan-inputs-store', () => ({
  usePlanInputsStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPaceBaseKmh: () => () => 4,
}));

jest.mock('../../plan/use-planned-resupply', () => ({
  usePlannedResupplyStops: () => mockStops,
}));

jest.mock('../../share/use-check-in-share', () => ({ useCheckInShare: () => jest.fn() }));
jest.mock('../../share/ShareIconButton', () => ({ ShareIconButton: () => null }));

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

function render(): string {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<DistanceStrip />);
  });
  return allText(tree);
}

const walk = { place: 'Spur Town', walkKm: 2, walkAscentM: 0, walkDescentM: 0, rideKm: 0 };

describe('DistanceStrip — Next resupply', () => {
  beforeEach(() => {
    mockStops = null;
  });

  it('shows no resupply chip until a plan exists', () => {
    expect(render()).not.toContain('resupply');
  });

  it('measures to a stop on the route', () => {
    mockStops = [{ km: 10, name: 'Town', optionIds: ['t'] }];
    const text = render();
    expect(text).toContain('Next resupply');
    // 10 km at 4 km/h.
    expect(text).toContain('10.0 km · ~2 h 30 min');
  });

  it('adds the walk in to an off-trail town, and times it', () => {
    mockStops = [{ km: 10, name: 'Spur Town', optionIds: ['s'], access: walk }];
    // 10 km of trail + 2 km in = 12 km at 4 km/h = 3 h.
    expect(render()).toContain('10.0 km + 2.0 km off trail · ~3 h');
  });

  it('names a hitch beyond the turn-off without timing it', () => {
    mockStops = [
      {
        km: 10,
        name: 'Hitch Town',
        optionIds: ['h'],
        access: { ...walk, walkKm: 0, rideKm: 35, rideMode: 'hitch' },
      },
    ];
    expect(render()).toContain('10.0 km + 35.0 km hitch · ~2 h 30 min');
  });

  it('says so past the last planned stop', () => {
    mockStops = [];
    expect(render()).toContain('No planned resupply ahead');
  });
});
