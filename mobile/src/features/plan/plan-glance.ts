/**
 * The plan "at a glance": the days the saved plan makes over the whole trail,
 * and where one place sits in them.
 *
 * Two surfaces read this outside the Plan screen:
 * - the map's "View plan" sheet (`PlanGlanceSheet`), so a hiker who has just
 *   ticked a campsite can see the days without opening the planner and
 *   scrolling to them;
 * - the waypoint detail screen, which says what making the place a stop does:
 *   the day that would end there and the one that would leave from it.
 *
 * The Plan screen scopes its days to a section; these surfaces have no section
 * picker, so they always measure the whole trail. The days are the same
 * `computePlanDays` + `splitUnplannedTail` the planner runs, over the same
 * pace and daily hours (`plan-inputs-store`), so a day here and its card on the
 * Plan screen agree whenever the planner shows the full trail.
 *
 * Pure and React-free: the hook over it is `use-plan-glance.ts`.
 */

import type { PlanTrail } from '@lib/day-calculator';
import { KM_EPSILON, type PlanDirection } from '@lib/plan-direction';
import { computePlanDays, splitUnplannedTail, toggleStop } from '@lib/plan-editor';
import { finalDayMaxHours } from '@lib/plan-suggest';
import type { ComputedDay, PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../services/trail-assets';
import type { StopCandidate } from './plan-stops';
import { toggleTargetOf } from './plan-stops';

/** The plan's days over the whole trail. */
export interface PlanGlance {
  /** The planned days, in walking order (direction-applied km). */
  days: ComputedDay[];
  /** The stretch after the last stop, while it is too long to be a day. */
  unplanned: ComputedDay | null;
}

export interface PlanGlanceOptions {
  direction: PlanDirection;
  /** The hiker's pace (`PACE_KMH[pace]`). */
  baseKmh: number;
  /** The hiker's daily hours, for where "not planned yet" begins. */
  dailyHours: number;
}

/**
 * An empty document for a trail that has no plan yet, so an untouched guide
 * reads as one long "not planned yet" stretch rather than nothing at all.
 */
export function emptyPlan(trailId: string, direction: PlanDirection): PlanDocument {
  return {
    id: '',
    trailId,
    name: '',
    direction,
    startDate: null,
    stops: [],
    updatedAt: '',
    version: 1,
  };
}

/**
 * The days `plan` makes over the whole of the (direction-applied) guide trail.
 *
 * The document's direction is forced to the guide's, as the Plan screen does:
 * stops are NOBO-absolute and are converted against it.
 */
export function planGlance(
  trail: TrailJson,
  plan: PlanDocument,
  opts: PlanGlanceOptions,
): PlanGlance {
  const doc = plan.direction === opts.direction ? plan : { ...plan, direction: opts.direction };
  const total = trail.track.totalDistance;
  if (!(total > 0)) return { days: [], unplanned: null };
  const days = computePlanDays(trail as unknown as PlanTrail, doc, {
    baseKmh: opts.baseKmh,
    section: {
      startKm: 0,
      endKm: total,
      startName: `${trail.config.name} Start`,
      endName: `${trail.config.name} End`,
    },
  });
  return splitUnplannedTail(days, finalDayMaxHours(opts.dailyHours));
}

/** Where one place sits among the plan's days. */
export interface StopContext {
  /** The day that ends at the place — the walk in. */
  arrive: ComputedDay | null;
  /** The day that leaves from it — the walk on. */
  depart: ComputedDay | null;
  /** True when `depart` is the "not planned yet" stretch rather than a day. */
  departUnplanned: boolean;
}

/**
 * The day that ends at `activeKm` and the one that leaves from it.
 *
 * `activeKm` is direction-applied, like the days. A place that is not a day
 * boundary has neither (it sits in the middle of a day).
 */
export function stopContext(glance: PlanGlance, activeKm: number): StopContext {
  const near = (a: number, b: number) => Math.abs(a - b) < KM_EPSILON;
  const arrive = glance.days.find((d) => near(d.endKm, activeKm)) ?? null;
  const departDay = glance.days.find((d) => near(d.startKm, activeKm)) ?? null;
  if (departDay) return { arrive, depart: departDay, departUnplanned: false };
  const unplanned =
    glance.unplanned && near(glance.unplanned.startKm, activeKm) ? glance.unplanned : null;
  return { arrive, depart: unplanned, departUnplanned: unplanned !== null };
}

/**
 * What the days around `candidate` would be were it a stop: the plan as it is
 * when it already is one, else the plan with it added. Null when it cannot be
 * added: `toggleStop` refuses a place sharing a km with an existing stop (it
 * returns the same document) and throws for either end of the trail.
 */
export function stopContextIfStopped(
  trail: TrailJson,
  plan: PlanDocument,
  candidate: StopCandidate,
  isStop: boolean,
  opts: PlanGlanceOptions,
): StopContext | null {
  let doc = plan;
  if (!isStop) {
    let next: PlanDocument;
    try {
      next = toggleStop(plan, toggleTargetOf(candidate), { totalKm: trail.track.totalDistance });
    } catch {
      return null;
    }
    if (next === plan) return null;
    doc = next;
  }
  return stopContext(planGlance(trail, doc, opts), candidate.activeKm);
}
