/**
 * Shallow smoke test for the guide map.
 *
 * MapLibre is mocked to string host components (the global jest.setup mock does
 * not export CircleLayer, so a local mock adds it); tileManager and the online
 * style service are mocked so no native/network work runs. The goal is to prove
 * the "resolve style before mount" flow works — loading first, then a mounted
 * <MapView> — and that the offline/online/fallback branches pick the right
 * style source, not to verify pixel output.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { GuideMap } from '../GuideMap';
import { tileManager } from '../../../services/tile-manager';
import { getOnlineMapStyle } from '../../../services/online-style-service';

// jest.mock is hoisted above the imports above, so the mocked deps are in place
// before GuideMap's module evaluates.
jest.mock('@maplibre/maplibre-react-native', () => ({
  __esModule: true,
  MapView: 'MapView',
  Camera: 'Camera',
  ShapeSource: 'ShapeSource',
  LineLayer: 'LineLayer',
  SymbolLayer: 'SymbolLayer',
  CircleLayer: 'CircleLayer',
  default: {
    setAccessToken: jest.fn(),
    Logger: { setLogCallback: jest.fn() },
  },
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../services/tile-manager', () => ({
  tileManager: { getOfflineStyle: jest.fn() },
}));

jest.mock('../../../services/online-style-service', () => ({
  getOnlineMapStyle: jest.fn(),
}));

const getOfflineStyle = tileManager.getOfflineStyle as jest.Mock;
const getOnline = getOnlineMapStyle as jest.Mock;

/** Host-node type accessor (the ambient test-renderer types omit `.type`). */
const nodeType = (n: unknown) => (n as { type: unknown }).type;

const ONLINE_STYLE = { version: 8, sources: {}, layers: [] };
const OFFLINE_STYLE = { version: 8, sources: { basemap: {} }, layers: [] };

const points = [
  { lat: -35, lon: 138, ele: 0, dist: 0 },
  { lat: -34, lon: 139, ele: 10, dist: 1 },
];
const waypoints = [{ id: 'w_1', name: 'Spring', lat: -35, lon: 138, type: 'water' }];

/** Flush the style-resolution promise chain and re-render. */
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

const mapViews = (tree: ReactTestRenderer) => tree.root.findAll((n) => nodeType(n) === 'MapView');

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('GuideMap', () => {
  it('shows a loading state before the style resolves, then mounts the map (online)', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    // Style not resolved yet: no map mounted.
    expect(mapViews(tree)).toHaveLength(0);

    await flush();
    expect(mapViews(tree)).toHaveLength(1);
    expect(getOnline).toHaveBeenCalled();
    expect(getOfflineStyle).not.toHaveBeenCalled();
  });

  it('resolves the offline style when the source is offline', async () => {
    getOfflineStyle.mockResolvedValue(OFFLINE_STYLE);
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();
    expect(getOfflineStyle).toHaveBeenCalledWith('heysen');
    expect(getOnline).not.toHaveBeenCalled();
    expect(mapViews(tree)).toHaveLength(1);
  });

  it('falls back online when an offline pack is missing at mount time', async () => {
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} />,
      );
    });
    await flush();
    expect(getOfflineStyle).toHaveBeenCalledWith('heysen');
    expect(getOnline).toHaveBeenCalled();
    expect(mapViews(tree)).toHaveLength(1);
  });

  it('still mounts on a valid fallback style when resolution throws', async () => {
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockRejectedValue(new Error('network down'));
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} />,
      );
    });
    await flush();
    expect(mapViews(tree)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('renders trail-line and waypoint sources once mounted', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();
    const sourceIds = tree.root
      .findAll((n) => nodeType(n) === 'ShapeSource')
      .map((n) => n.props.id);
    expect(sourceIds).toContain('guide-trail-line');
    expect(sourceIds).toContain('guide-waypoints');
  });
});
