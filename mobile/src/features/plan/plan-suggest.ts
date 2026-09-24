/**
 * The "Next days" card's data layer.
 *
 * The search is `@lib/day-suggest` and everything platform-neutral around it
 * — the inputs, the two modes, where a suggestion starts, applying one — is
 * `@lib/plan-suggest`, shared with the web plan page and re-exported here so
 * the card and the screen import one module. What is the phone's own: the
 * candidates are the Stops list's `StopCandidate`s, in both km spaces.
 *
 * Pure and React-free, like `plan-stops.ts`.
 */

import { buildTimeIndex, type PlanTrail } from '@lib/day-calculator';
import {
  MAX_SUGGEST_DAYS,
  suggestDays,
  type DayCriteria,
  type SuggestDaysResult,
} from '@lib/day-suggest';
import type { PlanDirection } from '@lib/plan-direction';
import { applySuggestedPlan, type SuggestPrefs, type SuggestStart } from '@lib/plan-suggest';
import type { PlanDocument, SectionConfig } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import type { TrailJson } from '../../services/trail-assets';
import { stopCandidates, toggleTargetOf, type StopCandidate } from './plan-stops';

export {
  DEFAULT_SUGGEST_ALTERNATIVES,
  DEFAULT_SUGGEST_DAYS,
  MAX_ALTERNATIVES_SHOWN,
  defaultSuggestPrefs,
  isSuggestPrefs,
  suggestionCriteria,
  suggestionStart,
  type RangePref,
  type SuggestMode,
  type SuggestPrefs,
  type SuggestStart,
} from '@lib/plan-suggest';
export { MAX_SUGGEST_DAYS };

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
  return applySuggestedPlan(
    plan,
    startKm,
    lastDay ? lastDay.endKm : startKm,
    chosen.stops.map((stop) => toggleTargetOf(stop.candidate)),
    totalDistance,
  );
}
