/**
 * The route a plan walks, as a guide trail.
 *
 * A plan may take a trail's alternates (`@lib/plan-alternates`); when it does,
 * every figure the planner shows — day lengths, climb, the places to stop,
 * suggestions, resupply legs — is measured along the main route with those
 * alternates spliced in. This builds that trail from the guide's trail *as
 * stored* (the splice works in NOBO km) and then applies the guide's direction,
 * exactly as `GuideContext` does for the main route.
 *
 * With no alternate taken it is the guide trail itself, so nothing downstream
 * re-renders or recomputes for plans that never take one.
 */

import { useMemo } from 'react';
import {
  plannedRouteFor,
  plannedRouteTrail,
  type PlannableTrail,
  type PlannedRoute,
} from '@lib/plan-alternates';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../services/trail-assets';
import type { Direction } from '../../state/settings-store';
import { useGuide } from '../guide/GuideContext';
import { resolveGuideTrail } from '../guide/guide-trail';

export interface PlanRoute {
  /** The splice: which alternates, and where everything is in route km. */
  route: PlannedRoute;
  /** The guide trail as the plan walks it, direction applied. */
  trail: TrailJson;
  /** The guide trail as stored (NOBO, no alternate spliced in). */
  baseTrail: TrailJson;
}

/** The trail as stored, in the shape the splice reads. */
export function plannableTrail(trail: TrailJson): PlannableTrail {
  return trail as unknown as PlannableTrail;
}

/** Pure half of the hook. */
export function planRouteOf(
  baseTrail: TrailJson,
  guideTrail: TrailJson,
  direction: Direction,
  route: PlannedRoute,
): TrailJson {
  if (route.alternates.length === 0) return guideTrail;
  const spliced = plannedRouteTrail(plannableTrail(baseTrail), route) as unknown as TrailJson;
  return resolveGuideTrail(spliced, direction);
}

export function usePlanRoute(plan: PlanDocument | undefined): PlanRoute {
  const { baseTrail, trail, direction } = useGuide();
  // Cached per trail object and set of alternates, so this is the same object
  // render after render until the plan takes or drops one.
  const route = plannedRouteFor(plannableTrail(baseTrail), plan);
  const routeTrail = useMemo(
    () => planRouteOf(baseTrail, trail, direction, route),
    [baseTrail, trail, direction, route],
  );
  return { route, trail: routeTrail, baseTrail };
}
