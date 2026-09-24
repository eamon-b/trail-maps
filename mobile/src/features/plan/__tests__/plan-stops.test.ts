/**
 * The Stops list's data layer: which places are offered, the NOBO ↔ active km
 * conversion that keeps a plan stable across a direction flip.
 *
 * The last test is the one that matters most end to end: ticking a stop must
 * split the day cards, since that is the entire premise of the planner.
 */

import { computePlanDays, newPlan, toggleStop } from '@lib/plan-editor';
import type { PlanTrail } from '@lib/day-calculator';
import type { PlanDocument } from '@lib/plan-types';
import { resolveGuideTrail } from '../../guide/guide-trail';
import type { TrailJson } from '../../../services/trail-assets';
import {
  planDirectionOf,
  stopCandidateOf,
  stopCandidates,
  stopKeyOf,
  toggleTargetOf,
} from '../plan-stops';

/** Flat 100 km trail: Naismith hours are distance / pace, so splits are exact. */
function trail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100,
    dist: i,
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
      { id: 't1', name: 'Townsville', lat: 0, lon: 0, type: 'town', totalDistance: 40 },
      { id: 'wt', name: 'Tank', lat: 0, lon: 0, type: 'water-tank', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'ha', name: 'Hut turn-off', lat: 0, lon: 0, type: 'hut-access', totalDistance: 70 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

function emptyPlan(direction: 'NOBO' | 'SOBO' = 'NOBO'): PlanDocument {
  return newPlan('syn', 'Synthetic', direction, { idFactory: () => 'plan-1' });
}

describe('planDirectionOf', () => {
  it('maps the guide setting onto the document enum', () => {
    expect(planDirectionOf('default')).toBe('NOBO');
    expect(planDirectionOf('reversed')).toBe('SOBO');
  });
});

describe('stopCandidates', () => {
  it('offers the places you can sleep, towns included, turn-offs never', () => {
    const names = stopCandidates(trail(), 'NOBO').map((c) => c.name);
    expect(names).toEqual(['Camp A', 'Townsville', 'Camp B']);
    // A `hut-access` is a roadside with a hut somewhere off the route.
    expect(names).not.toContain('Hut turn-off');
  });

  it('lists everything in km order under the All waypoints switch', () => {
    const all = stopCandidates(trail(), 'NOBO', { all: true });
    expect(all.map((c) => c.name)).toEqual([
      'Start',
      'Camp A',
      'Townsville',
      'Tank',
      'Camp B',
      'Hut turn-off',
      'Finish',
    ]);
    expect(all.map((c) => c.activeKm)).toEqual([0, 20, 40, 55, 60, 70, 100]);
  });

  it('carries both km spaces for a reversed guide', () => {
    // The guide trail is direction-applied, so its km count from the far end;
    // the plan stores NOBO, so the same place must map back to where it was.
    const reversed = resolveGuideTrail(trail(), 'reversed');
    const candidates = stopCandidates(reversed, 'SOBO');

    const campB = candidates.find((c) => c.name === 'Camp B')!;
    expect(campB.activeKm).toBeCloseTo(40, 6);
    expect(campB.noboKm).toBeCloseTo(60, 6);
    expect(toggleTargetOf(campB)).toEqual({ id: 'c2', km: campB.noboKm, name: 'Camp B' });

    // A stop ticked while walking SOBO is the same stop when the guide flips.
    const plan = toggleStop(emptyPlan('SOBO'), toggleTargetOf(campB));
    const nobo = stopCandidates(trail(), 'NOBO').find((c) => c.name === 'Camp B')!;
    expect(plan.stops[0].km).toBeCloseTo(nobo.noboKm, 6);
  });

  it('keys an id-less waypoint by km, not by position', () => {
    const wp = { name: 'Nameless camp', lat: 0, lon: 0, type: 'campsite', totalDistance: 12.5 };
    const candidate = stopCandidateOf(wp, 'NOBO', 100);
    expect(candidate.waypointId).toBeUndefined();
    expect(candidate.key).toBe('km:12.500');
    expect(stopKeyOf(candidate)).toEqual({ waypointId: undefined, km: 12.5 });
  });
});

describe('ticking a stop splits the days', () => {
  it('turns one day into two, at the stop', () => {
    const t = trail();
    const planTrail = t as unknown as PlanTrail;

    const before = computePlanDays(planTrail, emptyPlan());
    expect(before).toHaveLength(1);
    expect(before[0].distanceKm).toBeCloseTo(100, 3);

    const campB = stopCandidates(t, 'NOBO').find((c) => c.name === 'Camp B')!;
    const after = computePlanDays(planTrail, toggleStop(emptyPlan(), toggleTargetOf(campB)));

    expect(after).toHaveLength(2);
    expect(after[0].endName).toBe('Camp B');
    expect(after[0].distanceKm).toBeCloseTo(60, 3);
    expect(after[1].distanceKm).toBeCloseTo(40, 3);
  });

  it('pushes the later dates along when a stop is two nights', () => {
    const t = trail();
    const planTrail = t as unknown as PlanTrail;
    const campB = stopCandidates(t, 'NOBO').find((c) => c.name === 'Camp B')!;

    let plan = toggleStop(emptyPlan(), toggleTargetOf(campB));
    plan = { ...plan, startDate: '2026-10-01' };
    expect(computePlanDays(planTrail, plan).map((d) => d.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);

    plan = { ...plan, stops: [{ ...plan.stops[0], nights: 2 }] };
    const days = computePlanDays(planTrail, plan);
    expect(days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(days[0].restDays).toBe(1);
    expect(days[1].restDays).toBe(0);
  });
});
