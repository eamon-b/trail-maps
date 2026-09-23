/**
 * The "Next days" card's data layer: where a suggestion starts, what the
 * hiker's criteria are, and how a chosen alternative lands in the plan.
 *
 * The search itself is `@lib/day-suggest` (shared, so the web can adopt it
 * later). This module adds only what is the phone's own: the two input modes,
 * the GPS-else-last-stop start, and the stop candidates in both km spaces.
 *
 * Pure and React-free, like `plan-stops.ts`.
 */

import { buildTimeIndex, type PlanTrail } from '@lib/day-calculator';
import {
  MAX_SUGGEST_ALTERNATIVES,
  MAX_SUGGEST_DAYS,
  suggestDays,
  type DayCriteria,
  type SuggestDaysResult,
} from '@lib/day-suggest';
import { replaceStopsInRange } from '@lib/plan-editor';
import { KM_EPSILON, stopsToActive, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import type { PlanDocument, SectionConfig } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import type { TrailJson } from '../../services/trail-assets';
import { planWindowHours } from './plan-adapters';
import { stopCandidates, toggleTargetOf, type StopCandidate } from './plan-stops';

/** How the card generates plans. */
export type SuggestMode = 'hours' | 'ranges';

/** One range the hiker can switch on in "Distance & climb" mode. */
export interface RangePref {
  on: boolean;
  min: number;
  max: number;
}

/** The card's persisted inputs (per trail, device-local — see `plan-inputs-store`). */
export interface SuggestPrefs {
  mode: SuggestMode;
  /** Nights to plan ahead. */
  days: number;
  /** Alternatives to show. */
  alternatives: number;
  /** km per day. */
  distance: RangePref;
  /** Metres of ascent per day. */
  ascent: RangePref;
  /** Naismith hours per day. */
  hours: RangePref;
}

export const DEFAULT_SUGGEST_DAYS = 3;
export const DEFAULT_SUGGEST_ALTERNATIVES = 3;
export const MAX_ALTERNATIVES_SHOWN = Math.min(5, MAX_SUGGEST_ALTERNATIVES);
export { MAX_SUGGEST_DAYS };

/**
 * The card's starting values, derived from the hiker's own pace and hours so
 * nothing on it is a figure we picked: the distance band is what that pace
 * covers in those hours, ±20 %, and the hours band is the hours ± 1. Ascent
 * starts switched off; its values are only a starting point for the stepper.
 */
export function defaultSuggestPrefs(dailyHours: number, baseKmh: number): SuggestPrefs {
  const dayKm = dailyHours * baseKmh;
  return {
    mode: 'hours',
    days: DEFAULT_SUGGEST_DAYS,
    alternatives: DEFAULT_SUGGEST_ALTERNATIVES,
    distance: { on: true, min: Math.round(dayKm * 0.8), max: Math.round(dayKm * 1.2) },
    ascent: { on: false, min: 0, max: 1000 },
    hours: { on: false, min: Math.max(1, dailyHours - 1), max: dailyHours + 1 },
  };
}

function isRangePref(value: unknown): value is RangePref {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.on === 'boolean' &&
    typeof r.min === 'number' &&
    Number.isFinite(r.min) &&
    typeof r.max === 'number' &&
    Number.isFinite(r.max)
  );
}

/** Shape check for a persisted blob (AsyncStorage can hold anything). */
export function isSuggestPrefs(value: unknown): value is SuggestPrefs {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    (p.mode === 'hours' || p.mode === 'ranges') &&
    typeof p.days === 'number' &&
    typeof p.alternatives === 'number' &&
    isRangePref(p.distance) &&
    isRangePref(p.ascent) &&
    isRangePref(p.hours)
  );
}

/**
 * The criteria a suggestion is judged on.
 *
 * *Hours & pace* aims every day at the hiker's daily hours, within the same
 * snap window the old splitter used (`planWindowHours`). *Distance & climb*
 * uses whichever ranges are switched on; `null` means none is, and there is
 * nothing to search against.
 */
export function suggestionCriteria(prefs: SuggestPrefs, dailyHours: number): DayCriteria | null {
  if (prefs.mode === 'hours') {
    const window = planWindowHours(dailyHours);
    return {
      hours: {
        min: Math.max(0, dailyHours - window),
        max: dailyHours + window,
        target: dailyHours,
      },
    };
  }
  const criteria: DayCriteria = {};
  if (prefs.distance.on) criteria.distanceKm = { min: prefs.distance.min, max: prefs.distance.max };
  if (prefs.ascent.on) criteria.ascentM = { min: prefs.ascent.min, max: prefs.ascent.max };
  if (prefs.hours.on) criteria.hours = { min: prefs.hours.min, max: prefs.hours.max };
  return Object.keys(criteria).length > 0 ? criteria : null;
}

/** Where a suggestion starts from, and why. */
export interface SuggestStart {
  kind: 'here' | 'stop' | 'start';
  /** Active km. */
  km: number;
  name: string;
}

/**
 * The start of a suggestion: the hiker's GPS km when there is an on-trail fix
 * inside the section (and they have not asked for the last stop), else the
 * last planned stop in the section, else the section start.
 *
 * @param plan the displayed plan (stops NOBO-absolute).
 * @param currentKm active km from the GPS snap, or null with no on-trail fix.
 */
export function suggestionStart(
  plan: PlanDocument,
  section: SectionConfig,
  totalDistance: number,
  currentKm: number | null,
  preferLastStop: boolean,
): SuggestStart {
  const inSection = (km: number) => km >= section.startKm && km < section.endKm - KM_EPSILON;
  if (!preferLastStop && currentKm !== null && inSection(currentKm)) {
    return { kind: 'here', km: currentKm, name: 'Your location' };
  }
  const active = stopsToActive(plan.stops, plan.direction, totalDistance).filter(
    (stop) => inSection(stop.km) && stop.km > section.startKm + KM_EPSILON,
  );
  const last = active[active.length - 1];
  if (last) return { kind: 'stop', km: last.km, name: last.name };
  return { kind: 'start', km: section.startKm, name: section.startName };
}

/** A stop candidate as the search sees it: its active km, carrying the candidate. */
export interface SearchCandidate {
  km: number;
  candidate: StopCandidate;
}

export interface NextDaysInput {
  start: SuggestStart;
  section: SectionConfig;
  prefs: SuggestPrefs;
  criteria: DayCriteria;
  baseKmh: number;
  direction: PlanDirection;
}

/**
 * The ranked alternatives for the next few days.
 *
 * Candidates are the Stops list's own default set (camps, huts and towns —
 * `stopCandidates`), so every suggestion is a row the hiker can see and tap.
 */
export function suggestNextDays(
  trail: TrailJson,
  input: NextDaysInput,
): SuggestDaysResult<SearchCandidate> {
  const planTrail = trail as unknown as PlanTrail;
  const index = buildTimeIndex(
    planTrail.track.points,
    routeBreakStarts(planTrail.track.breaks, 'points'),
  );
  const candidates = stopCandidates(trail, input.direction).map((candidate) => ({
    km: candidate.activeKm,
    candidate,
  }));
  return suggestDays({
    index,
    candidates,
    fromKm: input.start.km,
    endKm: input.section.endKm,
    days: input.prefs.days,
    alternatives: input.prefs.alternatives,
    criteria: input.criteria,
    baseKmh: input.baseKmh,
  });
}

/**
 * Apply a chosen alternative: the stops between the start and the plan's last
 * day are replaced by its stops; everything before the start and after the
 * window stays as it was.
 */
export function applySuggestion(
  plan: PlanDocument,
  startKm: number,
  chosen: { stops: SearchCandidate[]; days: { endKm: number }[] },
  totalDistance: number,
): PlanDocument {
  const lastDay = chosen.days[chosen.days.length - 1];
  const endKm = lastDay ? lastDay.endKm : startKm;
  return replaceStopsInRange(
    plan,
    {
      fromKm: toNoboKm(startKm, plan.direction, totalDistance),
      toKm: toNoboKm(endKm, plan.direction, totalDistance),
    },
    chosen.stops.map((stop) => toggleTargetOf(stop.candidate)),
  );
}
