/**
 * The "Next days" card's data layer: the two modes' criteria, where a
 * suggestion starts, and that applying one touches only its own window.
 */

import { newPlan, toggleStop } from '@lib/plan-editor';
import type { PlanDocument, SectionConfig } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-assets';
import { planWindowHours } from '../plan-adapters';
import { stopCandidates, toggleTargetOf } from '../plan-stops';
import {
  applySuggestion,
  defaultSuggestPrefs,
  isSuggestPrefs,
  suggestNextDays,
  suggestionCriteria,
  suggestionStart,
} from '../plan-suggest';

/** Flat 100 km trail with camps every 20 km and a town at 40. */
function trail(): TrailJson {
  const points = Array.from({ length: 1001 }, (_, i) => ({
    lat: 0,
    lon: i * 0.0001,
    ele: 100,
    dist: i / 10,
  }));
  return {
    config: {
      id: 'syn',
      name: 'Synthetic',
      shortName: 'SYN',
      region: 'Test',
      lengthKm: 100,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'w0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 20 },
      { id: 'c1b', name: 'Camp A2', lat: 0, lon: 0, type: 'campsite', totalDistance: 24 },
      { id: 't1', name: 'Townsville', lat: 0, lon: 0, type: 'town', totalDistance: 40 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'c3', name: 'Camp C', lat: 0, lon: 0, type: 'hut', totalDistance: 80 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  } as unknown as TrailJson;
}

const section: SectionConfig = { startKm: 0, endKm: 100, startName: 'Start', endName: 'Finish' };

function plan(...ids: string[]): PlanDocument {
  const t = trail();
  const byId = new Map(stopCandidates(t, 'NOBO').map((c) => [c.waypointId, c]));
  return ids.reduce(
    (p, id) => toggleStop(p, toggleTargetOf(byId.get(id)!)),
    newPlan('syn', 'Synthetic', 'NOBO', { idFactory: () => 'plan-1' }),
  );
}

describe('defaultSuggestPrefs', () => {
  it('starts from the hiker’s own pace and hours', () => {
    const prefs = defaultSuggestPrefs(5, 4);
    expect(prefs.mode).toBe('hours');
    expect(prefs.days).toBe(3);
    expect(prefs.alternatives).toBe(3);
    expect(prefs.distance).toEqual({ on: true, min: 16, max: 24 });
    expect(prefs.hours).toEqual({ on: false, min: 4, max: 6 });
    expect(isSuggestPrefs(prefs)).toBe(true);
  });

  it('rejects a malformed blob', () => {
    expect(isSuggestPrefs({ mode: 'hours' })).toBe(false);
    expect(isSuggestPrefs(null)).toBe(false);
  });
});

describe('suggestionCriteria', () => {
  it('aims hours mode at the daily hours, within the splitter window', () => {
    const criteria = suggestionCriteria(defaultSuggestPrefs(8, 4), 8);
    const w = planWindowHours(8);
    expect(criteria).toEqual({ hours: { min: 8 - w, max: 8 + w, target: 8 } });
  });

  it('uses only the switched-on ranges in ranges mode', () => {
    const prefs = { ...defaultSuggestPrefs(5, 4), mode: 'ranges' as const };
    prefs.ascent = { on: true, min: 0, max: 500 };
    expect(suggestionCriteria(prefs, 5)).toEqual({
      distanceKm: { min: 16, max: 24 },
      ascentM: { min: 0, max: 500 },
    });
  });

  it('is null with every range off', () => {
    const prefs = { ...defaultSuggestPrefs(5, 4), mode: 'ranges' as const };
    prefs.distance = { ...prefs.distance, on: false };
    expect(suggestionCriteria(prefs, 5)).toBeNull();
  });
});

describe('suggestionStart', () => {
  it('starts from the GPS km when it is inside the section', () => {
    expect(suggestionStart(plan('c1'), section, 100, 33, false)).toMatchObject({ kind: 'here', km: 33 });
  });

  it('falls back to the last stop without a fix, or when asked', () => {
    expect(suggestionStart(plan('c1', 't1'), section, 100, null, false)).toMatchObject({
      kind: 'stop',
      km: 40,
      name: 'Townsville',
    });
    expect(suggestionStart(plan('c1'), section, 100, 33, true)).toMatchObject({ kind: 'stop', km: 20 });
  });

  it('falls back to the section start with no stops', () => {
    expect(suggestionStart(plan(), section, 100, null, false)).toMatchObject({ kind: 'start', km: 0 });
  });

  it('reads stops in the active direction', () => {
    const sobo = { ...plan('c1'), direction: 'SOBO' as const };
    // NOBO km 20 is SOBO km 80.
    expect(suggestionStart(sobo, section, 100, null, false)).toMatchObject({ kind: 'stop', km: 80 });
  });
});

describe('suggestNextDays + applySuggestion', () => {
  const prefs = { ...defaultSuggestPrefs(5, 4), days: 2, alternatives: 2 };

  it('offers ranked plans over the Stops list’s places, towns included', () => {
    const result = suggestNextDays(trail(), {
      start: { kind: 'start', km: 0, name: 'Start' },
      section,
      prefs,
      criteria: suggestionCriteria(prefs, 5)!,
      baseKmh: 4,
      direction: 'NOBO',
    });
    expect(result.plans[0].stops.map((s) => s.candidate.name)).toEqual(['Camp A', 'Townsville']);
    expect(result.plans.length).toBe(2);
  });

  it('replaces only the stops inside the chosen window', () => {
    const t = trail();
    const before = plan('c1b', 'c3');
    const result = suggestNextDays(t, {
      start: { kind: 'start', km: 0, name: 'Start' },
      section,
      prefs,
      criteria: suggestionCriteria(prefs, 5)!,
      baseKmh: 4,
      direction: 'NOBO',
    });
    const after = applySuggestion(before, 0, result.plans[0], 100);
    // Camp A2 (inside 0–40) is replaced; Camp C (80, beyond the window) stays.
    expect(after.stops.map((s) => s.waypointId)).toEqual(['c1', 't1', 'c3']);
  });

  it('writes NOBO km when the guide is reversed', () => {
    const t = trail();
    const sobo = newPlan('syn', 'Synthetic', 'SOBO', { idFactory: () => 'plan-2' });
    const chosen = {
      stops: [{ km: 60, candidate: stopCandidates(t, 'SOBO').find((c) => c.name === 'Camp B')! }],
      days: [{ endKm: 60 }],
    };
    // Active (SOBO) km 60 is NOBO km 40 — what the document stores.
    const after = applySuggestion(sobo, 40, chosen, 100);
    expect(after.stops.map((s) => s.km)).toEqual([40]);
  });
});
