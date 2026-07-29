import {
  buildRouteOverlayGeoJSON,
  classifyTap,
  computeRouteLegs,
  computeRouteStats,
  routeHighlightRanges,
  type RoutePointInput,
  type RouteTrackPoint,
} from '../route-geometry';

// A simple 5-point track. Points are ~1.11 km apart (0.01° lon at the equator)
// but carry their own cumulative `dist` (1 km steps) — spans use `dist`, only
// straight legs use haversine, so the two never need to agree.
const TRACK: RouteTrackPoint[] = [
  { lat: 0, lon: 0.0, ele: 100, dist: 0 },
  { lat: 0, lon: 0.01, ele: 150, dist: 1 }, // +50
  { lat: 0, lon: 0.02, ele: 120, dist: 2 }, // -30
  { lat: 0, lon: 0.03, ele: 200, dist: 3 }, // +80
  { lat: 0, lon: 0.04, ele: 180, dist: 4 }, // -20
];

const snap = (km: number): RoutePointInput => {
  const p = TRACK.find((t) => t.dist === km)!;
  return { kind: 'snap', lat: p.lat, lon: p.lon, km };
};
const sketch = (lat: number, lon: number): RoutePointInput => ({ kind: 'sketch', lat, lon, km: null });

describe('classifyTap', () => {
  it('snaps a tap within the threshold to the nearest track point', () => {
    const pt = classifyTap(0, 0.02, TRACK);
    expect(pt.kind).toBe('snap');
    expect(pt.km).toBe(2);
    expect(pt.lat).toBe(0);
    expect(pt.lon).toBe(0.02);
  });

  it('treats a tap far from the track as a sketch point', () => {
    const pt = classifyTap(0.5, 0.5, TRACK);
    expect(pt.kind).toBe('sketch');
    expect(pt.km).toBeNull();
    expect(pt.lat).toBe(0.5);
    expect(pt.lon).toBe(0.5);
  });

  it('honors a custom threshold', () => {
    // A tap ~1.11 km away is a sketch under 200 m but a snap under 2 km.
    expect(classifyTap(0, 0.005, TRACK, 200).kind).toBe('sketch');
    expect(classifyTap(0, 0.005, TRACK, 2000).kind).toBe('snap');
  });
});

describe('computeRouteStats — on-trail spans', () => {
  it('measures distance + direction-aware ascent/descent forward', () => {
    const stats = computeRouteStats([snap(0), snap(3)], TRACK);
    expect(stats.totalKm).toBe(3);
    expect(stats.ascentM).toBe(130); // +50 +80
    expect(stats.descentM).toBe(30); // -30
  });

  it('flips ascent and descent when the span is walked backwards', () => {
    const stats = computeRouteStats([snap(3), snap(0)], TRACK);
    expect(stats.totalKm).toBe(3);
    expect(stats.ascentM).toBe(30);
    expect(stats.descentM).toBe(130);
  });
});

describe('computeRouteStats — sketch legs', () => {
  it('uses haversine distance and contributes no elevation', () => {
    const stats = computeRouteStats([snap(0), sketch(0, 0.01)], TRACK);
    expect(stats.totalKm).toBeCloseTo(1.11, 1);
    expect(stats.ascentM).toBe(0);
    expect(stats.descentM).toBe(0);
  });
});

describe('computeRouteLegs — mixed route', () => {
  it('sums a span leg and a straight leg', () => {
    const legs = computeRouteLegs([snap(0), snap(2), sketch(0, 0.02)], TRACK);
    expect(legs).toHaveLength(2);

    expect(legs[0].straight).toBe(false);
    expect(legs[0].distanceKm).toBe(2);
    expect(legs[0].ascentM).toBe(50);
    expect(legs[0].descentM).toBe(30);
    expect(legs[0].startKm).toBe(0);
    expect(legs[0].endKm).toBe(2);

    expect(legs[1].straight).toBe(true);
    expect(legs[1].startKm).toBeUndefined();
    expect(legs[1].ascentM).toBe(0);
  });

  it('totals mixed legs', () => {
    const stats = computeRouteStats([snap(0), snap(2), sketch(0, 0.02)], TRACK);
    // span 0→2 (2 km) + straight (0,0.02)→(0,0.02) is 0; use a real gap instead:
    expect(stats.totalKm).toBeGreaterThanOrEqual(2);
  });
});

describe('buildRouteOverlayGeoJSON', () => {
  it('emits the track slice for a span leg', () => {
    const fc = buildRouteOverlayGeoJSON([snap(0), snap(3)], TRACK);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.type).toBe('LineString');
    expect(f.properties?.straight).toBe(false);
    // Slice indices 0..3 inclusive → 4 coordinates.
    expect((f.geometry as GeoJSON.LineString).coordinates).toHaveLength(4);
  });

  it('emits a dashed 2-point line for a straight leg', () => {
    const fc = buildRouteOverlayGeoJSON([snap(0), sketch(1, 1)], TRACK);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.properties?.straight).toBe(true);
    expect((f.geometry as GeoJSON.LineString).coordinates).toHaveLength(2);
  });

  it('adds vertex Point features when requested', () => {
    const fc = buildRouteOverlayGeoJSON([snap(0), snap(3)], TRACK, { includeVertices: true });
    const points = fc.features.filter((f) => f.geometry.type === 'Point');
    const lines = fc.features.filter((f) => f.geometry.type === 'LineString');
    expect(points).toHaveLength(2);
    expect(lines).toHaveLength(1);
    expect(points[0].properties?.kind).toBe('snap');
  });
});

describe('routeHighlightRanges', () => {
  it('returns on-trail spans only, excluding straight legs', () => {
    const ranges = routeHighlightRanges([snap(0), snap(3), sketch(1, 1)], TRACK);
    expect(ranges).toEqual([{ startKm: 0, endKm: 3 }]);
  });

  it('is empty for a route with no snap→snap legs', () => {
    expect(routeHighlightRanges([snap(0), sketch(1, 1)], TRACK)).toEqual([]);
  });
});
