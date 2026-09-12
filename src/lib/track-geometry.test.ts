import { describe, it, expect } from 'vitest';
import { findNearestByDistance, calculateElevationBetween } from './track-geometry';

describe('findNearestByDistance', () => {
  const points = [0, 10, 20, 30, 40, 50].map(dist => ({ dist }));

  it('finds exact matches', () => {
    expect(findNearestByDistance(points, 20)).toBe(2);
  });

  it('finds the nearest point between two entries', () => {
    expect(findNearestByDistance(points, 22)).toBe(2);
    expect(findNearestByDistance(points, 28)).toBe(3);
  });

  it('ties resolve to the earlier point', () => {
    expect(findNearestByDistance(points, 25)).toBe(2);
  });

  it('clamps below the start', () => {
    expect(findNearestByDistance(points, -5)).toBe(0);
  });

  it('clamps beyond the end', () => {
    expect(findNearestByDistance(points, 100)).toBe(5);
  });

  it('returns 0 for an empty array', () => {
    expect(findNearestByDistance([], 10)).toBe(0);
  });

  it('returns 0 for a single point', () => {
    expect(findNearestByDistance([{ dist: 7 }], 100)).toBe(0);
  });
});

describe('calculateElevationBetween', () => {
  // Track points: 0km=100m, 1km=150m, 2km=120m, 3km=200m
  const trackPoints = [
    { ele: 100, dist: 0 },
    { ele: 150, dist: 1 },
    { ele: 120, dist: 2 },
    { ele: 200, dist: 3 },
  ];

  it('computes gain and loss for the full trail', () => {
    const { gain, loss } = calculateElevationBetween(0, 3, trackPoints);
    // 100→150 (+50), 150→120 (-30), 120→200 (+80)
    expect(gain).toBe(130);
    expect(loss).toBe(30);
  });

  it('computes for a sub-section', () => {
    const { gain, loss } = calculateElevationBetween(1, 3, trackPoints);
    // 150→120 (-30), 120→200 (+80)
    expect(gain).toBe(80);
    expect(loss).toBe(30);
  });

  it('returns 0,0 for same start/end', () => {
    const { gain, loss } = calculateElevationBetween(1, 1, trackPoints);
    expect(gain).toBe(0);
    expect(loss).toBe(0);
  });

  it('handles reversed start/end order', () => {
    const forward = calculateElevationBetween(0, 3, trackPoints);
    const backward = calculateElevationBetween(3, 0, trackPoints);
    expect(backward).toEqual(forward);
  });

  it('handles empty track points', () => {
    const { gain, loss } = calculateElevationBetween(0, 10, []);
    expect(gain).toBe(0);
    expect(loss).toBe(0);
  });
});

describe('calculateElevationBetween across a route break', () => {
  // A ferry between index 1 and 2: km does not advance across it, and the
  // 300 m between the two landings is not climbed.
  const trackPoints = [
    { ele: 100, dist: 0 },
    { ele: 150, dist: 1 }, // +50
    { ele: 450, dist: 1 }, // the ferry: +300, not walked
    { ele: 400, dist: 2 }, // -50
  ];

  it('skips the step into the first point after a break', () => {
    expect(calculateElevationBetween(0, 2, trackPoints, new Set([2]))).toEqual({
      gain: 50,
      loss: 50,
    });
  });

  it('still counts it when told nothing about breaks', () => {
    expect(calculateElevationBetween(0, 2, trackPoints)).toEqual({ gain: 350, loss: 50 });
  });
});
