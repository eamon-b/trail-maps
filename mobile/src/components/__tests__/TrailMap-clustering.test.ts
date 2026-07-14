// TrailMap calls MapLibreGL.setAccessToken at module scope; the global mock
// nests everything under a non-esModule shape, so provide a proper default.
import {
  WAYPOINT_CLUSTER_MAX_ZOOM,
  WAYPOINT_LABEL_MIN_ZOOM,
  WAYPOINT_CLUSTER_FILTER,
  WAYPOINT_INDIVIDUAL_FILTER,
  calculateVisibleTrackRange,
  isContourTileLoadFailure,
} from '../TrailMap';

jest.mock('@maplibre/maplibre-react-native', () => ({
  __esModule: true,
  default: {
    setAccessToken: jest.fn(),
    Logger: {
      setLogCallback: jest.fn(),
    },
    MapView: 'MapView',
    Camera: 'Camera',
    ShapeSource: 'ShapeSource',
    LineLayer: 'LineLayer',
    CircleLayer: 'CircleLayer',
    SymbolLayer: 'SymbolLayer',
  },
}));

describe('MapLibre logging', () => {
  it('recognises contour tile failures as recoverable overlay errors', () => {
    expect(isContourTileLoadFailure({
      level: 'error',
      message: 'Failed to load tile 9/466/311=>9 for source contour: HTTP status code 500',
      tag: 'Mbgl',
    })).toBe(true);
  });

  it('does not suppress unrelated MapLibre errors', () => {
    expect(isContourTileLoadFailure({
      level: 'error',
      message: 'Failed to parse style document',
      tag: 'Mbgl',
    })).toBe(false);
  });
});

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

describe('visible track range', () => {
  const points = [
    { lat: -36, lon: 147, ele: 100, dist: 0 },
    { lat: -35.5, lon: 147.5, ele: 200, dist: 10 },
    { lat: -35, lon: 148, ele: 300, dist: 20 },
    { lat: -34.5, lon: 148.5, ele: 400, dist: 30 },
  ];

  it('uses the visible bounds supplied by the region event', () => {
    expect(calculateVisibleTrackRange(points, [
      [148.1, -34.9],
      [147.4, -35.6],
    ])).toEqual([10, 20]);
  });

  it('returns null when no trail points are visible', () => {
    expect(calculateVisibleTrackRange(points, [
      [151, -32],
      [150, -33],
    ])).toBeNull();
  });

  it('ignores invalid track points instead of forwarding them to viewport state', () => {
    const invalid = [
      ...points,
      { lat: Number.NaN, lon: 147.6, ele: 0, dist: 99 },
    ];
    expect(calculateVisibleTrackRange(invalid, [
      [148.1, -34.9],
      [147.4, -35.6],
    ])).toEqual([10, 20]);
  });
});
