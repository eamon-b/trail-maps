/**
 * Resupply planning: options → selection → legs.
 *
 * Every expected number here is hand-computed from the synthetic tracks below,
 * so a change in Naismith, food weight or the break rule fails loudly rather
 * than quietly re-baselining.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  allResupplyOptionIds,
  listResupplyOptions,
  plannedResupplyIds,
  resolveResupplyStops,
  computeResupplyLegs,
  summariseResupplyLegs,
  type ResupplyCandidateWaypoint,
} from './resupply-plan';
import type { PlanTrail } from './day-calculator';
import type { ComputedDay } from './plan-types';

/** A dead-flat track, one point per km. Naismith reduces to distance / baseKmh. */
function flatTrail(totalKm: number): PlanTrail {
  const points = [];
  for (let km = 0; km <= totalKm; km++) {
    points.push({ lat: -35, lon: 149 + km / 1000, ele: 0, dist: km });
  }
  return { config: { name: 'Flat' }, track: { points, totalDistance: totalKm } };
}

/**
 * Two 2 km stretches either side of a route break. The break itself adds no km
 * (both its ends sit at km 2) and its 800 m step up is not walked.
 */
const BREAK_POINTS = [
  { lat: -35, lon: 149.0, ele: 0, dist: 0 },
  { lat: -35, lon: 149.1, ele: 100, dist: 1 },
  { lat: -35, lon: 149.2, ele: 200, dist: 2 },
  { lat: -35, lon: 149.5, ele: 1000, dist: 2 }, // first point after the break
  { lat: -35, lon: 149.6, ele: 1100, dist: 3 },
  { lat: -35, lon: 149.7, ele: 1200, dist: 4 },
];

function brokenTrail(withBreaks: boolean): PlanTrail {
  return {
    config: { name: 'Ferry' },
    track: {
      points: BREAK_POINTS,
      totalDistance: 4,
      breaks: withBreaks ? [{ index: 3, displayIndex: 3 }] : undefined,
    },
  };
}

describe('listResupplyOptions', () => {
  it('groups options at exactly the threshold and splits just past it', () => {
    const waypoints: ResupplyCandidateWaypoint[] = [
      { id: 'a', name: 'Alpha', type: 'town', totalDistance: 10 },
      { id: 'b', name: 'Bravo', type: 'town-access', totalDistance: 10.1 },
      { id: 'c', name: 'Charlie', type: 'food', totalDistance: 10.2001 },
    ];

    const groups = listResupplyOptions(waypoints);

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('a');
    expect(groups[0].km).toBe(10);
    expect(groups[0].options.map(o => o.id)).toEqual(['a', 'b']);
    expect(groups[1].key).toBe('c');
    expect(groups[1].options.map(o => o.id)).toEqual(['c']);
  });

  it('chains a run of near neighbours into one group', () => {
    // Each is within 0.1 km of the *previous* one, so all three are one turn-off.
    const groups = listResupplyOptions([
      { id: 'a', name: 'Alpha', type: 'town', totalDistance: 10 },
      { id: 'b', name: 'Bravo', type: 'town', totalDistance: 10.1 },
      { id: 'c', name: 'Charlie', type: 'town', totalDistance: 10.2 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].options.map(o => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('honours a wider groupWithinKm', () => {
    const waypoints: ResupplyCandidateWaypoint[] = [
      { id: 'a', name: 'Alpha', type: 'town', totalDistance: 10 },
      { id: 'b', name: 'Bravo', type: 'town', totalDistance: 10.4 },
    ];

    expect(listResupplyOptions(waypoints)).toHaveLength(2);
    expect(listResupplyOptions(waypoints, { groupWithinKm: 0.5 })).toHaveLength(1);
  });

  it('sorts by km before grouping', () => {
    const groups = listResupplyOptions([
      { id: 'far', name: 'Far', type: 'town', totalDistance: 200 },
      { id: 'near', name: 'Near', type: 'town', totalDistance: 50 },
    ]);

    expect(groups.map(g => g.key)).toEqual(['near', 'far']);
  });

  it('labels a group with the first accessName in it, and leaves a plain town null', () => {
    const groups = listResupplyOptions([
      { id: 'store', name: 'Crest Store', type: 'resupply', totalDistance: 100 },
      {
        id: 'town',
        name: 'Salida',
        type: 'town-access',
        totalDistance: 100,
        accessName: '  Monarch Pass (US 50)  ',
      },
      { id: 'plain', name: 'Riverton', type: 'town', totalDistance: 300 },
    ]);

    expect(groups[0].label).toBe('Monarch Pass (US 50)');
    expect(groups[1].label).toBeNull();
  });

  it('carries the off-trail fields through', () => {
    const groups = listResupplyOptions([
      {
        id: 'a',
        name: 'Alpha',
        type: 'town-access',
        totalDistance: 10,
        offTrailKm: 35.4,
        accessMode: 'hitch',
        acceptsBoxes: true,
        description: 'Leave the CDT here.',
      },
    ]);

    expect(groups[0].options[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      type: 'town-access',
      km: 10,
      offTrailKm: 35.4,
      accessMode: 'hitch',
      acceptsBoxes: true,
      description: 'Leave the CDT here.',
    });
  });

  it('drops an unusable access mode or off-trail distance rather than passing it on', () => {
    // Handed-off and imported JSON can carry anything under these keys.
    const groups = listResupplyOptions([
      {
        id: 'b',
        name: 'Bravo',
        type: 'town-access',
        totalDistance: 50,
        accessMode: 'teleport' as never,
        offTrailKm: Number.NaN,
      },
    ]);

    expect(groups[0].options[0].accessMode).toBeUndefined();
    expect(groups[0].options[0].offTrailKm).toBeUndefined();
  });

  it('skips non-resupply types, id-less waypoints and unplaced ones', () => {
    const groups = listResupplyOptions([
      { id: 'water', name: 'Creek', type: 'water', totalDistance: 10 },
      { id: 'hut', name: 'Hut', type: 'hut', totalDistance: 20 },
      { name: 'No id', type: 'town', totalDistance: 30 },
      { id: '', name: 'Empty id', type: 'town', totalDistance: 35 },
      { id: 'nokm', name: 'Unplaced', type: 'town' },
      { id: 'nan', name: 'Broken', type: 'town', totalDistance: Number.NaN },
      { id: 'ok', name: 'Town', type: 'town', totalDistance: 40 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].options.map(o => o.id)).toEqual(['ok']);
  });

  it('returns nothing for missing or empty waypoints', () => {
    expect(listResupplyOptions(undefined)).toEqual([]);
    expect(listResupplyOptions([])).toEqual([]);
  });
});

describe('resolveResupplyStops', () => {
  const groups = listResupplyOptions([
    { id: 'salida', name: 'Salida', type: 'town-access', totalDistance: 100 },
    { id: 'poncha', name: 'Poncha Springs', type: 'resupply-access', totalDistance: 100 },
    { id: 'lake', name: 'Lake City', type: 'town', totalDistance: 300 },
  ]);

  it('ticks everything when no selection has been made', () => {
    const stops = resolveResupplyStops(groups, undefined);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({
      km: 100,
      name: 'Salida / Poncha Springs',
      optionIds: ['salida', 'poncha'],
    });
    expect(stops[1].name).toBe('Lake City');
  });

  it('collapses two ticked options in one group into a single stop', () => {
    const stops = resolveResupplyStops(groups, ['poncha', 'salida', 'lake']);

    expect(stops).toHaveLength(2);
    // Joined in option order, not selection order.
    expect(stops[0].name).toBe('Salida / Poncha Springs');
    expect(stops[0].optionIds).toEqual(['salida', 'poncha']);
  });

  it('drops a group with nothing ticked', () => {
    const stops = resolveResupplyStops(groups, ['poncha']);

    expect(stops).toHaveLength(1);
    expect(stops[0]).toEqual({ km: 100, name: 'Poncha Springs', optionIds: ['poncha'] });
  });

  it('ignores ids the trail no longer has', () => {
    expect(resolveResupplyStops(groups, ['lake', 'w_gone'])).toHaveLength(1);
    expect(resolveResupplyStops(groups, ['w_gone'])).toEqual([]);
  });

  it('treats an explicit empty selection as a real choice', () => {
    expect(resolveResupplyStops(groups, [])).toEqual([]);
  });
});

describe('allResupplyOptionIds', () => {
  const groups = listResupplyOptions([
    { id: 'salida', name: 'Salida', type: 'town-access', totalDistance: 100 },
    { id: 'poncha', name: 'Poncha Springs', type: 'resupply-access', totalDistance: 100 },
    { id: 'lake', name: 'Lake City', type: 'town', totalDistance: 300 },
  ]);

  it('flattens the groups in walking order', () => {
    expect(allResupplyOptionIds(groups)).toEqual(['salida', 'poncha', 'lake']);
  });

  it('is empty for a trail with no options', () => {
    expect(allResupplyOptionIds([])).toEqual([]);
  });
});

describe('plannedResupplyIds', () => {
  // Te Araroa's shape: the town itself and the turn-off you leave the route at
  // are two waypoints in one group.
  const groups = listResupplyOptions([
    { id: 'keri', name: 'Kerikeri', type: 'town', totalDistance: 100 },
    { id: 'keri_off', name: 'Kerikeri turnoff', type: 'town-access', totalDistance: 100 },
    { id: 'lake', name: 'Lake City', type: 'town', totalDistance: 300 },
    { id: 'lake_off', name: 'Lake City turnoff', type: 'town-access', totalDistance: 300 },
  ]);

  it('says nothing is planned until a plan is made', () => {
    expect(plannedResupplyIds(groups, null)).toBeNull();
  });

  it('plans the turn-off of any group with a ticked option', () => {
    // Only the town is ticked, but the food has to reach the turn-off.
    expect([...plannedResupplyIds(groups, new Set(['keri']))!].sort()).toEqual(['keri', 'keri_off']);
  });

  it('leaves an untouched group alone', () => {
    const planned = plannedResupplyIds(groups, new Set(['keri']))!;
    expect(planned.has('lake')).toBe(false);
    expect(planned.has('lake_off')).toBe(false);
  });

  it('plans a turn-off ticked on its own without dragging the town in', () => {
    expect([...plannedResupplyIds(groups, new Set(['keri_off']))!]).toEqual(['keri_off']);
  });

  it('drops ids no group has', () => {
    expect([...plannedResupplyIds(groups, new Set(['w_gone']))!]).toEqual([]);
  });

  it('plans nothing for an explicit empty selection', () => {
    expect([...plannedResupplyIds(groups, new Set())!]).toEqual([]);
  });

  // The CDT's shape: the off-route town *itself* is access-typed, so two towns a
  // hitch apart share one group. Monarch Pass, as the data actually ships it.
  describe('two towns on one hitch', () => {
    const monarch = listResupplyOptions([
      {
        id: 'w_bfb496d7',
        name: 'Monarch Pass (Monarch Crest Store)',
        type: 'resupply',
        totalDistance: 3098.1,
        offTrailKm: 0.2,
        accessMode: 'on-trail',
      },
      {
        id: 'w_aebb7c21',
        name: 'Salida (access: Monarch Pass (US 50))',
        type: 'town-access',
        totalDistance: 3098.1,
        offTrailKm: 35.4,
        accessMode: 'hitch',
        accessName: 'Monarch Pass (US 50)',
      },
      {
        id: 'w_25c0134e',
        name: 'Poncha Springs (access: Monarch Pass (US 50))',
        type: 'resupply-access',
        totalDistance: 3098.1,
        offTrailKm: 27.4,
        accessMode: 'hitch',
        accessName: 'Monarch Pass (US 50)',
      },
    ]);

    it('is one group', () => {
      expect(monarch).toHaveLength(1);
    });

    it('plans only the town that was ticked, never its off-route twin', () => {
      const planned = plannedResupplyIds(monarch, new Set(['w_aebb7c21']))!;
      expect([...planned]).toEqual(['w_aebb7c21']);
      expect(planned.has('w_25c0134e')).toBe(false);
    });

    it('leaves the on-trail store out of a plan that did not tick it', () => {
      const planned = plannedResupplyIds(monarch, new Set(['w_25c0134e']))!;
      expect([...planned]).toEqual(['w_25c0134e']);
    });
  });

  // Te Araroa records the pair twice, and both records carry the same off-trail
  // distance: the town's is how far it is, the turn-off's is how far it is to it.
  describe('a place recorded as both a destination and a turn-off', () => {
    const kerikeri = listResupplyOptions([
      {
        id: 'w_fd2ca336',
        name: 'Kerikeri turnoff',
        type: 'town-access',
        totalDistance: 221.3,
        offTrailKm: 0.7,
      },
      { id: 'w_0ed51431', name: 'Kerikeri', type: 'town', totalDistance: 221.3, offTrailKm: 0.7 },
    ]);

    it('plans the turn-off alongside the town it serves', () => {
      expect([...plannedResupplyIds(kerikeri, new Set(['w_0ed51431']))!].sort()).toEqual([
        'w_0ed51431',
        'w_fd2ca336',
      ]);
    });

    it('plans a turn-off ticked on its own without dragging the town in', () => {
      expect([...plannedResupplyIds(kerikeri, new Set(['w_fd2ca336']))!]).toEqual(['w_fd2ca336']);
    });
  });

  it('keeps one road junction with several destinations apart', () => {
    // Te Araroa's Rangitata: four turn-offs at one km, each for a different
    // place, each its own distance away.
    const rangitata = listResupplyOptions([
      { id: 'geraldine', name: 'Geraldine turnoff', type: 'town-access', totalDistance: 1500, offTrailKm: 70 },
      { id: 'peel', name: 'Peel Forest turnoff', type: 'resupply-access', totalDistance: 1500, offTrailKm: 50 },
      { id: 'meso', name: 'Mesopotamia Station turnoff', type: 'food-access', totalDistance: 1500, offTrailKm: 2.5 },
    ]);

    expect(rangitata).toHaveLength(1);
    expect([...plannedResupplyIds(rangitata, new Set(['geraldine']))!]).toEqual(['geraldine']);
  });

  it('pulls in a turn-off with an off-trail distance of zero', () => {
    // A generator that writes 0 rather than omitting the field means the same
    // thing: the point is on the route.
    const zeroed = listResupplyOptions([
      { id: 'town', name: 'Town', type: 'town', totalDistance: 10, offTrailKm: 2 },
      { id: 'off', name: 'Town turnoff', type: 'town-access', totalDistance: 10, offTrailKm: 0 },
    ]);

    expect([...plannedResupplyIds(zeroed, new Set(['town']))!].sort()).toEqual(['off', 'town']);
  });
});

describe('computeResupplyLegs', () => {
  it('refuses a pace or hours figure it would otherwise have to invent', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 40 }]),
      undefined
    );
    const call = (opts: Record<string, unknown>) =>
      () => computeResupplyLegs(flatTrail(100), stops, opts as never);

    // No baseKmh at all — the old silent 4 km/h.
    expect(call({ dailyHours: 8 })).toThrow(RangeError);
    expect(call({ dailyHours: 8 })).toThrow(/baseKmh/);
    expect(call({ baseKmh: 4 })).toThrow(/dailyHours/);
    expect(call({ dailyHours: 0, baseKmh: 4 })).toThrow(/dailyHours/);
    expect(call({ dailyHours: 8, baseKmh: -1 })).toThrow(/baseKmh/);
    expect(call({ dailyHours: Number.NaN, baseKmh: 4 })).toThrow(/dailyHours/);
    expect(call({ dailyHours: 8, baseKmh: Number.POSITIVE_INFINITY })).toThrow(/baseKmh/);
  });


  it('splits a flat trail into start/stop/end legs with days from hours', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 40 }]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4 });

    expect(legs).toHaveLength(2);
    // 40 km flat at 4 km/h = 10.0 h; ceil(10 / 8) = 2 days; 2 x 680 g = 1360 g.
    expect(legs[0]).toMatchObject({
      fromName: 'Trail Start',
      toName: 'Town',
      fromKm: 0,
      toKm: 40,
      distanceKm: 40,
      ascentM: 0,
      descentM: 0,
      estimatedHours: 10,
      estimatedDays: 2,
      isLong: false,
    });
    expect(legs[0].food).toEqual({ weightGrams: 1360, weightKg: 1.4, days: 2 });
    // 60 km = 15.0 h; ceil(15 / 8) = 2 days.
    expect(legs[1]).toMatchObject({
      fromName: 'Town',
      toName: 'Trail End',
      distanceKm: 60,
      estimatedHours: 15,
      estimatedDays: 2,
    });
    expect(legs[1].arrival).toBeUndefined();
  });

  it('never reports a leg as less than a day', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 2 }]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(10), stops, { dailyHours: 8, baseKmh: 4 });

    // 2 km = 0.5 h, which is a fifteenth of a day and still one day of food.
    expect(legs[0].estimatedHours).toBe(0.5);
    expect(legs[0].estimatedDays).toBe(1);
  });

  it('flags a long carry against the threshold', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 40 }]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(100), stops, {
      dailyHours: 8,
      baseKmh: 4,
      longThresholdDays: 1,
    });

    expect(legs.map(l => l.isLong)).toEqual([true, true]);
  });

  it('honours baseKmh and gramsPerDay', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 40 }]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(100), stops, {
      dailyHours: 8,
      baseKmh: 5,
      gramsPerDay: 700,
    });

    // 40 / 5 = 8.0 h exactly; ceil(8 / 8) = 1 day.
    expect(legs[0].estimatedHours).toBe(8);
    expect(legs[0].estimatedDays).toBe(1);
    expect(legs[0].food.weightGrams).toBe(700);
  });

  it('returns nothing when no stop is selected', () => {
    expect(computeResupplyLegs(flatTrail(100), [], { dailyHours: 8, baseKmh: 4 })).toEqual([]);
  });

  describe('route breaks', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'f', name: 'Ferry Landing', type: 'town', totalDistance: 2 }]),
      undefined
    );

    it('does not climb the gap, and does not count it as distance', () => {
      const legs = computeResupplyLegs(brokenTrail(true), stops, { dailyHours: 8, baseKmh: 4 });

      expect(legs).toHaveLength(2);
      expect(legs.map(l => l.distanceKm)).toEqual([2, 2]);
      // The two stretches climb 200 m each; the 800 m step across the water is not walked.
      expect(legs.map(l => l.ascentM)).toEqual([200, 200]);
      expect(legs.map(l => l.descentM)).toEqual([0, 0]);
      // The legs still add up to the trail's own total, with nothing for the crossing.
      expect(legs[0].distanceKm + legs[1].distanceKm).toBe(4);
      // 2 km + 200 m up = 0.5 + 0.3333 h.
      expect(legs[1].estimatedHours).toBe(0.8);
      expect(legs[1].estimatedDays).toBe(1);
    });

    it('climbs the gap when the trail does not declare the break', () => {
      const legs = computeResupplyLegs(brokenTrail(false), stops, { dailyHours: 8, baseKmh: 4 });

      expect(legs[1].ascentM).toBe(1000);
    });
  });

  describe('section scoping', () => {
    const section = { startKm: 20, endKm: 80, startName: 'Start hut', endName: 'End hut' };
    const stops = resolveResupplyStops(
      listResupplyOptions([
        { id: 'a', name: 'Alpha', type: 'town', totalDistance: 10 },
        { id: 'b', name: 'Bravo', type: 'town', totalDistance: 40 },
        { id: 'c', name: 'Charlie', type: 'town', totalDistance: 90 },
      ]),
      undefined
    );

    it('keeps only the stops inside the section and bounds the legs to it', () => {
      const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4, section });

      expect(legs).toHaveLength(2);
      expect(legs[0]).toMatchObject({
        fromName: 'Trail Start',
        toName: 'Bravo',
        fromKm: 20,
        toKm: 40,
        distanceKm: 20,
        estimatedHours: 5,
        estimatedDays: 1,
      });
      expect(legs[1]).toMatchObject({
        fromName: 'Bravo',
        toName: 'Trail End',
        toKm: 80,
        distanceKm: 40,
        estimatedHours: 10,
        estimatedDays: 2,
      });
    });

    it('returns nothing when the section holds no stop', () => {
      const legs = computeResupplyLegs(flatTrail(100), stops, {
        dailyHours: 8,
        baseKmh: 4,
        section: { startKm: 50, endKm: 70, startName: 'A', endName: 'B' },
      });

      expect(legs).toEqual([]);
    });
  });

  describe('arrival', () => {
    const days: ComputedDay[] = [
      {
        dayNumber: 1,
        date: '2026-01-01',
        startName: 'Start',
        endName: 'Town',
        startKm: 0,
        endKm: 40,
        distanceKm: 40,
        ascentM: 0,
        descentM: 0,
        estimatedHours: 10,
        waterSources: 0,
      },
      {
        dayNumber: 2,
        date: '2026-01-05',
        startName: 'Town',
        endName: 'End',
        startKm: 40,
        endKm: 100,
        distanceKm: 60,
        ascentM: 0,
        descentM: 0,
        estimatedHours: 15,
        waterSources: 0,
      },
    ];

    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'town', name: 'Town', type: 'town', totalDistance: 40 }]),
      undefined
    );

    it('reports the day each leg lands on', () => {
      const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4, days });

      expect(legs[0].arrival).toEqual({ day: 1, date: '2026-01-01' });
      expect(legs[1].arrival).toEqual({ day: 2, date: '2026-01-05' });
    });

    it('omits the date when the camp plan has no start date', () => {
      const undated = days.map(day => ({ ...day, date: undefined }));
      const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4, days: undated });

      expect(legs[0].arrival).toEqual({ day: 1 });
    });

    it('omits arrival entirely for a leg no day covers', () => {
      const legs = computeResupplyLegs(flatTrail(100), stops, {
        dailyHours: 8,
        baseKmh: 4,
        days: [days[0]],
      });

      expect(legs[0].arrival).toEqual({ day: 1, date: '2026-01-01' });
      expect(legs[1].arrival).toBeUndefined();
    });
  });
});

describe('summariseResupplyLegs', () => {
  it('counts the stops between the legs, not the legs', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([
        { id: 'a', name: 'Alpha', type: 'town', totalDistance: 40 },
        { id: 'b', name: 'Bravo', type: 'town', totalDistance: 70 },
      ]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4 });
    // 40 km (10.0 h, 2 d), 30 km (7.5 h, 1 d), 30 km (7.5 h, 1 d).
    expect(legs.map(l => l.estimatedDays)).toEqual([2, 1, 1]);

    expect(summariseResupplyLegs(legs)).toEqual({
      stops: 2,
      longestKm: 40,
      longestDays: 2,
      totalFoodKg: 2.7, // (1360 + 680 + 680) g
      hasData: true,
    });
  });

  it('counts a stop sitting on the trail start, which has no leg into it', () => {
    const stops = resolveResupplyStops(
      listResupplyOptions([{ id: 'a', name: 'Trailhead store', type: 'resupply', totalDistance: 0 }]),
      undefined
    );

    const legs = computeResupplyLegs(flatTrail(100), stops, { dailyHours: 8, baseKmh: 4 });

    expect(legs).toHaveLength(1);
    expect(summariseResupplyLegs(legs).stops).toBe(1);
  });

  it('reports no data for no legs', () => {
    expect(summariseResupplyLegs([])).toEqual({
      stops: 0,
      longestKm: 0,
      longestDays: 0,
      totalFoodKg: 0,
      hasData: false,
    });
  });
});

describe('the built CDT', () => {
  // The mobile asset rather than public/data/generated, which is gitignored.
  const cdt = JSON.parse(readFileSync(resolve(__dirname, '../../mobile/assets/trails/cdt.json'), 'utf-8')) as {
    waypoints: ResupplyCandidateWaypoint[];
  };

  const groups = listResupplyOptions(cdt.waypoints);

  it('clusters the towns reached from one turn-off into one group', () => {
    // Matched on the name because the CDT's types are being migrated to the
    // `-access` convention; the names are stable either way.
    const monarch = groups.filter(group => group.options.some(option => option.name.includes('Monarch Pass')));

    expect(monarch).toHaveLength(1);
    expect(monarch[0].options.length).toBeGreaterThanOrEqual(3);
    expect(resolveResupplyStops(monarch, undefined)).toHaveLength(1);
  });

  it('turns its long list of options into a shorter list of stops', () => {
    const optionCount = groups.reduce((sum, group) => sum + group.options.length, 0);

    expect(optionCount).toBeGreaterThanOrEqual(60);
    expect(groups.length).toBeLessThan(optionCount);
    expect(resolveResupplyStops(groups, undefined)).toHaveLength(groups.length);
  });
});
