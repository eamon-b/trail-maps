/**
 * The trip card's line about the place being off the trail names how the
 * distance is covered when the data says: a turn-off's hitch is not a walk.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { TrailJson } from '../../../services/trail-assets';
import { TripCard } from '../TripCard';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({
    trailId: 't',
    trail: {
      track: {
        points: [
          { lat: 0, lon: 0, ele: 0, dist: 0 },
          { lat: 0, lon: 0.45, ele: 0, dist: 50 },
        ],
      },
    },
  }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => ({ status: 'fix', currentKm: 10, offTrailMeters: 0 }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../plan/plan-inputs-store', () => ({
  usePlanInputsStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPaceBaseKmh: () => () => 4,
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function text(element: React.ReactElement): string {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  const out: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, out));
  return out.join(' ');
}

describe('TripCard — the way off the trail', () => {
  it('says a hitch is a hitch', () => {
    expect(text(<TripCard placeKm={20} placeOffTrailM={35000} placeAccessMode="hitch" />)).toContain(
      'Then 35.00 km by hitch to reach it',
    );
  });

  it('calls a walk, or an unsaid way, off the trail', () => {
    expect(text(<TripCard placeKm={20} placeOffTrailM={2000} placeAccessMode="foot" />)).toContain(
      'Then 2.00 km off the trail to reach it',
    );
    expect(text(<TripCard placeKm={20} placeOffTrailM={2000} />)).toContain(
      'Then 2.00 km off the trail to reach it',
    );
  });
});

describe('TripCard — along the route as planned', () => {
  const routeTrail = {
    track: {
      points: [
        { lat: 0, lon: 0, ele: 0, dist: 0 },
        { lat: 0, lon: 0.9, ele: 0, dist: 100 },
      ],
    },
  } as unknown as TrailJson;

  it('measures from the fix on that line, not the guide snap', () => {
    // The guide reads km 10; on the planned route the hiker is at km 30.
    expect(
      text(<TripCard placeKm={70} placeOffTrailM={0} along={{ trail: routeTrail, currentKm: 30 }} />),
    ).toContain('40.0 km ahead');
  });

  it('shows nothing while the hiker is not on that line', () => {
    expect(
      text(<TripCard placeKm={70} placeOffTrailM={0} along={{ trail: routeTrail, currentKm: null }} />),
    ).toBe('');
  });
});
