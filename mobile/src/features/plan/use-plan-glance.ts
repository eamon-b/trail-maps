/**
 * The open guide's plan at a glance — the hook over `plan-glance.ts`.
 *
 * Reads the route the plan walks (`use-plan-route`: the guide trail with the
 * plan's alternates spliced in, direction applied), the saved plan in that
 * route's km, and the hiker's pace and daily hours, and returns the days over
 * the whole route. A trail with no plan yet reads as an empty one (one "not
 * planned yet" stretch); nothing is written.
 */

import { useMemo } from 'react';
import { planToRoute } from '@lib/plan-alternates';
import type { PlanDocument } from '@lib/plan-types';
import { useGuide } from '../guide/GuideContext';
import { selectPlan, usePlansStore } from '../../state/plans-store';
import { PACE_KMH } from './plan-adapters';
import { selectPrefs, usePlanInputsStore } from './plan-inputs-store';
import { emptyPlan, planGlance, type PlanGlance, type PlanGlanceOptions } from './plan-glance';
import { planDirectionOf } from './plan-stops';
import { usePlanRoute } from './use-plan-route';

export interface PlanGlanceState extends PlanGlance {
  /** The saved plan in route km (`planToRoute`), or an empty one when the trail has none. */
  plan: PlanDocument;
  /** False until the hiker has made a plan with at least one stop. */
  hasStops: boolean;
  /** The options the days were computed with — for a what-if over the same figures. */
  options: PlanGlanceOptions;
}

export function usePlanGlance(): PlanGlanceState {
  const { trailId, direction } = useGuide();
  const saved = usePlansStore(selectPlan(trailId));
  const { route, trail } = usePlanRoute(saved);
  const prefs = usePlanInputsStore(selectPrefs(trailId));
  const planDirection = planDirectionOf(direction);
  const baseKmh = PACE_KMH[prefs.pace];
  const dailyHours = prefs.dailyHours;

  return useMemo(() => {
    const plan = planToRoute(saved ?? emptyPlan(trailId, planDirection), route);
    const options: PlanGlanceOptions = { direction: planDirection, baseKmh, dailyHours };
    return {
      ...planGlance(trail, plan, options),
      plan,
      hasStops: plan.stops.length > 0,
      options,
    };
  }, [saved, route, trail, trailId, planDirection, baseKmh, dailyHours]);
}
