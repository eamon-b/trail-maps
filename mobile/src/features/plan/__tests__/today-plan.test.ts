/**
 * Today's plan: which day of the plan is dated today, and the waypoints along it.
 */

import { newPlan, setNights, setStartDate, toggleStop } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-assets';
import { planGlance, type PlanGlanceOptions } from '../plan-glance';
import { stopCandidateOf, toggleTargetOf } from '../plan-stops';
import { emptyMessage, localIsoDate, todayPlan, todayRows } from '../today-plan';

/** 100 km trail climbing 10 m per km for the first 50 km, then descending. */
function trail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: i <= 50 ? 100 + i * 10 : 600 - (i - 50) * 10,
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
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 20 },
      { id: 'wa', name: 'Creek', lat: 0, lon: 0, type: 'water', totalDistance: 30 },
      { id: 'j1', name: 'Junction', lat: 0, lon: 0, type: 'junction', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'c3', name: 'Camp C', lat: 0, lon: 0, type: 'campsite', totalDistance: 80 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 500, totalDescent: 500 },
  };
}

const OPTS: PlanGlanceOptions = { direction: 'NOBO', baseKmh: 4, dailyHours: 8 };

function plan(t: TrailJson, ids: string[], startDate: string | null): PlanDocument {
  let doc = newPlan('syn', 'Synthetic', 'NOBO', { idFactory: () => 'plan-1' });
  for (const id of ids) {
    const wp = t.waypoints.find((w) => w.id === id)!;
    doc = toggleStop(doc, toggleTargetOf(stopCandidateOf(wp, 'NOBO', 100)), { totalKm: 100 });
  }
  return startDate ? setStartDate(doc, startDate) : doc;
}

describe('localIsoDate', () => {
  it('formats the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('todayPlan', () => {
  const t = trail();

  it('finds the walking day dated today', () => {
    const glance = planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS);
    const today = todayPlan(glance, '2026-10-11');
    expect(today?.kind).toBe('walk');
    expect(today?.day.startName).toBe('Camp A');
    expect(today?.day.endName).toBe('Camp B');
  });

  it('has nothing without a start date, before the start, or in the unplanned tail', () => {
    expect(todayPlan(planGlance(t, plan(t, ['c1', 'c2'], null), OPTS), '2026-10-10')).toBeNull();
    const glance = planGlance(t, plan(t, ['c1', 'c2'], '2026-10-10'), OPTS);
    expect(todayPlan(glance, '2026-10-09')).toBeNull();
    // Camp B → end is 40 km: 10 h, past an 8 h hiker's final-day allowance.
    expect(glance.unplanned).not.toBeNull();
    expect(todayPlan(glance, '2026-10-12')).toBeNull();
  });

  it('reads a rest day at the stop', () => {
    let doc = plan(t, ['c1', 'c2', 'c3'], '2026-10-10');
    doc = setNights(doc, { waypointId: 'c1', km: 20 }, 3);
    const glance = planGlance(t, doc, OPTS);
    const rest = todayPlan(glance, '2026-10-12');
    expect(rest).toMatchObject({ kind: 'rest', restDay: 2, restDays: 2 });
    expect(rest?.day.endName).toBe('Camp A');
    expect(emptyMessage(rest, '2026-10-12', true, true)).toBe('A rest day at Camp A (2 of 2).');
    expect(todayPlan(glance, '2026-10-13')?.day.startName).toBe('Camp A');
  });
});

describe('todayRows', () => {
  it('lists the day from camp to camp with each leg', () => {
    const t = trail();
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS), '2026-10-11');
    const rows = todayRows(t, today!.day);
    expect(rows.map((r) => [r.role, r.name, r.fromStartKm, r.legKm])).toEqual([
      ['start', 'Camp A', 0, 0],
      ['via', 'Creek', 10, 10],
      ['via', 'Junction', 35, 25],
      ['end', 'Camp B', 40, 5],
    ]);
    expect(rows[1]).toMatchObject({ legAscentM: 100, legDescentM: 0 });
    expect(rows[2]).toMatchObject({ legAscentM: 200, legDescentM: 50 });
    expect(rows[3]).toMatchObject({ legAscentM: 0, legDescentM: 50, totalAscentM: 300, totalDescentM: 100 });
    expect(rows[3].waypoint?.id).toBe('c2');
  });

  it('names the trail start when the day has no waypoint there', () => {
    const t = trail();
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2'], '2026-10-10'), OPTS), '2026-10-10');
    const rows = todayRows(t, today!.day);
    expect(rows[0]).toMatchObject({ role: 'start', name: 'Synthetic Start', km: 0 });
    expect(rows[0].waypoint).toBeUndefined();
    expect(rows[rows.length - 1].name).toBe('Camp A');
  });
});
