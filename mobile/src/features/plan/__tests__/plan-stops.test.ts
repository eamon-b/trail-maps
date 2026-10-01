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
  stopLegs,
  toggleTargetOf,
  type StopCandidate,
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

describe('stopLegs', () => {
  // 100 km, climbing 10 m/km to km 50 and descending 10 m/km after it.
  const points = Array.from({ length: 101 }, (_, i) => ({
    dist: i,
    ele: i <= 50 ? i * 10 : 1000 - i * 10,
  }));
  const place = (km: number, key = `p${km}`): StopCandidate => ({
    key,
    waypointId: key,
    name: key,
    type: 'campsite',
    activeKm: km,
    noboKm: km,
  });
  const candidates = [place(20), place(40), place(60), place(80)];
  const withStops = (...kms: number[]): PlanDocument => ({
    ...emptyPlan(),
    stops: kms.map((km) => ({ km, waypointId: `p${km}`, name: `p${km}`, nights: 1 })),
  });
  const opts = { direction: 'NOBO' as const, totalDistance: 100, sectionStartKm: 0, points };

  it('counts from the section start while nothing is ticked', () => {
    const legs = stopLegs(candidates, undefined, opts);
    expect(legs.get('p20')).toEqual({ distanceKm: 20, ascentM: 200, descentM: 0 });
    expect(legs.get('p80')).toEqual({ distanceKm: 80, ascentM: 500, descentM: 300 });
  });

  it('resets to zero after each ticked stop; a ticked row shows its whole day', () => {
    const legs = stopLegs(candidates, withStops(40), opts);
    expect(legs.get('p40')).toEqual({ distanceKm: 40, ascentM: 400, descentM: 0 });
    expect(legs.get('p60')).toEqual({ distanceKm: 20, ascentM: 100, descentM: 100 });
    expect(legs.get('p80')).toEqual({ distanceKm: 40, ascentM: 100, descentM: 300 });
  });

  it('counts from the chosen section start', () => {
    const legs = stopLegs(candidates, undefined, { ...opts, sectionStartKm: 50 });
    expect(legs.get('p60')).toEqual({ distanceKm: 10, ascentM: 0, descentM: 100 });
    // Behind the section start: measured from the trail start.
    expect(legs.get('p20')?.distanceKm).toBe(20);
  });

  it('mirrors NOBO-stored stops onto a reversed guide', () => {
    // Walking SOBO, active km 40 is NOBO km 60 — where the stop is stored.
    const sobo = candidates.map((c) => ({ ...c, noboKm: 100 - c.activeKm }));
    const plan: PlanDocument = {
      ...emptyPlan('SOBO'),
      stops: [{ km: 60, waypointId: 'p40', name: 'p40', nights: 1 }],
    };
    const legs = stopLegs(sobo, plan, { ...opts, direction: 'SOBO' });
    expect(legs.get('p40')?.distanceKm).toBe(40);
    expect(legs.get('p60')?.distanceKm).toBe(20);
  });
});
