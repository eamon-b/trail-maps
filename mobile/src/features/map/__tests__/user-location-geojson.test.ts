import {
  buildUserLocationGeoJSON,
  accuracyCircleRadiusExpression,
} from '../map-geojson';

describe('buildUserLocationGeoJSON', () => {
  it('places a point feature in [lon, lat] order with accuracy', () => {
    const f = buildUserLocationGeoJSON(-33.5, 150.2, 12);
    expect(f.geometry.coordinates).toEqual([150.2, -33.5]);
    expect(f.properties?.accuracy).toBe(12);
  });

  it('defaults a null accuracy to zero', () => {
    const f = buildUserLocationGeoJSON(0, 0, null);
    expect(f.properties?.accuracy).toBe(0);
  });
});

describe('accuracyCircleRadiusExpression', () => {
  it('is a zoom interpolate expression spanning zoom 5..20', () => {
    const expr = accuracyCircleRadiusExpression(-33);
    expect(expr[0]).toBe('interpolate');
    expect(expr[1]).toEqual(['linear']);
    expect(expr[2]).toEqual(['zoom']);
    // Header (3) + 16 zoom stops × 2 entries (stop + value).
    expect(expr.length).toBe(3 + 16 * 2);
    // First stop is zoom 5.
    expect(expr[3]).toBe(5);
    // Last stop is zoom 20.
    expect(expr[expr.length - 2]).toBe(20);
  });
});
