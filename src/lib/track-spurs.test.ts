import { describe, it, expect } from 'vitest';
import { cumulativeKm, detectSelfRetraces, extractSpur, type SpurPoint } from './track-spurs';

/**
 * Synthetic fixtures run along the 133 deg meridian from lat -23, so along-track
 * km map onto latitude. The degree scale matches `distance.ts` (a spherical
 * earth of radius 6371 km) so nominal fixture km are the km the code measures.
 */
const BASE_LAT = -23;
const BASE_LON = 133;
const LAT_DEG_PER_KM = 180 / (Math.PI * 6371);
const LON_DEG_PER_KM = LAT_DEG_PER_KM / Math.cos((BASE_LAT * Math.PI) / 180);

/** A straight run of points from `fromKm` to `toKm` along the meridian. */
function leg(fromKm: number, toKm: number, stepKm = 0.1): SpurPoint[] {
  const points: SpurPoint[] = [];
  const steps = Math.round(Math.abs(toKm - fromKm) / stepKm);
  const direction = toKm >= fromKm ? 1 : -1;
  for (let i = 0; i <= steps; i++) {
    const km = fromKm + direction * i * stepKm;
    points.push({ lat: BASE_LAT + km * LAT_DEG_PER_KM, lon: BASE_LON });
  }
  return points;
}

/**
 * An out-and-back along the meridian from `fromKm` out to `toKm` and back,
 * excluding the junction point at `fromKm` (the preceding leg already ends
 * there) so it can be appended directly.
 */
function meridianOutAndBack(fromKm: number, toKm: number, stepKm = 0.1): SpurPoint[] {
  return [...leg(fromKm, toKm, stepKm).slice(1), ...leg(toKm, fromKm, stepKm).slice(1)];
}

/**
 * A branch heading east off the meridian at `atKm`, out `spurKm` and back,
 * returning to the junction point.
 */
function eastSpur(atKm: number, spurKm: number, stepKm = 0.1): SpurPoint[] {
  const points: SpurPoint[] = [];
  const steps = Math.round(spurKm / stepKm);
  const lat = BASE_LAT + atKm * LAT_DEG_PER_KM;
  for (let i = 1; i <= steps; i++) {
    points.push({ lat, lon: BASE_LON + i * stepKm * LON_DEG_PER_KM });
  }
  for (let i = steps - 1; i >= 0; i--) {
    points.push({ lat, lon: BASE_LON + i * stepKm * LON_DEG_PER_KM });
  }
  return points;
}

describe('cumulativeKm', () => {
  it('starts at zero and accumulates along the track', () => {
    const km = cumulativeKm(leg(0, 10));
    expect(km[0]).toBe(0);
    expect(km[km.length - 1]).toBeCloseTo(10, 1);
  });

  it('handles empty and single-point input', () => {
    expect(cumulativeKm([])).toEqual([]);
    expect(cumulativeKm([{ lat: -23, lon: 133 }])).toEqual([0]);
  });
});

describe('detectSelfRetraces', () => {
  it('finds nothing on a straight track', () => {
    expect(detectSelfRetraces(leg(0, 50))).toEqual([]);
  });

  it('returns nothing for degenerate input', () => {
    expect(detectSelfRetraces([])).toEqual([]);
    expect(detectSelfRetraces(leg(0, 0.1))).toEqual([]);
  });

  it('finds a terminal out-and-back at the head of the track', () => {
    // Out to 5 km, back to the start, then 40 km of through-route.
    const points = [...leg(5, 0), ...leg(0, 40).slice(1)];
    const retraces = detectSelfRetraces(points);

    expect(retraces).toHaveLength(1);
    expect(retraces[0].terminal).toBe(true);
    // Episode edges land within one point spacing of the true junction.
    expect(retraces[0].startKm).toBeCloseTo(0, 0);
    expect(retraces[0].turnaroundKm).toBeCloseTo(5, 1);
    expect(retraces[0].endKm).toBeCloseTo(10, 0);
    expect(retraces[0].retraceLengthKm).toBeCloseTo(5, 1);
  });

  it('finds a terminal out-and-back at the tail of the track', () => {
    const points = [...leg(0, 40), ...meridianOutAndBack(40, 45)];
    const retraces = detectSelfRetraces(points);

    expect(retraces).toHaveLength(1);
    expect(retraces[0].terminal).toBe(true);
    expect(retraces[0].startKm).toBeCloseTo(40, 0);
    expect(retraces[0].turnaroundKm).toBeCloseTo(45, 1);
    expect(retraces[0].endKm).toBeCloseTo(50, 0);
    expect(retraces[0].retraceLengthKm).toBeCloseTo(5, 1);
  });

  it('reports a mid-route walk-in as non-terminal (bibbulmun-shaped)', () => {
    // 20 km in, a 6 km walk-in to town and back out, then 20 km more.
    const points = [...leg(0, 20), ...eastSpur(20, 6), ...leg(20, 40).slice(1)];
    const retraces = detectSelfRetraces(points);

    expect(retraces).toHaveLength(1);
    expect(retraces[0].terminal).toBe(false);
    expect(retraces[0].startKm).toBeGreaterThan(1);
    expect(retraces[0].retraceLengthKm).toBeCloseTo(6, 0);
  });

  it('reports each of several separate retraces', () => {
    const points = [
      ...leg(0, 20),
      ...eastSpur(20, 5),
      ...leg(20, 60).slice(1),
      ...eastSpur(60, 8),
      ...leg(60, 80).slice(1),
    ];
    const retraces = detectSelfRetraces(points);

    expect(retraces).toHaveLength(2);
    expect(retraces.map(r => r.terminal)).toEqual([false, false]);
    expect(retraces[0].retraceLengthKm).toBeCloseTo(5, 0);
    expect(retraces[1].retraceLengthKm).toBeCloseTo(8, 0);
    expect(retraces[0].startKm).toBeLessThan(retraces[1].startKm);
  });

  it('ignores retraces shorter than minRetraceKm', () => {
    const points = [...leg(0, 20), ...eastSpur(20, 1.5), ...leg(20, 40).slice(1)];

    expect(detectSelfRetraces(points, { minRetraceKm: 3 })).toEqual([]);
    expect(detectSelfRetraces(points, { minRetraceKm: 1 })).toHaveLength(1);
  });

  it('does not modify the input track', () => {
    const points = [...leg(0, 20), ...eastSpur(20, 6), ...leg(20, 40).slice(1)];
    const snapshot = JSON.stringify(points);

    detectSelfRetraces(points);

    expect(JSON.stringify(points)).toBe(snapshot);
  });
});

describe('extractSpur', () => {
  it('lifts a tail spur, leaving the junction as the main route terminus', () => {
    // 40 km through-route, then a 5 km summit spur out and back.
    const points = [...leg(0, 40), ...meridianOutAndBack(40, 45)];
    const total = cumulativeKm(points).at(-1)!;

    const { trimmedMain, spurPoints } = extractSpur(points, 40, total);

    expect(cumulativeKm(trimmedMain).at(-1)).toBeCloseTo(40, 1);
    expect(cumulativeKm(spurPoints).at(-1)).toBeCloseTo(10, 1);
    // The junction point is shared: main route ends where the spur begins.
    expect(trimmedMain.at(-1)).toEqual(spurPoints[0]);
  });

  it('lifts a head spur, making the junction the new main route start', () => {
    const points = [...leg(5, 0), ...leg(0, 40).slice(1)];
    const total = cumulativeKm(points).at(-1)!;

    const { trimmedMain, spurPoints } = extractSpur(points, 0, 5);

    // The far terminus of the spur must not survive on the main route.
    expect(cumulativeKm(trimmedMain).at(-1)).toBeCloseTo(total - 5, 1);
    expect(trimmedMain[0].lat).toBeCloseTo(-23, 4);
    expect(cumulativeKm(spurPoints).at(-1)).toBeCloseTo(5, 1);
  });

  it('joins the two halves when a mid-route section is lifted', () => {
    const points = [...leg(0, 20), ...eastSpur(20, 6), ...leg(20, 40).slice(1)];
    const km = cumulativeKm(points);
    const total = km.at(-1)!;

    const { trimmedMain, spurPoints } = extractSpur(points, 20, 32);

    expect(cumulativeKm(trimmedMain).at(-1)).toBeCloseTo(total - 12, 0);
    expect(cumulativeKm(spurPoints).at(-1)).toBeCloseTo(12, 0);
  });

  it('preserves extra fields on the points it moves', () => {
    const points = leg(0, 10).map((p, i) => ({ ...p, ele: 100 + i, time: null }));

    const { trimmedMain, spurPoints } = extractSpur(points, 8, 10);

    expect(spurPoints[0].ele).toBe(trimmedMain.at(-1)!.ele);
    expect(spurPoints.every(p => typeof p.ele === 'number')).toBe(true);
  });

  it('rejects ranges it cannot honour', () => {
    const points = leg(0, 10);

    expect(() => extractSpur(points, 5, 5)).toThrow(/must be greater than/);
    expect(() => extractSpur(points, 8, 2)).toThrow(/must be greater than/);
    expect(() => extractSpur([{ lat: -23, lon: 133 }], 0, 1)).toThrow(/at least 2 points/);
    // Removing the whole track would leave nothing to walk.
    expect(() => extractSpur(points, 0.01, 10)).toThrow(/main-route point/);
  });

  it('detection alone never extracts: a mid-route retrace survives untouched', () => {
    const points = [...leg(0, 20), ...eastSpur(20, 6), ...leg(20, 40).slice(1)];
    const before = cumulativeKm(points).at(-1)!;

    const retraces = detectSelfRetraces(points);

    expect(retraces).toHaveLength(1);
    expect(retraces[0].terminal).toBe(false);
    expect(cumulativeKm(points).at(-1)).toBe(before);
    expect(points).toHaveLength(points.length);
  });
});
