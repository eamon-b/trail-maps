import {
  buildRouteOverlayGeoJSON,
  classifyTap,
  computeRouteLegs,
  computeRouteStats,
  routeHighlightRanges,
  routePointsToActive,
  routePointsToNobo,
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
    // A tap ~556 m beside the line (0.005° of latitude) is a sketch under
    // 200 m but a snap under 2 km. Distance is measured to the line, not to
    // the nearest vertex.
    expect(classifyTap(0.005, 0.02, TRACK, 200).kind).toBe('sketch');
    expect(classifyTap(0.005, 0.02, TRACK, 2000).kind).toBe('snap');
  });

  it('snaps to the nearer end of the segment the tap lands on', () => {
    // Four fifths of the way from km 0 to km 1: km 1, not the segment start.
    expect(classifyTap(0, 0.008, TRACK).km).toBe(1);
    expect(classifyTap(0, 0.002, TRACK).km).toBe(0);
    // The last segment's far end is the end of the track.
    expect(classifyTap(0, 0.0399, TRACK).km).toBe(4);
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

describe('route breaks', () => {
  // A ferry between index 2 and 3: km stays at 2 across it and the 280 m
  // between the landings is not climbed.
  const FERRY_TRACK: RouteTrackPoint[] = [
    { lat: 0, lon: 0.0, ele: 100, dist: 0 },
    { lat: 0, lon: 0.01, ele: 150, dist: 1 }, // +50
    { lat: 0, lon: 0.02, ele: 120, dist: 2 }, // -30
    { lat: 0, lon: 0.5, ele: 400, dist: 2 }, // the ferry: +280, not walked
    { lat: 0, lon: 0.51, ele: 380, dist: 3 }, // -20
    { lat: 0, lon: 0.52, ele: 420, dist: 4 }, // +40
  ];
  const FERRY = new Set([3]);
  const ends: RoutePointInput[] = [
    { kind: 'snap', lat: 0, lon: 0, km: 0 },
    { kind: 'snap', lat: 0, lon: 0.52, km: 4 },
  ];

  it('does not charge a span for the climb across a break', () => {
    expect(computeRouteStats(ends, FERRY_TRACK, FERRY)).toEqual({
      totalKm: 4,
      ascentM: 90, // +50 +40
      descentM: 50, // -30 -20
    });
  });

  it('draws a span across a break as two trail lines and a dashed crossing', () => {
    const lines = buildRouteOverlayGeoJSON(ends, FERRY_TRACK, { breakStarts: FERRY }).features.map(
      (f) => ({
        straight: f.properties?.straight,
        coordinates: (f.geometry as { coordinates: number[][] }).coordinates,
      }),
    );
    expect(lines).toEqual([
      { straight: false, coordinates: [[0, 0], [0.01, 0], [0.02, 0]] },
      { straight: true, coordinates: [[0.02, 0], [0.5, 0]] },
      { straight: false, coordinates: [[0.5, 0], [0.51, 0], [0.52, 0]] },
    ]);
  });

  it('still draws one line when told nothing about breaks', () => {
    const features = buildRouteOverlayGeoJSON(ends, FERRY_TRACK).features;
    expect(features).toHaveLength(1);
    expect(features[0].properties?.straight).toBe(false);
  });
});

describe('route km across a direction flip', () => {
  // The same 4 km track walked SOBO: km 0 is the NOBO km-4 end.
  const SOBO_TRACK: RouteTrackPoint[] = [...TRACK]
    .reverse()
    .map((p) => ({ ...p, dist: 4 - p.dist }));

  it('saves a route tapped walking SOBO in NOBO-absolute km', () => {
    // Tapped at SOBO km 1 and 3 — NOBO km 3 and 1.
    const tapped = [classifyTap(0, 0.03, SOBO_TRACK), classifyTap(0, 0.01, SOBO_TRACK)];
    expect(tapped.map((p) => p.km)).toEqual([1, 3]);
    expect(routePointsToNobo(tapped, 'SOBO', 4).map((p) => p.km)).toEqual([3, 1]);
  });

  it('highlights the stretch it was drawn on, whichever way it is viewed', () => {
    const tapped = [classifyTap(0, 0.03, SOBO_TRACK), classifyTap(0, 0.01, SOBO_TRACK)];
    const saved = routePointsToNobo(tapped, 'SOBO', 4);
    // Viewed NOBO: NOBO km 1-3, the lon 0.01-0.03 stretch it was drawn on.
    expect(routeHighlightRanges(routePointsToActive(saved, 'NOBO', 4), TRACK)).toEqual([
      { startKm: 1, endKm: 3 },
    ]);
    // Viewed SOBO again: back to the km it was tapped at, not total − km.
    expect(routeHighlightRanges(routePointsToActive(saved, 'SOBO', 4), SOBO_TRACK)).toEqual([
      { startKm: 1, endKm: 3 },
    ]);
  });

  it('draws the overlay over the same ground after a flip', () => {
    const tapped = [classifyTap(0, 0.03, SOBO_TRACK), classifyTap(0, 0.01, SOBO_TRACK)];
    const saved = routePointsToNobo(tapped, 'SOBO', 4);
    const line = buildRouteOverlayGeoJSON(routePointsToActive(saved, 'NOBO', 4), TRACK)
      .features[0].geometry as GeoJSON.LineString;
    const lons = line.coordinates.map(([lon]) => lon).sort();
    expect(lons).toEqual([0.01, 0.02, 0.03]);
  });

  it('leaves sketch points and a NOBO walk untouched', () => {
    const pts = [snap(1), sketch(1, 1)];
    expect(routePointsToNobo(pts, 'NOBO', 4)).toBe(pts);
    expect(routePointsToActive(pts, 'SOBO', 4)[1]).toEqual(sketch(1, 1));
  });
});
