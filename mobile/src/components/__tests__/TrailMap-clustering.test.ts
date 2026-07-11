// TrailMap calls MapLibreGL.setAccessToken at module scope; the global mock
// nests everything under a non-esModule shape, so provide a proper default.
jest.mock('@maplibre/maplibre-react-native', () => ({
  __esModule: true,
  default: {
    setAccessToken: jest.fn(),
    MapView: 'MapView',
    Camera: 'Camera',
    ShapeSource: 'ShapeSource',
    LineLayer: 'LineLayer',
    CircleLayer: 'CircleLayer',
    SymbolLayer: 'SymbolLayer',
  },
}));

import { WAYPOINT_CLUSTER_MAX_ZOOM, isClusteredZoom } from '../TrailMap';

describe('waypoint clustering thresholds', () => {
  it('clusters only at zoomed-out overview levels', () => {
    expect(isClusteredZoom(4)).toBe(true);
    expect(isClusteredZoom(8)).toBe(true);
    expect(isClusteredZoom(WAYPOINT_CLUSTER_MAX_ZOOM)).toBe(true);
  });

  it('never clusters at hiking zooms (labels gate at 11, follow zoom is 14)', () => {
    expect(isClusteredZoom(WAYPOINT_CLUSTER_MAX_ZOOM + 1)).toBe(false);
    expect(isClusteredZoom(11)).toBe(false);
    expect(isClusteredZoom(14)).toBe(false);
    expect(isClusteredZoom(18)).toBe(false);
  });

  it('cluster ceiling stays below the label gate so expanded points are labeled', () => {
    // Labels render at zoom >= 11; clustering must hand off before that
    expect(WAYPOINT_CLUSTER_MAX_ZOOM).toBeLessThan(11);
  });
});
