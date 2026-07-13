// TrailMap calls MapLibreGL.setAccessToken at module scope; the global mock
// nests everything under a non-esModule shape, so provide a proper default.
import {
  WAYPOINT_CLUSTER_MAX_ZOOM,
  WAYPOINT_LABEL_MIN_ZOOM,
  WAYPOINT_CLUSTER_FILTER,
  WAYPOINT_INDIVIDUAL_FILTER,
} from '../TrailMap';

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

describe('waypoint clustering config', () => {
  it('cluster layer filters on the supercluster point_count property', () => {
    // The ShapeSource injects `point_count` onto aggregated features; the
    // cluster bubble + count layers must match exactly those.
    expect(WAYPOINT_CLUSTER_FILTER).toEqual(['has', 'point_count']);
  });

  it('individual layer filter is the exact negation of the cluster filter', () => {
    // Every waypoint must be drawn by exactly one of the two layers — no
    // double-draw, no gaps.
    expect(WAYPOINT_INDIVIDUAL_FILTER).toEqual(['!', WAYPOINT_CLUSTER_FILTER]);
  });

  it('labels gate at the hiking-zoom threshold', () => {
    expect(WAYPOINT_LABEL_MIN_ZOOM).toBe(11);
  });

  it('cluster ceiling stays below the label gate so expanded points are labelled', () => {
    // Field-safety invariant: clustering must hand off to individual points
    // before labels (and hiking zooms) begin, so the next water source or
    // campsite can never be hidden inside a cluster bubble at hiking zoom.
    expect(WAYPOINT_CLUSTER_MAX_ZOOM).toBeLessThan(WAYPOINT_LABEL_MIN_ZOOM);
  });
});
