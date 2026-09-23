/**
 * Suggest the next few days of a plan: ranked alternatives, not one answer.
 *
 * Most planning happens on the trail, a few days at a time, from wherever the
 * hiker is standing. This module answers "which camps could I sleep at over
 * the next K nights?" with the N best whole sequences, so the hiker compares
 * complete few-day plans rather than choosing one night at a time with no idea
 * where it leaves them.
 *
 * **What a good day is, is the hiker's call.** A day is judged against the
 * ranges the caller passes: distance, ascent and Naismith hours, each optional,
 * each with a min and/or max and an optional target. The two ways the phone
 * plans are two ways of filling those ranges in:
 *
 * - *Hours & pace*: `hours` only, target = the hiker's daily hours, bounds =
 *   the target ± the splitter's snap window.
 * - *Distance & climb*: whichever of `distanceKm`, `ascentM` and `hours` the
 *   hiker switched on.
 *
 * Nothing here invents a figure: there is no default range, and a criteria set
 * with no upper bound at all is refused rather than capped (see
 * `assertSearchable`).
 *
 * **Scoring.** A day inside every range costs the sum of its squared, scaled
 * misses of each target: `((value − target) / scale)²`, where `scale` is the
 * range's half-width, so a day at either edge of a range costs 1 for that
 * range. A plan's score is the mean of its days' costs. Lower is better.
 *
 * **Search.** This is a k-best dynamic programme over the candidates in km
 * order. For each day and each camp it keeps the cheapest few partial plans
 * that end there, and then it extends them. Costs add, so keeping the best k
 * per state is enough to find the best k overall. A day that can reach the end
 * of the range (the section or trail end) may finish there. That last day is
 * only held to the ranges' maximums: a short final day is simply the walk out.
 *
 * Pure and RN-safe: callers build the `TimeIndex` once (`buildTimeIndex`, with
 * the route breaks) and pass candidates in the same active km space as the
 * track.
 */

import { climbBetweenIndexed, estimateHikingHoursRaw, type TimeIndex } from './day-calculator';
import { KM_EPSILON } from './plan-direction';

/** One criterion's acceptable band, and the value inside it to aim for. */
export interface MetricRange {
  min?: number;
  max?: number;
  /**
   * The value a perfect day hits. Defaults to the middle of the range, or to
   * the one bound given when the range is one-sided.
   */
  target?: number;
}

/** What makes a day acceptable. Absent ranges are not judged at all. */
export interface DayCriteria {
  distanceKm?: MetricRange;
  ascentM?: MetricRange;
  hours?: MetricRange;
}

/** The figures a suggested day is judged on. */
export interface DayMetrics {
  distanceKm: number;
  ascentM: number;
  descentM: number;
  /** Raw Naismith hours (unrounded). */
  hours: number;
}

/** A candidate place to end a day. Only `km` is read; the rest rides along. */
export interface SuggestCandidate {
  /** km along the trail in the same (active) space as the time index. */
  km: number;
}

export interface SuggestDaysInput<C extends SuggestCandidate> {
  /** Built by the caller from the direction-applied track and its breaks. */
  index: TimeIndex;
  /** Places a day may end, in any order; anything outside the range is ignored. */
  candidates: readonly C[];
  /** Where day 1 starts (active km). */
  fromKm: number;
  /** The furthest a plan may go: the section or trail end (active km). */
  endKm: number;
  /** How many nights to plan. */
  days: number;
  /** How many alternative plans to return at most. */
  alternatives: number;
  criteria: DayCriteria;
  /** Naismith flat-ground speed, from the hiker's pace. */
  baseKmh: number;
}

export interface SuggestedDay<C extends SuggestCandidate> extends DayMetrics {
  startKm: number;
  endKm: number;
  /** Where the day ends, or `null` when it ends at `endKm` (the walk out). */
  end: C | null;
  /** This day's deviation from the targets (0 = perfect). */
  cost: number;
}

export interface SuggestedPlan<C extends SuggestCandidate> {
  days: SuggestedDay<C>[];
  /** The candidates the plan sleeps at, in walking order (`days[i].end`, minus the walk out). */
  stops: C[];
  /** Mean day cost: lower is better, 0 is every day on target. */
  score: number;
  /** True when the last day ends at `endKm` rather than at a candidate. */
  reachesEnd: boolean;
}

export interface SuggestDaysResult<C extends SuggestCandidate> {
  /** Best first. Empty when not even one day fits the criteria. */
  plans: SuggestedPlan<C>[];
  /**
   * The fewest days any returned plan covers, when this is fewer than asked
   * for and the plans do not reach the end. A day beyond that has no camp in
   * range, so the UI can tell the hiker the criteria ran out rather than
   * silently offering shorter plans.
   */
  shortOf?: number;
}

/**
 * Two plans whose stops all sit within this many km of each other are the
 * same plan for the hiker's purposes (two pitches of one campground). The
 * duplicate only takes a slot once the distinct plans run out.
 */
export const NEAR_DUPLICATE_KM = 1;

/** Upper bound on `days`: a "next few days" search, not a whole-trail one. */
export const MAX_SUGGEST_DAYS = 14;

/** Upper bound on `alternatives`. */
export const MAX_SUGGEST_ALTERNATIVES = 10;

/** Partial plans kept per (day, camp) state, per alternative asked for. */
const KEEP_PER_ALTERNATIVE = 4;

function hasMax(range: MetricRange | undefined): boolean {
  return range !== undefined && typeof range.max === 'number' && Number.isFinite(range.max);
}

/** True when at least one range has a maximum — see `assertSearchable`. */
export function isSearchable(criteria: DayCriteria): boolean {
  return hasMax(criteria.distanceKm) || hasMax(criteria.ascentM) || hasMax(criteria.hours);
}

/**
 * Throw unless the criteria give the search somewhere to stop: at least one
 * range with a maximum. Distance, ascent and hours all only grow as a day gets
 * longer, so any one maximum ends the scan for that day. Without one, every
 * camp to the end of the trail is a candidate for every day, and a silent
 * built-in cap would be a figure the hiker never chose.
 */
export function assertSearchable(criteria: DayCriteria): void {
  if (!isSearchable(criteria)) {
    throw new Error('day-suggest: set a maximum distance, ascent or hours for a day');
  }
}

/** The target and scale a range is scored against, or `undefined` for no range. */
interface Scored {
  min: number;
  max: number;
  target: number;
  scale: number;
}

function scoredRange(range: MetricRange | undefined): Scored | undefined {
  if (!range) return undefined;
  const min = typeof range.min === 'number' && Number.isFinite(range.min) ? range.min : -Infinity;
  const max = typeof range.max === 'number' && Number.isFinite(range.max) ? range.max : Infinity;
  if (min === -Infinity && max === Infinity && range.target === undefined) return undefined;
  const target =
    range.target ??
    (Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : Number.isFinite(min) ? min : max);
  // Half the band on the side furthest from the target, so either edge of an
  // off-centre range costs at most 1. A one-sided or zero-width range scales by
  // a quarter of the target instead — still unitless, still the hiker's figure.
  const reach = Math.max(
    Number.isFinite(min) ? target - min : 0,
    Number.isFinite(max) ? max - target : 0,
  );
  const scale = reach > 0 ? reach : Math.max(Math.abs(target) / 4, 1e-6);
  return { min, max, target, scale };
}

interface ScoredCriteria {
  distanceKm?: Scored;
  ascentM?: Scored;
  hours?: Scored;
}

function scoreCriteria(criteria: DayCriteria): ScoredCriteria {
  return {
    distanceKm: scoredRange(criteria.distanceKm),
    ascentM: scoredRange(criteria.ascentM),
    hours: scoredRange(criteria.hours),
  };
}

const METRIC_KEYS = ['distanceKm', 'ascentM', 'hours'] as const;

/**
 * A day's cost against the criteria, or `undefined` when it falls outside a
 * range. `final` marks the walk out to `endKm`: it is held to the maximums
 * only, and being under a target costs nothing.
 */
function dayCost(metrics: DayMetrics, scored: ScoredCriteria, final: boolean): number | undefined {
  let cost = 0;
  for (const key of METRIC_KEYS) {
    const range = scored[key];
    if (!range) continue;
    const value = metrics[key];
    if (value > range.max + 1e-9) return undefined;
    if (!final && value < range.min - 1e-9) return undefined;
    if (final && value <= range.target) continue;
    const miss = (value - range.target) / range.scale;
    cost += miss * miss;
  }
  return cost;
}

/** True once a day from here has gone past every maximum it can outgrow. */
function pastMaximum(metrics: DayMetrics, scored: ScoredCriteria): boolean {
  for (const key of METRIC_KEYS) {
    const range = scored[key];
    if (range && Number.isFinite(range.max) && metrics[key] > range.max + 1e-9) return true;
  }
  return false;
}

/** Distance, climb and Naismith hours from `fromKm` to `toKm`. */
export function measureDay(index: TimeIndex, fromKm: number, toKm: number, baseKmh: number): DayMetrics {
  const distanceKm = Math.abs(toKm - fromKm);
  const { gain, loss } = climbBetweenIndexed(index, fromKm, toKm);
  return {
    distanceKm,
    ascentM: gain,
    descentM: loss,
    hours: estimateHikingHoursRaw(distanceKm, gain, loss, baseKmh),
  };
}

/** A partial plan: the camp it last slept at (or -1 for the start), its days, their cost. */
interface Partial {
  at: number;
  days: SuggestedDay<SuggestCandidate>[];
  cost: number;
}

/** Keep `list` as the `limit` cheapest, cheapest first. */
function pushBounded(list: Partial[], item: Partial, limit: number): void {
  if (list.length >= limit && item.cost >= list[list.length - 1].cost) return;
  let i = list.length;
  while (i > 0 && list[i - 1].cost > item.cost) i--;
  list.splice(i, 0, item);
  if (list.length > limit) list.pop();
}

function stopsOf<C extends SuggestCandidate>(days: SuggestedDay<C>[]): C[] {
  const stops: C[] = [];
  for (const day of days) if (day.end) stops.push(day.end);
  return stops;
}

function nearDuplicate<C extends SuggestCandidate>(a: SuggestedPlan<C>, b: SuggestedPlan<C>): boolean {
  if (a.days.length !== b.days.length || a.reachesEnd !== b.reachesEnd) return false;
  return a.days.every((day, i) => Math.abs(day.endKm - b.days[i].endKm) < NEAR_DUPLICATE_KM);
}

/**
 * The best few ways to spend the next `days` nights from `fromKm`.
 *
 * Plans are ranked by mean day cost. A plan that reaches `endKm` early is
 * complete: when the section runs out after two days, a two-day plan is the
 * answer. When no plan of the full length exists and none reaches the end,
 * the deepest plans found are returned, and `shortOf` says how many days they
 * cover.
 *
 * @throws when the criteria have no maximum (`assertSearchable`).
 */
export function suggestDays<C extends SuggestCandidate>(input: SuggestDaysInput<C>): SuggestDaysResult<C> {
  assertSearchable(input.criteria);
  const scored = scoreCriteria(input.criteria);
  const days = Math.max(1, Math.min(MAX_SUGGEST_DAYS, Math.floor(input.days)));
  const alternatives = Math.max(1, Math.min(MAX_SUGGEST_ALTERNATIVES, Math.floor(input.alternatives)));
  const keep = alternatives * KEEP_PER_ALTERNATIVE;
  const { index, fromKm, endKm, baseKmh } = input;
  if (!(endKm - fromKm > KM_EPSILON)) return { plans: [] };

  // The camps strictly inside the range, in walking order, one per km: two
  // waypoints at the same km are the same night.
  const camps: C[] = [];
  for (const candidate of [...input.candidates].sort((a, b) => a.km - b.km)) {
    if (candidate.km <= fromKm + KM_EPSILON || candidate.km >= endKm - KM_EPSILON) continue;
    const previous = camps[camps.length - 1];
    if (previous && candidate.km - previous.km < KM_EPSILON) continue;
    camps.push(candidate);
  }

  const kmAt = (at: number) => (at === -1 ? fromKm : camps[at].km);
  const finished: Partial[] = [];
  let layer = new Map<number, Partial[]>([[-1, [{ at: -1, days: [], cost: 0 }]]]);
  let deepest: Partial[] = [];

  for (let day = 1; day <= days && layer.size > 0; day++) {
    const next = new Map<number, Partial[]>();
    for (const [at, partials] of layer) {
      const startKm = kmAt(at);
      // Day ends at a camp further along, until a maximum is passed.
      for (let j = at + 1; j < camps.length; j++) {
        const metrics = measureDay(index, startKm, camps[j].km, baseKmh);
        if (pastMaximum(metrics, scored)) break;
        const cost = dayCost(metrics, scored, false);
        if (cost === undefined) continue;
        const suggested: SuggestedDay<SuggestCandidate> = {
          ...metrics,
          startKm,
          endKm: camps[j].km,
          end: camps[j],
          cost,
        };
        const bucket = next.get(j) ?? [];
        for (const partial of partials) {
          pushBounded(bucket, { at: j, days: [...partial.days, suggested], cost: partial.cost + cost }, keep);
        }
        if (bucket.length > 0) next.set(j, bucket);
      }
      // Or the day walks out to the end of the range.
      const out = measureDay(index, startKm, endKm, baseKmh);
      const outCost = dayCost(out, scored, true);
      if (outCost !== undefined) {
        const suggested: SuggestedDay<SuggestCandidate> = { ...out, startKm, endKm, end: null, cost: outCost };
        for (const partial of partials) {
          finished.push({ at: -2, days: [...partial.days, suggested], cost: partial.cost + outCost });
        }
      }
    }
    layer = next;
    if (next.size > 0) deepest = [...next.values()].flat();
  }

  const full = [...layer.values()].flat();
  let pool: Partial[] = [...full, ...finished];
  let shortOf: number | undefined;
  if (pool.length === 0 && deepest.length > 0) {
    pool = deepest;
    shortOf = deepest[0].days.length;
  }

  const ranked: SuggestedPlan<C>[] = pool
    .map(partial => {
      const planDays = partial.days as SuggestedDay<C>[];
      return {
        days: planDays,
        stops: stopsOf(planDays),
        score: partial.cost / planDays.length,
        reachesEnd: planDays[planDays.length - 1].end === null,
      };
    })
    .sort((a, b) => a.score - b.score || b.days.length - a.days.length);

  // Distinct plans first; a near-duplicate only fills a slot nothing else can.
  const plans: SuggestedPlan<C>[] = [];
  for (const plan of ranked) {
    if (plans.length >= alternatives) break;
    if (!plans.some(chosen => nearDuplicate(chosen, plan))) plans.push(plan);
  }
  for (const plan of ranked) {
    if (plans.length >= alternatives) break;
    if (!plans.includes(plan)) plans.push(plan);
  }
  plans.sort((a, b) => a.score - b.score || b.days.length - a.days.length);

  return shortOf === undefined ? { plans } : { plans, shortOf };
}
