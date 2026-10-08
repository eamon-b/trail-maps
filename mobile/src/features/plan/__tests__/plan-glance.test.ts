/**
 * The plan at a glance: the days over the whole trail, and the days either side
 * of one place — as planned, or as they would be with it added.
 */

import { newPlan, toggleStop } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import { resolveGuideTrail } from '../../guide/guide-trail';
import type { TrailJson } from '../../../services/trail-assets';
import {
  emptyPlan,
  planGlance,
  stopContext,
  stopContextIfStopped,
  type PlanGlanceOptions,
} from '../plan-glance';
import { stopCandidateOf, toggleTargetOf } from '../plan-stops';

/** Flat 100 km trail: at 4 km/h a day's hours are its km / 4. */
function trail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({ lat: 0, lon: i * 0.001, ele: 100, dist: i }));
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
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

// 8 h days: a final day may run to 10 h (40 km) before it is "not planned yet".
const OPTS: PlanGlanceOptions = { direction: 'NOBO', baseKmh: 4, dailyHours: 8 };

function withStops(t: TrailJson, ids: string[], direction: 'NOBO' | 'SOBO' = 'NOBO'): PlanDocument {
  let plan = newPlan('syn', 'Synthetic', direction, { idFactory: () => 'plan-1' });
  for (const id of ids) {
    const wp = t.waypoints.find((w) => w.id === id)!;
    plan = toggleStop(plan, toggleTargetOf(stopCandidateOf(wp, direction, 100)), { totalKm: 100 });
  }
  return plan;
}

const span = (d: { startKm: number; endKm: number } | null) => d && [d.startKm, d.endKm];

describe('planGlance', () => {
  it('reads an untouched trail as one stretch not planned yet', () => {
    const glance = planGlance(trail(), emptyPlan('syn', 'NOBO'), OPTS);
    expect(glance.days).toEqual([]);
    expect(span(glance.unplanned)).toEqual([0, 100]);
  });

  it('ends a day at every stop, over the whole trail', () => {
    const t = trail();
    const glance = planGlance(t, withStops(t, ['c1', 't1']), OPTS);
    expect(glance.days.map(span)).toEqual([
      [0, 20],
      [20, 40],
    ]);
    // 60 km is 15 h: too long to be a day yet.
    expect(span(glance.unplanned)).toEqual([40, 100]);
  });

  it('keeps a last stretch that fits in a day as a day', () => {
    const t = trail();
    const glance = planGlance(t, withStops(t, ['c1', 'c2']), OPTS);
    expect(glance.days.map(span)).toEqual([
      [0, 20],
      [20, 60],
      [60, 100],
    ]);
    expect(glance.unplanned).toBeNull();
  });

  it('measures a reversed guide in its own km', () => {
    const t = resolveGuideTrail(trail(), 'reversed');
    // Camp B (NOBO 60) is km 40 walking southbound.
    const plan = withStops(trail(), ['c2'], 'NOBO');
    const glance = planGlance(t, plan, { ...OPTS, direction: 'SOBO' });
    expect(span(glance.days[0])).toEqual([0, 40]);
    expect(glance.days[0].endName).toBe('Camp B');
  });
});

describe('stopContext', () => {
  it('names the day in and the day out of a stop', () => {
    const t = trail();
    const glance = planGlance(t, withStops(t, ['c1', 'c2']), OPTS);
    const ctx = stopContext(glance, 20);
    expect(span(ctx.arrive)).toEqual([0, 20]);
    expect(span(ctx.depart)).toEqual([20, 60]);
    expect(ctx.departUnplanned).toBe(false);
  });

  it('says when the walk on is not planned yet', () => {
    const t = trail();
    const ctx = stopContext(planGlance(t, withStops(t, ['c1']), OPTS), 20);
    expect(span(ctx.depart)).toEqual([20, 100]);
    expect(ctx.departUnplanned).toBe(true);
  });

  it('has nothing for a place in the middle of a day', () => {
    const t = trail();
    const ctx = stopContext(planGlance(t, withStops(t, ['c2']), OPTS), 20);
    expect(ctx.arrive).toBeNull();
    expect(ctx.depart).toBeNull();
  });
});

describe('stopContextIfStopped', () => {
  it('shows the days a place would make before it is a stop, without saving it', () => {
    const t = trail();
    const plan = withStops(t, ['c1', 'c2']);
    const town = stopCandidateOf(t.waypoints[2], 'NOBO', 100);
    const ctx = stopContextIfStopped(t, plan, town, false, OPTS);
    expect(span(ctx!.arrive)).toEqual([20, 40]);
    expect(span(ctx!.depart)).toEqual([40, 60]);
    expect(plan.stops).toHaveLength(2);
  });

  it('reads a stop as it is planned', () => {
    const t = trail();
    const plan = withStops(t, ['c1', 'c2']);
    const camp = stopCandidateOf(t.waypoints[1], 'NOBO', 100);
    const ctx = stopContextIfStopped(t, plan, camp, true, OPTS);
    expect(span(ctx!.arrive)).toEqual([0, 20]);
    expect(span(ctx!.depart)).toEqual([20, 60]);
  });

  it('is null for a place that cannot be a stop, such as the trail end', () => {
    const t = trail();
    const finish = stopCandidateOf(t.waypoints[4], 'NOBO', 100);
    expect(stopContextIfStopped(t, emptyPlan('syn', 'NOBO'), finish, false, OPTS)).toBeNull();
  });
});
