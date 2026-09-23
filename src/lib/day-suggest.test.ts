import { describe, it, expect } from 'vitest';
import { buildTimeIndex } from './day-calculator';
import { assertSearchable, measureDay, suggestDays, type SuggestDaysInput } from './day-suggest';

/** A 100 km trail, flat unless `hill` raises a stretch (1 m per 10 m of km … simple ramps). */
function track(lengthKm = 100, elevationAt: (km: number) => number = () => 100) {
  return Array.from({ length: lengthKm * 10 + 1 }, (_, i) => {
    const km = i / 10;
    return { lat: 0, lon: km * 0.009, ele: elevationAt(km), dist: km };
  });
}

interface Camp {
  km: number;
  name: string;
}

const camp = (km: number): Camp => ({ km, name: `Camp ${km}` });

function input(overrides: Partial<SuggestDaysInput<Camp>> = {}): SuggestDaysInput<Camp> {
  return {
    index: buildTimeIndex(track()),
    candidates: [10, 18, 20, 22, 30, 40, 41, 60, 62, 80].map(camp),
    fromKm: 0,
    endKm: 100,
    days: 3,
    alternatives: 3,
    criteria: { distanceKm: { min: 15, max: 25 } },
    baseKmh: 4,
    ...overrides,
  };
}

describe('assertSearchable', () => {
  it('refuses criteria without any maximum', () => {
    expect(() => assertSearchable({ distanceKm: { min: 10 } })).toThrow(/maximum/);
    expect(() => assertSearchable({})).toThrow(/maximum/);
  });

  it('accepts any one maximum', () => {
    expect(() => assertSearchable({ ascentM: { max: 800 } })).not.toThrow();
    expect(() => assertSearchable({ hours: { max: 8 } })).not.toThrow();
  });
});

describe('measureDay', () => {
  it('reads distance, climb and Naismith hours off the index', () => {
    const index = buildTimeIndex(track(100, km => (km <= 10 ? km * 60 : 600)));
    const day = measureDay(index, 0, 20, 4);
    expect(day.distanceKm).toBe(20);
    expect(day.ascentM).toBe(600);
    expect(day.descentM).toBe(0);
    expect(day.hours).toBeCloseTo(20 / 4 + 600 / 600);
  });
});

describe('suggestDays', () => {
  it('ranks whole plans by least deviation from the target', () => {
    const { plans } = suggestDays(input());
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40, 60]);
    expect(plans[0].score).toBe(0);
    expect(plans).toHaveLength(3);
    for (let i = 1; i < plans.length; i++) expect(plans[i].score).toBeGreaterThanOrEqual(plans[i - 1].score);
  });

  it('keeps every day inside every range', () => {
    const { plans } = suggestDays(input());
    for (const plan of plans) {
      for (const day of plan.days) {
        expect(day.distanceKm).toBeGreaterThanOrEqual(15);
        expect(day.distanceKm).toBeLessThanOrEqual(25);
      }
    }
  });

  it('prefers distinct plans over near-duplicates', () => {
    const { plans } = suggestDays(input());
    // 40 and 41 are the same night for the hiker; the runner-up must differ elsewhere.
    const [best, second] = plans;
    const sameShape = best.days.every((d, i) => Math.abs(d.endKm - second.days[i].endKm) < 1);
    expect(sameShape).toBe(false);
  });

  it('honours an explicit target inside the range', () => {
    const { plans } = suggestDays(input({ criteria: { distanceKm: { min: 15, max: 25, target: 18 } }, days: 1 }));
    expect(plans[0].stops[0].km).toBe(18);
  });

  it('starts from the given km, not the trail start', () => {
    const { plans } = suggestDays(input({ fromKm: 40, days: 2 }));
    expect(plans[0].days[0].startKm).toBe(40);
    expect(plans[0].stops.map(s => s.km)).toEqual([60, 80]);
  });

  it('may finish at the range end, with a short last day costing nothing', () => {
    const { plans } = suggestDays(input({ fromKm: 60, days: 3 }));
    const best = plans[0];
    expect(best.reachesEnd).toBe(true);
    expect(best.days[best.days.length - 1].end).toBeNull();
    expect(best.days[best.days.length - 1].endKm).toBe(100);
  });

  it('judges ascent as well as distance', () => {
    // A 600 m climb between km 20 and 30.
    const index = buildTimeIndex(track(100, km => (km < 20 ? 100 : km < 30 ? 100 + (km - 20) * 60 : 700)));
    const { plans } = suggestDays(
      input({ index, days: 1, criteria: { distanceKm: { max: 40 }, ascentM: { max: 300 } } }),
    );
    for (const plan of plans) expect(plan.days[0].ascentM).toBeLessThanOrEqual(300);
    expect(plans[0].stops[0].km).toBeLessThanOrEqual(25);
  });

  it('works in hours mode alone', () => {
    const { plans } = suggestDays(input({ criteria: { hours: { min: 4, max: 6, target: 5 } }, days: 2 }));
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40]);
  });

  it('reports when the criteria run out before the days do', () => {
    // No camp between 41 and 60 is 15-25 km on from 41 → only 2 days from 0 via 20/22, 40/41.
    const { plans, shortOf } = suggestDays(
      input({ candidates: [20, 40].map(camp), days: 3 }),
    );
    expect(shortOf).toBe(2);
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40]);
  });

  it('returns nothing when no first day fits', () => {
    expect(suggestDays(input({ candidates: [5].map(camp), days: 2 })).plans).toEqual([]);
  });

  it('ignores candidates behind the start or at the ends', () => {
    const { plans } = suggestDays(input({ fromKm: 30, candidates: [0, 10, 30, 50, 100].map(camp), days: 1 }));
    expect(plans.flatMap(p => p.stops.map(s => s.km))).toEqual([50]);
  });

  it('caps the alternatives asked for', () => {
    expect(suggestDays(input({ alternatives: 1 })).plans).toHaveLength(1);
  });
});
