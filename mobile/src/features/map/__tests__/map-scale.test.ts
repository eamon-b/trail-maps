/**
 * The scale bar's maths: ground per screen point, and the round distance the
 * bar is drawn for.
 */

import { metresPerPoint, roundDown125, scaleBarFor } from '../map-scale';

describe('metresPerPoint', () => {
  it('matches Web Mercator on 512-point tiles at the equator', () => {
    expect(metresPerPoint(0, 0)).toBeCloseTo(78271.517, 2);
    expect(metresPerPoint(1, 0)).toBeCloseTo(78271.517 / 2, 2);
  });

  it('shrinks with cos(latitude)', () => {
    expect(metresPerPoint(10, 60)).toBeCloseTo(metresPerPoint(10, 0) / 2, 6);
  });
});

describe('roundDown125', () => {
  it.each([
    [1, 1],
    [1.9, 1],
    [2, 2],
    [4.99, 2],
    [5, 5],
    [9.9, 5],
    [73, 50],
    [0.34, 0.2],
  ])('%p → %p', (input, expected) => {
    expect(roundDown125(input)).toBeCloseTo(expected, 10);
  });
});

describe('scaleBarFor', () => {
  // Zoom at which one point covers exactly `mpp` metres at the equator.
  const zoomFor = (mpp: number) => Math.log2(metresPerPoint(0, 0) / mpp);

  it('picks metres below a kilometre', () => {
    const spec = scaleBarFor(zoomFor(3), 0, 'km', 100)!; // 300 m fits
    expect(spec.label).toBe('200 m');
    expect(spec.width).toBeCloseTo(200 / 3, 6);
  });

  it('switches to kilometres', () => {
    const spec = scaleBarFor(zoomFor(25), 0, 'km', 100)!; // 2.5 km fits
    expect(spec.label).toBe('2 km');
    expect(spec.width).toBeCloseTo(80, 6);
  });

  it('uses feet under a mile and miles above it', () => {
    expect(scaleBarFor(zoomFor(3), 0, 'mi', 100)!.label).toBe('500 ft');
    expect(scaleBarFor(zoomFor(100), 0, 'mi', 100)!.label).toBe('5 mi');
  });

  it('groups large counts', () => {
    expect(scaleBarFor(zoomFor(5), 0, 'mi', 100)!.label).toBe('1,000 ft');
    expect(scaleBarFor(zoomFor(30000), 0, 'km', 100)!.label).toBe('2,000 km');
  });

  it('never draws wider than the maximum', () => {
    for (let z = 0; z <= 20; z += 0.37) {
      for (const unit of ['km', 'mi'] as const) {
        const spec = scaleBarFor(z, -37.8, unit, 100)!;
        expect(spec.width).toBeLessThanOrEqual(100 + 1e-9);
        expect(spec.width).toBeGreaterThan(19);
      }
    }
  });

  it('refuses inputs that describe no scale', () => {
    expect(scaleBarFor(NaN, 0, 'km', 100)).toBeNull();
    expect(scaleBarFor(10, NaN, 'km', 100)).toBeNull();
    expect(scaleBarFor(10, 0, 'km', 0)).toBeNull();
  });
});
