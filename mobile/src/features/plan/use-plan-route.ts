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
import { routeBreakStarts } from '@lib/route-breaks';
import type { GuidePosition } from '../../hooks/useGuidePosition';
import { isOffTrail, snapToTrail } from '../../services/position-on-trail';
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

/**
 * Spliced trails per stored trail object, per route and direction. The Plan
 * screen, the resupply picker and the waypoint screen all ask for the same
 * one; splicing the CDT's 20,000-odd points once per screen mount is waste.
 */
const splicedCache = new WeakMap<TrailJson, WeakMap<PlannedRoute, Map<Direction, TrailJson>>>();

/** Pure half of the hook. */
export function planRouteOf(
  baseTrail: TrailJson,
  guideTrail: TrailJson,
  direction: Direction,
  route: PlannedRoute,
): TrailJson {
  if (route.alternates.length === 0) return guideTrail;
  let byRoute = splicedCache.get(baseTrail);
  if (!byRoute) {
    byRoute = new WeakMap();
    splicedCache.set(baseTrail, byRoute);
  }
  let byDirection = byRoute.get(route);
  if (!byDirection) {
    byDirection = new Map();
    byRoute.set(route, byDirection);
  }
  let trail = byDirection.get(direction);
  if (!trail) {
    const spliced = plannedRouteTrail(plannableTrail(baseTrail), route) as unknown as TrailJson;
    trail = resolveGuideTrail(spliced, direction);
    byDirection.set(direction, trail);
  }
  return trail;
}

/**
 * The active-direction route km of the guide's GPS fix, on the route as
 * planned (`trail`, from `planRouteOf`); null without an on-trail fix.
 *
 * With no alternate taken the guide's own snap is already in route km. With
 * one, the raw fix is snapped to the planned route: the guide's km is along
 * the main route, which runs ahead of or behind the route once it has passed
 * an alternate, and a hiker on the alternate is "off" the main route.
 */
export function routeKmOfFix(
  position: Pick<GuidePosition, 'status' | 'currentKm' | 'position'>,
  route: PlannedRoute,
  trail: TrailJson,
): number | null {
  if (route.alternates.length === 0) return position.status === 'fix' ? position.currentKm : null;
  if (!position.position) return null;
  const { points, breaks } = trail.track;
  const snap = snapToTrail(
    position.position.lat,
    position.position.lon,
    points,
    undefined,
    routeBreakStarts(breaks, 'points'),
  );
  return snap && !isOffTrail(snap.offTrailMeters) ? snap.currentKm : null;
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
