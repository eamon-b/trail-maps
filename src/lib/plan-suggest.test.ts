import { describe, it, expect } from 'vitest';
import { newPlan, toggleStop } from './plan-editor';
import {
  applySuggestedPlan,
  defaultSuggestPrefs,
  finalDayMaxHours,
  isSuggestPrefs,
  planFloorHours,
  planWindowHours,
  suggestionCriteria,
  suggestionStart,
} from './plan-suggest';
import type { SectionConfig } from './plan-types';

const opts = { idFactory: () => 'plan-1', now: () => '2026-09-24T00:00:00.000Z' };
const section: SectionConfig = { startKm: 0, endKm: 100, startName: 'Start', endName: 'End' };

function planWith(...stops: Array<{ id: string; km: number }>) {
  return stops.reduce(
    (p, s) => toggleStop(p, { id: s.id, km: s.km, name: s.id }, opts),
    newPlan('t', 'Plan', 'NOBO', opts),
  );
}

describe('the hour bands', () => {
  it('clamps the window to 0.75–2.5 h', () => {
    expect(planWindowHours(1)).toBe(0.75);
    expect(planWindowHours(4)).toBeCloseTo(1.4);
    expect(planWindowHours(10)).toBe(2.5);
  });

  it('lets a final day run the daily hours plus the floor', () => {
    expect(planFloorHours(2)).toBe(0.75);
    expect(finalDayMaxHours(8)).toBe(10);
  });
});

describe('defaultSuggestPrefs / isSuggestPrefs', () => {
  it('derives the distance band from pace × hours', () => {
    const prefs = defaultSuggestPrefs(8, 4);
    expect(prefs.distance).toEqual({ on: true, min: 26, max: 38 });
    expect(isSuggestPrefs(prefs)).toBe(true);
  });

  it('rejects non-finite counts and malformed ranges', () => {
    const prefs = defaultSuggestPrefs(8, 4);
    expect(isSuggestPrefs({ ...prefs, days: NaN })).toBe(false);
    expect(isSuggestPrefs({ ...prefs, ascent: { on: true, min: '0', max: 1 } })).toBe(false);
    expect(isSuggestPrefs({ ...prefs, mode: 'fast' })).toBe(false);
  });
});

describe('suggestionCriteria', () => {
  it('aims hours mode at the daily hours', () => {
    expect(suggestionCriteria(defaultSuggestPrefs(8, 4), 8)).toEqual({
      hours: { min: 5.5, max: 10.5, target: 8 },
    });
  });

  it('uses only the ranges switched on, or null for none', () => {
    const prefs = { ...defaultSuggestPrefs(8, 4), mode: 'ranges' as const };
    expect(suggestionCriteria(prefs, 8)).toEqual({ distanceKm: { min: 26, max: 38 } });
    expect(suggestionCriteria({ ...prefs, distance: { ...prefs.distance, on: false } }, 8)).toBeNull();
  });
});

describe('suggestionStart', () => {
  it('prefers the located km, then the last stop, then the section start', () => {
    expect(suggestionStart(planWith({ id: 'a', km: 20 }), section, 100, 33, false).kind).toBe('here');
    expect(suggestionStart(planWith({ id: 'a', km: 20 }), section, 100, null, false)).toMatchObject({
      kind: 'stop',
      km: 20,
    });
    expect(suggestionStart(planWith(), section, 100, null, false)).toMatchObject({ kind: 'start', km: 0 });
  });

  it('ignores a location outside the section', () => {
    const narrow = { ...section, startKm: 40, endKm: 60 };
    expect(suggestionStart(planWith(), narrow, 100, 10, false)).toMatchObject({ kind: 'start', km: 40 });
  });
});

describe('applySuggestedPlan', () => {
  it('replaces the stops in its window only, in NOBO km', () => {
    const plan = planWith({ id: 'a', km: 20 }, { id: 'b', km: 30 }, { id: 'z', km: 90 });
    const next = applySuggestedPlan(plan, 20, 60, [{ id: 'c', km: 40, name: 'c' }, { id: 'd', km: 60, name: 'd' }], 100);
    expect(next.stops.map(s => s.waypointId)).toEqual(['a', 'c', 'd', 'z']);
  });

  it('converts a SOBO window before replacing', () => {
    const plan = { ...planWith({ id: 'a', km: 70 }, { id: 'b', km: 10 }), direction: 'SOBO' as const };
    // Active SOBO 20 → 50 is NOBO 80 → 50: only 'a' (NOBO 70) is inside.
    const next = applySuggestedPlan(plan, 20, 50, [], 100);
    expect(next.stops.map(s => s.waypointId)).toEqual(['b']);
  });
});
