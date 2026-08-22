import { describe, it, expect } from 'vitest';
import { simplifyToTarget, simplifyTrack, truncatePoint, truncatePoints } from './track-simplify';
import type { TrackPoint } from './trail-types';

/** A wiggly synthetic track: a straight run with sinusoidal detours. */
function wigglyTrack(count: number): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: -33 + i * 0.0005 + Math.sin(i / 3) * 0.0002,
      lon: 151 + i * 0.0005 + Math.cos(i / 5) * 0.0002,
      ele: 100 + Math.sin(i / 20) * 50,
      dist: i * 0.06,
    });
  }
  return points;
}

describe('simplifyToTarget', () => {
  it('leaves a track already under budget untouched (same array)', () => {
    const points = wigglyTrack(50);
    expect(simplifyToTarget(points, 100)).toBe(points);
  });

  it('lands within 10% of the target point count', () => {
    const points = wigglyTrack(5000);
    const simplified = simplifyToTarget(points, 1000);
    // The binary search stops as soon as it is within 10% either way.
    expect(simplified.length).toBeLessThan(1100);
    expect(simplified.length).toBeGreaterThan(900);
  });

  it('keeps the first and last points', () => {
    const points = wigglyTrack(3000);
    const simplified = simplifyToTarget(points, 200);
    expect(simplified[0]).toBe(points[0]);
    expect(simplified[simplified.length - 1]).toBe(points[points.length - 1]);
  });

  it('returns references to the original points, so cumulative dist survives', () => {
    const points = wigglyTrack(2000);
    const simplified = simplifyToTarget(points, 400);
    for (const p of simplified) expect(points).toContain(p);
    // dist stays monotonic (it is carried, not recomputed)
    for (let i = 1; i < simplified.length; i++) {
      expect(simplified[i].dist).toBeGreaterThanOrEqual(simplified[i - 1].dist);
    }
  });

  it('handles the mobile budget on a long track', () => {
    const points = wigglyTrack(25000);
    const simplified = simplifyToTarget(points, 5000);
    expect(simplified.length).toBeLessThan(5500);
    expect(simplified.length).toBeGreaterThan(4500);
  });
});

describe('simplifyTrack', () => {
  it('returns short tracks unchanged', () => {
    const points = wigglyTrack(2);
    expect(simplifyTrack(points, 10)).toBe(points);
  });

  it('drops collinear points at a generous tolerance', () => {
    const straight: TrackPoint[] = Array.from({ length: 20 }, (_, i) => ({
      lat: -33,
      lon: 151 + i * 0.001,
      ele: 0,
      dist: i * 0.09,
    }));
    expect(simplifyTrack(straight, 5)).toHaveLength(2);
  });
});

describe('truncatePoint', () => {
  it('rounds lat/lon to 6dp and ele/dist to 1dp', () => {
    expect(truncatePoint({ lat: -33.12345678, lon: 151.87654321, ele: 123.456, dist: 7.891 })).toEqual({
      lat: -33.123457,
      lon: 151.876543,
      ele: 123.5,
      dist: 7.9,
    });
  });

  it('maps over a whole track', () => {
    expect(truncatePoints([{ lat: 1.0000004, lon: 2, ele: 3.04, dist: 4.06 }])).toEqual([
      { lat: 1, lon: 2, ele: 3, dist: 4.1 },
    ]);
  });
});
