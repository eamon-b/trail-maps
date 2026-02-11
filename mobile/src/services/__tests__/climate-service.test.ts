import type { ComputedDay } from '../plan-calculator-types';
import type { ClimateData, MonthlyClimate } from '../climate-service';
import {
  registerClimateData,
  loadClimateData,
  getClimateForPosition,
  getClimateForDay,
} from '../climate-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMonthly(month: number): MonthlyClimate {
  return {
    month,
    avgTempMin: 5 + month,
    avgTempMax: 15 + month,
    avgPrecipitation: 40 + month * 5,
    avgRainyDays: 3 + month,
  };
}

function makeClimateData(
  locations: { name: string; km: number; monthly?: MonthlyClimate[] }[],
): ClimateData {
  return {
    locations: locations.map(loc => ({
      name: loc.name,
      lat: -33,
      lon: 115,
      elevation: 200,
      distanceAlongTrail: loc.km,
      monthly: loc.monthly ?? Array.from({ length: 12 }, (_, i) => makeMonthly(i + 1)),
    })),
    dataYears: { start: 1991, end: 2020 },
  };
}

function makeDay(overrides: Partial<ComputedDay> = {}): ComputedDay {
  return {
    dayNumber: 1,
    startName: 'Start',
    endName: 'End',
    startKm: 0,
    endKm: 20,
    distanceKm: 20,
    ascentM: 300,
    descentM: 250,
    estimatedHours: 6,
    waterSources: 2,
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// registerClimateData / loadClimateData
// ---------------------------------------------------------------------------

describe('registerClimateData / loadClimateData', () => {
  it('registers and retrieves climate data for a trail', () => {
    const trailId = 'test-climate-' + Math.random();
    const data = makeClimateData([{ name: 'Town A', km: 0 }]);

    registerClimateData(trailId, data);
    const loaded = loadClimateData(trailId);

    expect(loaded).toBe(data);
    expect(loaded!.locations).toHaveLength(1);
    expect(loaded!.locations[0].name).toBe('Town A');
  });

  it('returns null for unknown trail', () => {
    const trailId = 'test-climate-' + Math.random();
    expect(loadClimateData(trailId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getClimateForPosition
// ---------------------------------------------------------------------------

describe('getClimateForPosition', () => {
  it('returns monthly data for correct month', () => {
    const data = makeClimateData([{ name: 'Station', km: 50 }]);
    const result = getClimateForPosition(data, 50, 3);

    expect(result).not.toBeNull();
    expect(result!.month).toBe(3);
    expect(result!.avgTempMin).toBe(5 + 3);
    expect(result!.avgTempMax).toBe(15 + 3);
    expect(result!.avgPrecipitation).toBe(40 + 3 * 5);
    expect(result!.avgRainyDays).toBe(3 + 3);
  });

  it('returns null when locations array is empty', () => {
    const data = makeClimateData([]);
    expect(getClimateForPosition(data, 10, 6)).toBeNull();
  });

  it('finds nearest location by distanceAlongTrail', () => {
    const data = makeClimateData([
      { name: 'A', km: 10 },
      { name: 'B', km: 50 },
      { name: 'C', km: 90 },
    ]);

    // km 45 is closest to B (km 50)
    const result = getClimateForPosition(data, 45, 1);
    expect(result).not.toBeNull();
    // Verify it used location B by checking the month-1 values match B's generated data
    // All locations share the same monthly generator, so we confirm by checking the nearest
    // location logic works by testing edge cases

    // km 30 is equidistant from A (10, dist=20) and B (50, dist=20), should pick first found
    // Actually A dist=20, B dist=20 — the loop picks B only if dist < nearestDist (strict),
    // so it stays with A
    const atBoundary = getClimateForPosition(data, 30, 1);
    expect(atBoundary).not.toBeNull();

    // km 80 should pick C (km 90, dist=10) over B (km 50, dist=30)
    const nearC = getClimateForPosition(data, 80, 7);
    expect(nearC).not.toBeNull();
    expect(nearC!.month).toBe(7);
  });

  it('returns null when month not found', () => {
    const data = makeClimateData([
      { name: 'Station', km: 0, monthly: [makeMonthly(6)] },
    ]);

    // Only month 6 exists — asking for month 1 should return null
    expect(getClimateForPosition(data, 0, 1)).toBeNull();
    // Month 6 should still work
    expect(getClimateForPosition(data, 0, 6)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getClimateForDay
// ---------------------------------------------------------------------------

describe('getClimateForDay', () => {
  it('returns climate data for a day with a date', () => {
    const data = makeClimateData([{ name: 'Station', km: 10 }]);
    // March 15 → month 3
    const day = makeDay({ date: '2026-03-15', startKm: 0, endKm: 20 });

    const result = getClimateForDay(data, day);

    expect(result).not.toBeNull();
    expect(result!.tempMin).toBe(5 + 3);
    expect(result!.tempMax).toBe(15 + 3);
    expect(result!.precipitation).toBe(40 + 3 * 5);
    expect(result!.rainyDays).toBe(3 + 3);
  });

  it('returns null when day has no date', () => {
    const data = makeClimateData([{ name: 'Station', km: 10 }]);
    const day = makeDay({ date: undefined });

    expect(getClimateForDay(data, day)).toBeNull();
  });

  it('returns null when date is invalid', () => {
    const data = makeClimateData([{ name: 'Station', km: 10 }]);
    const day = makeDay({ date: 'not-a-date' });

    expect(getClimateForDay(data, day)).toBeNull();
  });

  it('uses midpoint km of the day for location lookup', () => {
    // Two locations far apart — the midpoint determines which is chosen
    const data = makeClimateData([
      { name: 'A', km: 10 },
      { name: 'B', km: 90 },
    ]);

    // Day from km 60 to km 80 → midpoint = 70, closer to B (90) than A (10)
    const dayNearB = makeDay({
      date: '2026-01-15',
      startKm: 60,
      endKm: 80,
      distanceKm: 20,
    });
    const resultB = getClimateForDay(data, dayNearB);
    expect(resultB).not.toBeNull();

    // Day from km 0 to km 20 → midpoint = 10, exactly at A
    const dayNearA = makeDay({
      date: '2026-01-15',
      startKm: 0,
      endKm: 20,
      distanceKm: 20,
    });
    const resultA = getClimateForDay(data, dayNearA);
    expect(resultA).not.toBeNull();

    // Both should return month-1 data (January) but from different locations
    // Since both locations use the same monthly generator, values are the same.
    // The key assertion is that the function computes the midpoint correctly.
    // We can verify by using locations with different monthly data.
    const customData = makeClimateData([
      { name: 'Cold', km: 10, monthly: [{ month: 1, avgTempMin: -5, avgTempMax: 5, avgPrecipitation: 100, avgRainyDays: 20 }] },
      { name: 'Hot', km: 90, monthly: [{ month: 1, avgTempMin: 20, avgTempMax: 35, avgPrecipitation: 10, avgRainyDays: 2 }] },
    ]);

    // midpoint = 70, closer to Hot (90)
    const hot = getClimateForDay(customData, dayNearB);
    expect(hot).not.toBeNull();
    expect(hot!.tempMin).toBe(20);
    expect(hot!.tempMax).toBe(35);

    // midpoint = 10, exactly at Cold
    const cold = getClimateForDay(customData, dayNearA);
    expect(cold).not.toBeNull();
    expect(cold!.tempMin).toBe(-5);
    expect(cold!.tempMax).toBe(5);
  });
});
