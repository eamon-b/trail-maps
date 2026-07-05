import { describe, it, expect } from 'vitest';
import { KM_EPSILON, getDirectionLabel, toActiveKm, toNoboKm, stopsToActive, type PlanDirection } from './plan-direction';

const TOTAL = 981.6; // Bibbulmun-ish, deliberately non-round

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

  it('mirror floating-point error stays far inside KM_EPSILON', () => {
    // Stops are stored FROM the already-rounded build-time km, so the only
    // error KM_EPSILON has to absorb is float noise from the mirror itself.
    for (const dir of ['NOBO', 'SOBO'] as PlanDirection[]) {
      for (const km of [0, 7.77, 123.46, 555.55, TOTAL - 3.33, TOTAL]) {
        const roundTripped = toNoboKm(toActiveKm(km, dir, TOTAL), dir, TOTAL);
        expect(Math.abs(roundTripped - km)).toBeLessThan(KM_EPSILON / 1000);
      }
    }
  });
});

describe('KM_EPSILON stop-matching semantics', () => {
  it('keeps distinct waypoints >= 10 m apart distinct', () => {
    // Real neighbouring waypoints sit 10-50 m apart (e.g. Whites River Hut
    // at km 500.04 vs Munyang River water at km 500.07); conflating them
    // would make clicking one remove the other's stop.
    const hutKm = 500.04;
    const waterKm = 500.07;
    expect(Math.abs(hutKm - waterKm)).toBeGreaterThanOrEqual(KM_EPSILON);
    // Still distinct after mirroring both to SOBO.
    const hutSobo = toActiveKm(hutKm, 'SOBO', TOTAL);
    const waterSobo = toActiveKm(waterKm, 'SOBO', TOTAL);
    expect(Math.abs(hutSobo - waterSobo)).toBeGreaterThanOrEqual(KM_EPSILON);
  });

  it('still matches identical-km waypoint clusters after a mirror', () => {
    // Co-located waypoints (e.g. the Standley Chasm cluster) share the exact
    // same stored km; a stored stop must match them in either direction.
    const km = 758.23;
    const storedFromSobo = toNoboKm(toActiveKm(km, 'SOBO', TOTAL), 'SOBO', TOTAL);
    expect(Math.abs(storedFromSobo - km)).toBeLessThan(KM_EPSILON);
  });
});

describe('getDirectionLabel', () => {
  const fallbacks = { default: 'NOBO', reversed: 'SOBO' };

  it('uses trail config labels when configured', () => {
    const config = { default: 'Westbound', reversed: 'Eastbound' };
    expect(getDirectionLabel(config, 'NOBO', fallbacks)).toBe('Westbound');
    expect(getDirectionLabel(config, 'SOBO', fallbacks)).toBe('Eastbound');
  });

  it('falls back to the caller-provided labels', () => {
    expect(getDirectionLabel(undefined, 'NOBO', fallbacks)).toBe('NOBO');
    expect(getDirectionLabel(undefined, 'SOBO', { default: 'Start → End', reversed: 'End → Start' })).toBe('End → Start');
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
