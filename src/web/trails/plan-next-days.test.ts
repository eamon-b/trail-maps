/**
 * The pure half of the web "Plan the next few days" section: snapping a
 * browser fix onto the trail, running the search over the page's trail, and
 * applying a chosen plan. The page itself is `plan-next-days-page.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { newPlan, toggleStop } from '@lib/plan-editor';
import { defaultSuggestPrefs } from '@lib/plan-suggest';
import {
  applyNextDaysPlan,
  locateOnTrail,
  suggestForTrail,
  type NextDaysTrail,
} from './plan-next-days';

/** 100 km flat, one point per 100 m along the equator; camps every 10 km from 20. */
function trail(): NextDaysTrail {
  const points = Array.from({ length: 1001 }, (_, i) => ({
    lat: 0,
    lon: (i / 10) / 111.32,
    ele: 100,
    dist: i / 10,
  }));
  const camp = (km: number) => ({
    id: `c${km}`,
    name: `Camp ${km}`,
    type: 'campsite',
    totalDistance: km,
    lat: 0,
    lon: km / 111.32,
  });
  return {
    config: { name: 'Fixture' },
    track: { points, totalDistance: 100 },
    waypoints: [20, 30, 40, 50, 60, 70, 80].map(camp),
  } as NextDaysTrail;
}

const start = { kind: 'start' as const, km: 0, name: 'Start' };
const opts = { idFactory: () => 'p', now: () => '2026-09-24T00:00:00.000Z' };

describe('locateOnTrail', () => {
  it('snaps a fix to the nearest track km and says how far off it is', () => {
    const located = locateOnTrail(trail(), 0.01, 42 / 111.32)!;
    expect(located.km).toBeCloseTo(42, 1);
    expect(located.offTrailMeters).toBeGreaterThan(1000);
    expect(located.offTrailMeters).toBeLessThan(1200);
  });
});

describe('suggestForTrail', () => {
  it('ranks plans at the hiker’s hours and pace', () => {
    // 5 h at 4 km/h = 20 km days.
    const result = suggestForTrail(trail(), start, defaultSuggestPrefs(5, 4), 5, 4)!;
    expect(result.plans[0].stops.map(s => s.waypoint.name)).toEqual(['Camp 20', 'Camp 40', 'Camp 60']);
    // ±1.75 h around 5 h is 13–27 km a day: with camps 10 km apart only the
    // 20 km steps fit, so there is exactly one plan.
    expect(result.plans).toHaveLength(1);
  });

  it('returns null when the ranges give nothing to search against', () => {
    const prefs = { ...defaultSuggestPrefs(5, 4), mode: 'ranges' as const };
    prefs.distance = { ...prefs.distance, on: false };
    expect(suggestForTrail(trail(), start, prefs, 5, 4)).toBeNull();
  });
});

describe('applyNextDaysPlan', () => {
  it('writes the chosen stops and keeps one beyond the window', () => {
    const t = trail();
    const result = suggestForTrail(t, start, { ...defaultSuggestPrefs(5, 4), days: 2 }, 5, 4)!;
    const before = toggleStop(newPlan('fx', 'Plan', 'NOBO', opts), { id: 'c80', km: 80, name: 'Camp 80' }, opts);
    const after = applyNextDaysPlan(before, 0, result.plans[0], 100);
    expect(after.stops.map(s => s.waypointId)).toEqual(['c20', 'c40', 'c80']);
  });

  it('stores NOBO km on a SOBO plan', () => {
    const t = trail();
    const result = suggestForTrail(t, start, { ...defaultSuggestPrefs(5, 4), days: 1 }, 5, 4)!;
    const sobo = newPlan('fx', 'Plan', 'SOBO', opts);
    // The fixture stands in for the reversed trail: active km 20 is NOBO km 80.
    expect(applyNextDaysPlan(sobo, 0, result.plans[0], 100).stops.map(s => s.km)).toEqual([80]);
  });
});
