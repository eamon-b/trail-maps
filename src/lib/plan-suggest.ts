/**
 * The day planner's "next few days" suggestions, platform-neutral half.
 *
 * `day-suggest.ts` is the search. This module is what both planners (the
 * phone's Plan screen and the web plan page) put around it, so the two cannot
 * drift on what a mode means or where a suggestion starts:
 *
 * - the hiker's inputs (`SuggestPrefs`), their starting values and shape check;
 * - the two modes turned into criteria (`suggestionCriteria`);
 * - where a suggestion starts (`suggestionStart`);
 * - applying a chosen plan to the document (`applySuggestedPlan`);
 * - the hours a final day may run to before the tail is "not planned yet"
 *   (`finalDayMaxHours`), and the snap window hours mode aims within.
 *
 * Pure and RN-safe.
 */

import type { DayCriteria } from './day-suggest';
import { replaceStopsInRange, type ToggleTarget } from './plan-editor';
import { KM_EPSILON, stopsToActive, toNoboKm } from './plan-direction';
import type { PlanDocument, SectionConfig } from './plan-types';

/**
 * How far either side of the daily-hours target a day may land when aiming at
 * a camp: `clamp(0.35 · targetHours, 0.75, 2.5)`. Originally the phone
 * splitter's snap window; hours mode aims within the same band.
 */
export function planWindowHours(targetHours: number): number {
  return Math.min(2.5, Math.max(0.75, 0.35 * targetHours));
}

/**
 * The extra a final day may run past the daily-hours target (and the shortest
 * final day the phone splitter leaves): `max(0.75, 0.25 · targetHours)`.
 */
export function planFloorHours(targetHours: number): number {
  return Math.max(0.75, 0.25 * targetHours);
}

/**
 * The longest a plan's last day may be before it stops counting as a day and
 * becomes the "not planned yet" rest of the trail (`splitUnplannedTail`): the
 * hiker's own hours plus the final-day allowance.
 */
export function finalDayMaxHours(dailyHours: number): number {
  return dailyHours + planFloorHours(dailyHours);
}

/** How a suggestion is asked for. */
export type SuggestMode = 'hours' | 'ranges';

/** One range the hiker can switch on in "Distance & climb" mode. */
export interface RangePref {
  on: boolean;
  min: number;
  max: number;
}

/** The suggestion inputs a planner persists per trail (device/browser-local). */
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
/** The most alternatives a planner offers to show. */
export const MAX_ALTERNATIVES_SHOWN = 5;

/**
 * Starting values, derived from the hiker's own pace and hours so nothing is a
 * figure we picked: the distance band is what that pace covers in those hours,
 * ±20 %, and the hours band is the hours ± 1. Ascent starts switched off; its
 * values are only a starting point for the input.
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRangePref(value: unknown): value is RangePref {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.on === 'boolean' && isFiniteNumber(r.min) && isFiniteNumber(r.max);
}

/** Shape check for a persisted blob (AsyncStorage / localStorage can hold anything). */
export function isSuggestPrefs(value: unknown): value is SuggestPrefs {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    (p.mode === 'hours' || p.mode === 'ranges') &&
    isFiniteNumber(p.days) &&
    isFiniteNumber(p.alternatives) &&
    isRangePref(p.distance) &&
    isRangePref(p.ascent) &&
    isRangePref(p.hours)
  );
}

/**
 * The criteria a suggestion is judged on.
 *
 * *Hours & pace* aims every day at the hiker's daily hours, within
 * `planWindowHours` either side. *Distance & climb* uses whichever ranges are
 * switched on; `null` means none is, and there is nothing to search against.
 */
export function suggestionCriteria(prefs: SuggestPrefs, dailyHours: number): DayCriteria | null {
  if (prefs.mode === 'hours') {
    const window = planWindowHours(dailyHours);
    return { hours: { min: Math.max(0, dailyHours - window), max: dailyHours + window, target: dailyHours } };
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
 * The start of a suggestion: the hiker's position (GPS km) when there is one
 * inside the section and they have not asked for the last stop, else the last
 * planned stop in the section, else the section start.
 *
 * @param plan the displayed plan (stops NOBO-absolute).
 * @param hereKm active km of the hiker's position, or null without one.
 */
export function suggestionStart(
  plan: PlanDocument,
  section: SectionConfig,
  totalDistance: number,
  hereKm: number | null,
  preferLastStop: boolean,
): SuggestStart {
  const inSection = (km: number) => km >= section.startKm && km < section.endKm - KM_EPSILON;
  if (!preferLastStop && hereKm !== null && inSection(hereKm)) {
    return { kind: 'here', km: hereKm, name: 'Your location' };
  }
  const active = stopsToActive(plan.stops, plan.direction, totalDistance).filter(
    stop => inSection(stop.km) && stop.km > section.startKm + KM_EPSILON,
  );
  const last = active[active.length - 1];
  if (last) return { kind: 'stop', km: last.km, name: last.name };
  return { kind: 'start', km: section.startKm, name: section.startName };
}

/**
 * Apply a chosen alternative. The stops strictly between the start and the
 * plan's last day are replaced by `targets`; everything before the start and
 * after the window stays as it was (`replaceStopsInRange`).
 *
 * @param startKm active km the suggestion started from.
 * @param endKm active km its last day ends at.
 * @param targets the plan's stops, NOBO-absolute (`toggleStop`'s argument).
 */
export function applySuggestedPlan(
  plan: PlanDocument,
  startKm: number,
  endKm: number,
  targets: readonly ToggleTarget[],
  totalDistance: number,
): PlanDocument {
  return replaceStopsInRange(
    plan,
    {
      fromKm: toNoboKm(startKm, plan.direction, totalDistance),
      toKm: toNoboKm(endKm, plan.direction, totalDistance),
    },
    targets,
  );
}
