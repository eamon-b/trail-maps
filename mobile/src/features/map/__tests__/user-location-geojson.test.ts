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

  it('draws the fix at its real ground radius on MapLibre Native\'s 512-point tiles', () => {
    // At the equator, zoom 16: 40,075,016.686 m / (512 · 2^16) ≈ 1.194 m per
    // point, so a ±30 m fix is ≈ 25.1 points — not the ≈ 12.6 a 256-px
    // tile formula gives, which drew the uncertainty at half its size.
    const expr = accuracyCircleRadiusExpression(0);
    const z16 = expr.indexOf(16);
    const value = expr[z16 + 1] as ['min', number, ['max', number, ['*', unknown, number]]];
    const ppm = value[2][2][2];
    expect(30 * ppm).toBeCloseTo(25.13, 1);
  });

  it('grows the radius away from the equator, where a point covers less ground', () => {
    const ppmAt = (lat: number) => {
      const expr = accuracyCircleRadiusExpression(lat);
      const value = expr[expr.indexOf(16) + 1] as [string, number, [string, number, [string, unknown, number]]];
      return value[2][2][2];
    };
    // cos(60°) = 0.5: twice the points per metre.
    expect(ppmAt(60) / ppmAt(0)).toBeCloseTo(2, 6);
  });
});
