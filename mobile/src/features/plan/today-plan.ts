/**
 * Today's plan: the planned day whose date is today, and the waypoints along it.
 *
 * A plan has dates once it has a start date (`computePlanDays` dates every day,
 * pushed back by rest days). On the trail the question is "what am I walking
 * today?", and the answer is one day of the plan — from the stop the hiker slept
 * at to the one they have entered for tonight — with every waypoint between,
 * each with the distance, climb and descent from the row before it.
 *
 * Only a *planned* day counts: the "not planned yet" tail does not end at a stop
 * the hiker entered, so a date that falls in it has no plan for today.
 *
 * Pure and React-free; the screen is `app/guide/[trailId]/today.tsx` and the
 * hook `use-today-plan.ts`.
 */

import { KM_EPSILON } from '@lib/plan-direction';
import type { ComputedDay } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import { calculateElevationBetween } from '@lib/track-geometry';
import type { TrailJson, TrailJsonWaypoint } from '../../services/trail-assets';
import type { PlanGlance } from './plan-glance';

/** What the plan says about today. */
export type TodayPlan =
  /** A walking day. */
  | { kind: 'walk'; day: ComputedDay }
  /**
   * A rest day at the stop `day` ended at. `restDay` is which of its
   * `restDays` (1-based) today is.
   */
  | { kind: 'rest'; day: ComputedDay; restDay: number; restDays: number };

/** The phone's local calendar date as `YYYY-MM-DD` — the plan's date format. */
export function localIsoDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * The planned day dated `today`, or the rest day it falls on; null when the
 * plan has no start date, or today is before its first day or after its last
 * planned one.
 */
export function todayPlan(glance: PlanGlance, today: string): TodayPlan | null {
  for (const day of glance.days) {
    if (day.date === undefined) return null;
    if (day.date === today) return { kind: 'walk', day };
    const restDays = day.restDays ?? 0;
    if (restDays > 0) {
      const after = daysBetween(day.date, today);
      if (after >= 1 && after <= restDays) {
        return { kind: 'rest', day, restDay: after, restDays };
      }
    }
  }
  return null;
}

/** Why there is no walking day to show. */
export function emptyMessage(
  today: TodayPlan | null,
  date: string,
  hasStops: boolean,
  hasStartDate: boolean,
): string {
  if (today?.kind === 'rest') {
    const which = today.restDays > 1 ? ` (${today.restDay} of ${today.restDays})` : '';
    return `A rest day at ${today.day.endName}${which}.`;
  }
  if (!hasStops) return 'Your plan has no stops yet. Add the camps you will stop at in the planner.';
  if (!hasStartDate) return 'Your plan has no start date, so no day is dated today. Set one in the planner.';
  return `No planned day is dated ${date}.`;
}

/** One row of today's waypoint list. */
export interface TodayRow {
  /** Stable list key. */
  key: string;
  /** The waypoint behind the row, when there is one (the day's ends may have none). */
  waypoint?: TrailJsonWaypoint;
  name: string;
  type: string;
  /** Where the row sits: the day's start, a waypoint on the way, or tonight's stop. */
  role: 'start' | 'via' | 'end';
  /** Active-direction km along the route. */
  km: number;
  /** km from the day's start. */
  fromStartKm: number;
  /** The leg from the row before (all zero on the start row). */
  legKm: number;
  legAscentM: number;
  legDescentM: number;
  /** Climb and descent so far today. */
  totalAscentM: number;
  totalDescentM: number;
}

/**
 * The day's start, every waypoint on the way, and its end, in walking order,
 * each with the leg from the row before it.
 *
 * `trail` is the route the plan walks, direction applied (`use-plan-route`),
 * so waypoint `totalDistance` and the day's km are in the same space. The ends
 * take the waypoint at their km when there is one (the camp the hiker
 * entered), else just the day's start/end name (the trail start).
 */
export function todayRows(trail: TrailJson, day: ComputedDay): TodayRow[] {
  const points = trail.track.points;
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  const near = (a: number, b: number) => Math.abs(a - b) < KM_EPSILON;

  const sorted = trail.waypoints
    .filter((w) => w.totalDistance !== undefined)
    .sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));
  const at = (km: number, name: string) => {
    const here = sorted.filter((w) => near(w.totalDistance ?? 0, km));
    return here.find((w) => w.name === name) ?? here[0];
  };
  const startWp = at(day.startKm, day.startName);
  const endWp = at(day.endKm, day.endName);
  const via = sorted.filter((w) => {
    const km = w.totalDistance ?? 0;
    return km > day.startKm - KM_EPSILON && km < day.endKm + KM_EPSILON && w !== startWp && w !== endWp;
  });

  type Stop = { waypoint?: TrailJsonWaypoint; name: string; role: TodayRow['role']; km: number };
  const stops: Stop[] = [
    { waypoint: startWp, name: day.startName, role: 'start', km: day.startKm },
    ...via.map((w): Stop => ({
      waypoint: w,
      name: w.name,
      role: 'via',
      // A waypoint sharing a km with an end sits on it, not a hair beyond.
      km: Math.min(day.endKm, Math.max(day.startKm, w.totalDistance ?? 0)),
    })),
    { waypoint: endWp, name: day.endName, role: 'end', km: day.endKm },
  ];

  const rows: TodayRow[] = [];
  let totalAscentM = 0;
  let totalDescentM = 0;
  stops.forEach((stop, i) => {
    const prevKm = i === 0 ? stop.km : stops[i - 1].km;
    const legKm = Math.max(0, stop.km - prevKm);
    const { gain, loss } =
      legKm > 0
        ? calculateElevationBetween(prevKm, stop.km, points, breakStarts)
        : { gain: 0, loss: 0 };
    totalAscentM += gain;
    totalDescentM += loss;
    rows.push({
      key: `${stop.role}:${stop.waypoint?.id ?? `${stop.name}@${stop.km.toFixed(3)}`}:${i}`,
      ...(stop.waypoint ? { waypoint: stop.waypoint } : {}),
      name: stop.waypoint?.name ?? stop.name,
      type: stop.waypoint?.type ?? 'waypoint',
      role: stop.role,
      km: stop.km,
      fromStartKm: stop.km - day.startKm,
      legKm,
      legAscentM: gain,
      legDescentM: loss,
      totalAscentM,
      totalDescentM,
    });
  });
  return rows;
}
