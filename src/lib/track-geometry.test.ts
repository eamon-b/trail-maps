import { describe, it, expect } from 'vitest';
import {
  findNearestByDistance,
  calculateElevationBetween,
  annotateCumulativeElevation,
  hasCumulativeElevation,
} from './track-geometry';
import { simplifyToTarget } from './track-simplify';

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

describe('annotateCumulativeElevation', () => {
  const points = [
    { lat: -35, lon: 149, ele: 100, dist: 0 },
    { lat: -35.01, lon: 149, ele: 150, dist: 1 },
    { lat: -35.02, lon: 149, ele: 120, dist: 2 },
    { lat: -35.03, lon: 149, ele: 200, dist: 3 },
  ];

  it('runs the sums over every step', () => {
    const annotated = annotateCumulativeElevation(points);
    expect(annotated.map(p => p.cumAscent)).toEqual([0, 50, 50, 130]);
    expect(annotated.map(p => p.cumDescent)).toEqual([0, 0, 30, 30]);
  });

  it('leaves the input untouched', () => {
    annotateCumulativeElevation(points);
    expect(hasCumulativeElevation(points[1])).toBe(false);
  });

  it('does not climb the step into a route break', () => {
    // A ferry between index 1 and 2: the 300 m between the landings is not walked.
    const ferry = [
      { ele: 100, dist: 0 },
      { ele: 150, dist: 1 },
      { ele: 450, dist: 1 },
      { ele: 400, dist: 2 },
    ];
    const annotated = annotateCumulativeElevation(ferry, new Set([2]));
    expect(annotated.map(p => p.cumAscent)).toEqual([0, 50, 50, 50]);
    expect(annotated.map(p => p.cumDescent)).toEqual([0, 0, 0, 50]);
  });

  it('keeps every other field', () => {
    const annotated = annotateCumulativeElevation(points);
    expect(annotated[2]).toMatchObject({ lat: -35.02, lon: 149, ele: 120, dist: 2 });
  });

  it('handles an empty track', () => {
    expect(annotateCumulativeElevation([])).toEqual([]);
  });
});

describe('calculateElevationBetween with pre-computed cumulative climb', () => {
  it('takes the difference of the two ends, not a walk of the steps', () => {
    // `ele` is deliberately flat: only the cumulative pair can produce a climb,
    // so this fails if the walk is used.
    const points = [
      { ele: 0, dist: 0, cumAscent: 0, cumDescent: 0 },
      { ele: 0, dist: 5, cumAscent: 400, cumDescent: 100 },
      { ele: 0, dist: 10, cumAscent: 900, cumDescent: 250 },
    ];
    expect(calculateElevationBetween(0, 10, points)).toEqual({ gain: 900, loss: 250 });
    expect(calculateElevationBetween(5, 10, points)).toEqual({ gain: 500, loss: 150 });
  });

  it('reads the same span walked either way round', () => {
    const points = [
      { ele: 0, dist: 0, cumAscent: 0, cumDescent: 0 },
      { ele: 0, dist: 5, cumAscent: 400, cumDescent: 100 },
    ];
    expect(calculateElevationBetween(5, 0, points)).toEqual({ gain: 400, loss: 100 });
  });

  it('needs no break set: the break step is already out of the sums', () => {
    const ferry = annotateCumulativeElevation(
      [
        { ele: 100, dist: 0 },
        { ele: 150, dist: 1 },
        { ele: 450, dist: 1 },
        { ele: 400, dist: 2 },
      ],
      new Set([2]),
    );
    // No breakStarts argument, and the 300 m ferry still is not climbed.
    expect(calculateElevationBetween(0, 2, ferry)).toEqual({ gain: 50, loss: 50 });
  });

  it('falls back to the point walk when the fields are absent', () => {
    const points = [
      { ele: 100, dist: 0 },
      { ele: 150, dist: 1 },
      { ele: 120, dist: 2 },
    ];
    expect(calculateElevationBetween(0, 2, points)).toEqual({ gain: 50, loss: 30 });
  });

  it('falls back when only one end carries them', () => {
    const points = [
      { ele: 100, dist: 0 },
      { ele: 150, dist: 1, cumAscent: 9999, cumDescent: 9999 },
    ];
    expect(calculateElevationBetween(0, 1, points)).toEqual({ gain: 50, loss: 0 });
  });
});

describe('cumulative climb survives simplification', () => {
  /**
   * 4,000 points of small, real ups and downs on a wandering line. The wander
   * is a seeded random walk rather than a sine: a constant-amplitude wiggle is
   * Douglas-Peucker's worst case (every split peels a few points off one end,
   * quadratic per pass) and made this test take over a second on CI.
   */
  let seed = 97531;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let lon = 149;
  const points = Array.from({ length: 4000 }, (_, i) => {
    lon += (rand() - 0.5) * 0.0006;
    return {
      lat: -35 - i * 0.0002,
      lon,
      ele: 500 + Math.sin(i / 5) * 12 + Math.sin(i / 31) * 60,
      dist: i * 0.02,
    };
  });

  it('a thinned track annotated first reports the full-resolution climb', () => {
    const full = calculateElevationBetween(0, 79.98, points);
    const thinnedRaw = simplifyToTarget(points, 400);
    const thinnedAnnotated = simplifyToTarget(annotateCumulativeElevation(points), 400);

    // The bug: summing the steps of the thinned track loses most of the climb.
    expect(calculateElevationBetween(0, 79.98, thinnedRaw).gain).toBeLessThan(full.gain * 0.9);
    // The fix: reading the two ends of the carried sums gives the real number.
    expect(calculateElevationBetween(0, 79.98, thinnedAnnotated)).toEqual(full);
  });
});
