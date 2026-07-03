import { describe, it, expect } from 'vitest';
import { KM_EPSILON, toActiveKm, toNoboKm, stopsToActive, type PlanDirection } from './plan-direction';

const TOTAL = 981.6; // Bibbulmun-ish, deliberately non-round

function round2(km: number): number {
  return Math.round(km * 100) / 100;
}

describe('toActiveKm / toNoboKm', () => {
  it('are the identity for NOBO', () => {
    expect(toActiveKm(123.45, 'NOBO', TOTAL)).toBe(123.45);
    expect(toNoboKm(123.45, 'NOBO', TOTAL)).toBe(123.45);
  });

  it('mirror about the trail total for SOBO', () => {
    expect(toActiveKm(0, 'SOBO', TOTAL)).toBe(TOTAL);
    expect(toActiveKm(TOTAL, 'SOBO', TOTAL)).toBe(0);
    expect(toActiveKm(100, 'SOBO', TOTAL)).toBeCloseTo(881.6);
    expect(toNoboKm(881.6, 'SOBO', TOTAL)).toBeCloseTo(100);
  });

  it('round-trip exactly in both directions', () => {
    for (const dir of ['NOBO', 'SOBO'] as PlanDirection[]) {
      for (const km of [0, 0.01, 12.34, TOTAL / 2, TOTAL - 0.01, TOTAL]) {
        expect(toNoboKm(toActiveKm(km, dir, TOTAL), dir, TOTAL)).toBeCloseTo(km, 10);
      }
    }
  });

  it('round-trip stays within KM_EPSILON under 2-decimal rounding', () => {
    // Simulates storing km rounded to 2 dp at each conversion boundary.
    for (const dir of ['NOBO', 'SOBO'] as PlanDirection[]) {
      for (const km of [0, 7.777, 123.456, 555.555, TOTAL - 3.333, TOTAL]) {
        const active = round2(toActiveKm(km, dir, TOTAL));
        const backToNobo = round2(toNoboKm(active, dir, TOTAL));
        expect(Math.abs(backToNobo - km)).toBeLessThan(KM_EPSILON);
      }
    }
  });
});

describe('stopsToActive', () => {
  const stops = [
    { km: 100, waypointName: 'A' },
    { km: 400.5, waypointName: 'B' },
    { km: 900, waypointName: 'C' },
  ];

  it('returns stops unchanged (but copied) for NOBO', () => {
    const active = stopsToActive(stops, 'NOBO', TOTAL);
    expect(active).toEqual(stops);
    expect(active).not.toBe(stops);
    expect(active[0]).not.toBe(stops[0]);
  });

  it('mirrors km and re-sorts ascending for SOBO', () => {
    const active = stopsToActive(stops, 'SOBO', TOTAL);
    expect(active.map(s => s.waypointName)).toEqual(['C', 'B', 'A']);
    expect(active[0].km).toBeCloseTo(TOTAL - 900);
    expect(active[1].km).toBeCloseTo(TOTAL - 400.5);
    expect(active[2].km).toBeCloseTo(TOTAL - 100);
  });

  it('preserves extra fields on each stop', () => {
    const active = stopsToActive(stops, 'SOBO', TOTAL);
    expect(active.every(s => typeof s.waypointName === 'string')).toBe(true);
  });

  it('is stable under double application (SOBO twice = original order)', () => {
    const roundTripped = stopsToActive(stopsToActive(stops, 'SOBO', TOTAL), 'SOBO', TOTAL);
    expect(roundTripped.map(s => s.waypointName)).toEqual(['A', 'B', 'C']);
    roundTripped.forEach((s, i) => expect(s.km).toBeCloseTo(stops[i].km, 10));
  });

  it('handles empty stops', () => {
    expect(stopsToActive([], 'SOBO', TOTAL)).toEqual([]);
  });
});
