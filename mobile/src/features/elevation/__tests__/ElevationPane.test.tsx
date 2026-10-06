/**
 * The pane's POI wiring: which markers reach the profile, and where a tap on
 * one goes.
 *
 * `ElevationProfile` is mocked to a props recorder — Skia, gestures and layout
 * are the profile's own tests' business; what matters here is the 60 km gate on
 * the POI ticks and the two tap destinations.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ElevationPane } from '../ElevationPane';
import type { ElevationProfileProps } from '../ElevationProfile';
import type { TrailPOI } from '@lib/trail-types';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
  useReduceMotion: () => false,
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../../guide/GuideContext', () => ({
  useGuide: () => ({ trailId: 'heysen', trail: mockTrail, direction: mockDirection }),
}));

jest.mock('../../guide/GuidePositionContext', () => ({
  useGuidePositionContext: () => ({ currentKm: null }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../../state/favorites-store', () => ({
  useFavoritesStore: (selector: (s: unknown) => unknown) => selector({ byTrail: {} }),
}));

jest.mock('../../routes/routes-store', () => ({
  useRoutesStore: (selector: (s: unknown) => unknown) =>
    selector({ activePointsByTrail: { heysen: mockActivePoints } }),
}));

jest.mock('../../guide/use-visible-pois', () => ({
  useVisiblePois: () => mockVisiblePois,
}));

// Props of the most recent ElevationProfile render.
const mockProfileProps: ElevationProfileProps[] = [];
jest.mock('../ElevationProfile', () => ({
  ElevationProfile: (props: ElevationProfileProps) => {
    mockProfileProps.push(props);
    return null;
  },
}));

function poi(overrides: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 9,
    type: 'node',
    category: 'water',
    lat: -35,
    lon: 138,
    name: 'Rain tank',
    tags: {},
    distanceAlongTrail: 30,
    distanceFromTrail: 0.1,
    ...overrides,
  };
}

const mockTrail = {
  track: {
    totalDistance: 100,
    displayPoints: Array.from({ length: 101 }, (_, i) => ({
      lat: 0,
      lon: 0,
      dist: i,
      ele: 100 + i,
    })),
  },
  waypoints: [{ id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 12 }],
} as unknown as TrailJson;

let mockVisiblePois: TrailPOI[] = [];
let mockDirection: 'default' | 'reversed' = 'default';
let mockActivePoints: { kind: 'snap'; lat: number; lon: number; km: number }[] | undefined;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ElevationPane />);
  });
  return tree;
}

/** The props of the last profile render. */
function lastProps(): ElevationProfileProps {
  return mockProfileProps[mockProfileProps.length - 1];
}

describe('ElevationPane POI ticks', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockPush.mockClear();
    mockVisiblePois = [poi()];
  });

  it('withholds POI markers while the whole 100 km trail is in view', () => {
    const tree = render();
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('appends them once the window is 60 km or narrower', () => {
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 70 }));
    expect(lastProps().waypoints).toEqual([
      expect.objectContaining({ id: 'w_camp' }),
      // Elevation sampled off the track at km 30.
      { id: 'node-9', kind: 'poi', type: 'water', totalDistance: 30, elevation: 130 },
    ]);

    // …and drops them again when the walker zooms back out.
    act(() => lastProps().onWindowChange({ startKm: 0, endKm: 100 }));
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('passes nothing extra when the filter hides every POI', () => {
    mockVisiblePois = [];
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 20 }));
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('routes a POI tap to the POI screen and a waypoint tap to the waypoint screen', () => {
    const tree = render();
    act(() => lastProps().onWaypointTap?.('node-9', 'poi'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/guide/[trailId]/poi/[poiKey]',
      params: { trailId: 'heysen', poiKey: 'node-9' },
    });

    act(() => lastProps().onWaypointTap?.('w_camp', 'waypoint'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/guide/[trailId]/waypoint/[waypointId]',
      params: { trailId: 'heysen', waypointId: 'w_camp' },
    });
    act(() => tree.unmount());
  });
});

/** Whether the chip shows its hint, i.e. no readout is on screen. */
function hintShown(tree: ReactTestRenderer): boolean {
  return tree.root.findAll((n) => n.props.children === 'Tap to read off · pinch to zoom · drag to pan')
    .length > 0;
}

describe('ElevationPane across a direction flip', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockVisiblePois = [];
    mockDirection = 'default';
    mockActivePoints = undefined;
  });

  it('mirrors the zoom window so it stays on the same stretch of ground', () => {
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 30 }));
    act(() => lastProps().onScrub?.({ km: 20, ele: 120 }));
    expect(hintShown(tree)).toBe(false);

    mockDirection = 'reversed';
    act(() => tree.update(<ElevationPane />));
    expect(lastProps().window).toEqual({ startKm: 70, endKm: 90 });
    // The readout named a km of the old numbering; it is cleared, not kept.
    expect(hintShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('shades a saved route over the km it was drawn at, in either direction', () => {
    // Saved NOBO-absolute: km 10 → 20.
    mockActivePoints = [
      { kind: 'snap', lat: 0, lon: 0, km: 10 },
      { kind: 'snap', lat: 0, lon: 0, km: 20 },
    ];
    const tree = render();
    expect(lastProps().highlightRanges).toEqual([{ startKm: 10, endKm: 20 }]);

    mockDirection = 'reversed';
    act(() => tree.update(<ElevationPane />));
    expect(lastProps().highlightRanges).toEqual([{ startKm: 80, endKm: 90 }]);
    act(() => tree.unmount());
  });
});
