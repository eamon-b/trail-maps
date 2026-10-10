/**
 * Where one waypoint stands relative to the trail's alternates — the pure half
 * of the waypoint screen's alternate cards.
 *
 * The guide trail lists the main route's waypoints in `waypoints` and each
 * alternate's in `alternates[i].waypoints`. Anything that walks the route as
 * planned (the Today screen, the plan at a glance) can hand the waypoint screen
 * an alternate's waypoint, so the screen resolves both (`findGuideWaypoint`)
 * and then says how the place relates to the alternates (`waypointAlternates`):
 *
 * - `on`: the place is on an alternate. Where that alternate leaves the main
 *   route and rejoins it, how far along it the place is, and whether the plan
 *   takes it.
 * - `leaves` / `rejoins`: the place is a junction where an alternate branches
 *   off or comes back.
 * - `bypassed`: the place is on main route the plan skips by taking an
 *   alternate, so it is not on the route as planned.
 *
 * Km are on the guide's direction-applied scale: `leavesKm` is always the
 * junction met first in the direction walked.
 */

import {
  alternatesOverlap,
  plannableAlternates,
  type PlanAlternate,
  type PlannableTrail,
  type PlannedRoute,
} from '@lib/plan-alternates';
import type { TrailJson, TrailJsonWaypoint } from '../../services/trail-assets';

/** How near a junction a main-route place has to be to count as at it. */
export const JUNCTION_KM = 0.25;

/** An alternate as the guide trail carries it, as far as this module reads it. */
interface GuideVariant {
  name?: string;
  type?: string;
  distance?: number;
  startDistance?: number;
  endDistance?: number;
  elevation?: { ascent?: number; descent?: number };
  parent?: { name: string; index: number };
  waypoints?: TrailJsonWaypoint[];
}

function guideAlternates(trail: TrailJson): GuideVariant[] {
  return Array.isArray(trail.alternates) ? (trail.alternates as GuideVariant[]) : [];
}

/** A waypoint the screen can show, and the alternate it is on (if any). */
export interface GuideWaypoint {
  waypoint: TrailJsonWaypoint;
  /** Index into the trail's `alternates` when the place is on one. */
  alternateIndex: number | null;
}

/**
 * Find a waypoint by the id the screens route with.
 *
 * The main route first, as the list pane keys it (an id, else `name-index`
 * over the km-ordered list), then every alternate's waypoints by id. A junction
 * both lines list resolves to the main route's copy.
 */
export function findGuideWaypoint(trail: TrailJson, waypointId: string): GuideWaypoint | null {
  const list = [...trail.waypoints].sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));
  const main =
    list.find((w, i) => (w.id ?? `${w.name}-${i}`) === waypointId) ??
    list.find((w) => w.id === waypointId);
  if (main) return { waypoint: main, alternateIndex: null };
  const alternates = guideAlternates(trail);
  for (let index = 0; index < alternates.length; index++) {
    const variant = alternates[index];
    if (variant?.type !== 'alternate') continue;
    const found = (variant.waypoints ?? []).find((w) => w.id === waypointId);
    if (found) return { waypoint: found, alternateIndex: index };
  }
  return null;
}

/** A main-route place at a junction, for "leaves at Nabeiwa". */
export interface JunctionPlace {
  id?: string;
  name: string;
  /** Active km of the place on the main route. */
  km: number;
}

/** One alternate as it bears on the waypoint shown. */
export interface WaypointAlternate {
  role: 'on' | 'leaves' | 'rejoins' | 'bypassed';
  name: string;
  /** The planner's view of it; null when a plan cannot take it (it hangs off another alternate). */
  plannable: PlanAlternate | null;
  /** Whether the plan takes it. */
  taken: boolean;
  /** Active main-route km where it leaves the main route; null when it does not leave from it. */
  leavesKm: number | null;
  /** Active main-route km where it rejoins; null when it does not come back to it. */
  rejoinsKm: number | null;
  /** The named main-route places at the two junctions, when there is one within `JUNCTION_KM`. */
  leavesAt: JunctionPlace | null;
  rejoinsAt: JunctionPlace | null;
  /** The alternate this one branches off, for one that is not off the main route. */
  parentName: string | null;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  /** Km along the alternate from where it leaves to the place (role `on` only). */
  kmAlong: number | null;
  /** Taken alternates that taking this one would drop, because they cover the same main route. */
  replaces: string[];
}

function nearestPlace(waypoints: TrailJsonWaypoint[], km: number): JunctionPlace | null {
  let best: JunctionPlace | null = null;
  let bestGap = JUNCTION_KM;
  for (const wp of waypoints) {
    if (typeof wp.totalDistance !== 'number') continue;
    const gap = Math.abs(wp.totalDistance - km);
    if (gap <= bestGap) {
      bestGap = gap;
      best = { ...(wp.id ? { id: wp.id } : {}), name: wp.name, km: wp.totalDistance };
    }
  }
  return best;
}

/**
 * How the waypoint shown relates to the trail's alternates, in walking order.
 *
 * @param guideTrail the guide's direction-applied trail (its alternates mirrored with it).
 * @param baseTrail the trail as stored (NOBO): what a plan's alternates are read from.
 * @param route the route the plan walks (`use-plan-route`).
 * @param found the waypoint, from `findGuideWaypoint` on `guideTrail`.
 */
export function waypointAlternates(
  guideTrail: TrailJson,
  baseTrail: TrailJson,
  route: PlannedRoute,
  found: GuideWaypoint,
): WaypointAlternate[] {
  const variants = guideAlternates(guideTrail);
  const plannable = plannableAlternates(baseTrail as unknown as PlannableTrail);
  const takenNames = new Set(route.alternates.map((a) => a.name));
  const mainWaypoints = guideTrail.waypoints;

  const describe = (index: number, role: WaypointAlternate['role'], kmAlong: number | null) => {
    const variant = variants[index];
    // Same index in the stored trail: reversal maps the list in order.
    const option = plannable.find((o) => o.index === index) ?? null;
    const offMain = !variant.parent && typeof variant.startDistance === 'number';
    const leavesKm = offMain ? (variant.startDistance as number) : null;
    const rejoinsKm = offMain && typeof variant.endDistance === 'number' ? variant.endDistance : null;
    return {
      role,
      name: variant.name ?? 'Alternate',
      plannable: option,
      taken: option !== null && takenNames.has(option.name),
      leavesKm,
      rejoinsKm,
      leavesAt: leavesKm === null ? null : nearestPlace(mainWaypoints, leavesKm),
      rejoinsAt: rejoinsKm === null ? null : nearestPlace(mainWaypoints, rejoinsKm),
      parentName: variant.parent?.name ?? null,
      distanceKm: variant.distance ?? 0,
      ascentM: Math.round(variant.elevation?.ascent ?? 0),
      descentM: Math.round(variant.elevation?.descent ?? 0),
      kmAlong,
      replaces:
        option === null || takenNames.has(option.name)
          ? []
          : route.alternates.filter((a) => alternatesOverlap(a, option)).map((a) => a.name),
    } satisfies WaypointAlternate;
  };

  if (found.alternateIndex !== null) {
    const variant = variants[found.alternateIndex];
    const along =
      typeof found.waypoint.totalDistance === 'number' && typeof variant?.startDistance === 'number'
        ? Math.max(0, found.waypoint.totalDistance - variant.startDistance)
        : null;
    return variant ? [describe(found.alternateIndex, 'on', along)] : [];
  }

  const km = found.waypoint.totalDistance;
  if (typeof km !== 'number') return [];
  const result: WaypointAlternate[] = [];
  variants.forEach((variant, index) => {
    if (variant?.type !== 'alternate' || variant.parent) return;
    const { startDistance: start, endDistance: end } = variant;
    if (typeof start !== 'number') return;
    if (Math.abs(km - start) <= JUNCTION_KM) {
      result.push(describe(index, 'leaves', null));
    } else if (typeof end === 'number' && Math.abs(km - end) <= JUNCTION_KM) {
      result.push(describe(index, 'rejoins', null));
    } else if (typeof end === 'number' && km > start && km < end) {
      // Only a taken alternate takes the place off the route; an untaken one
      // alongside it would put a card on every place it runs beside.
      const card = describe(index, 'bypassed', null);
      if (card.taken) result.push(card);
    }
  });
  // The alternate that takes the place off the route comes first: it is what
  // the hiker most needs to know about it. Junctions follow in walking order.
  const rank = (a: WaypointAlternate) => (a.role === 'bypassed' ? 0 : 1);
  const kmOf = (a: WaypointAlternate) =>
    a.role === 'rejoins' ? (a.rejoinsKm ?? 0) : (a.leavesKm ?? 0);
  return result.sort((a, b) => rank(a) - rank(b) || kmOf(a) - kmOf(b));
}
