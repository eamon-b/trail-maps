/**
 * Alternates in the day planner: taking a different line for part of the trail.
 *
 * A trail's `alternates` are other ways between two points of the main route:
 * the AAWT's Mt Bogong, the Larapinta's high routes, Te Araroa's bypasses. A
 * plan may take any of them. When it does, the route the plan walks is the main
 * route up to the branch point, the alternate's own line, then the main route
 * again from the rejoin. Day lengths, climb, overnight candidates, suggestions
 * and resupply all have to be measured along *that* route, not along the main
 * one with the alternate as a footnote.
 *
 * This module builds that route once (`buildPlannedRoute`) and hands back a
 * trail shaped exactly like the one it was given (`plannedRouteTrail`) but with
 * the alternate spliced in: its points, waypoints, POIs, side trips and breaks
 * all measured in **route km** (km along the route as planned). Every planner
 * calculator then runs on it unchanged.
 *
 * ## Two km spaces
 *
 * The plan document keeps its contract: a main-route stop's `km` is
 * NOBO-absolute km along the main route, so it does not move when an alternate
 * earlier on the trail is taken or dropped. A stop on an alternate carries the
 * alternate's name in `alternate`, and its `km` is the alternate's own absolute
 * scale — the branch km plus the distance along the alternate, which is the
 * `totalDistance` the build already gives a variant waypoint.
 *
 * The planner's editors work in route km, so a page holds the document in
 * route space while it edits (`planToRoute`) and converts back before it saves
 * (`planFromRoute`); `editPlanOnRoute` does the round trip for one edit. A stop
 * the route does not pass (one on a stretch an alternate bypasses) has no
 * route km, so the editor that changes the alternates (`setPlanAlternate`)
 * moves or drops those stops itself, and the round trip never has to.
 *
 * Only an alternate that branches off the main route and rejoins it can be
 * planned: one hanging off another alternate (`parent`), or one with a single
 * junction, has no place on a route made of the main line and its branches.
 *
 * RN-safe: no DOM, no Node.
 */

import { haversineDistance } from './distance';
import { KM_EPSILON } from './plan-direction';
import type { PlanDocument, PlanStop } from './plan-types';
import { PLAN_LIMITS } from './plan-types';
import { routeBreakStarts } from './route-breaks';
import { calculateElevationBetween, findNearestByDistance } from './track-geometry';

// ---------------------------------------------------------------------------
// Structural input shapes
// ---------------------------------------------------------------------------

/** A main-route track point, as the web and the phone both carry it. */
export interface RoutePoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
  cumAscent?: number;
  cumDescent?: number;
}

/** A point of a variant's own line. Its `dist` (when any) is not used. */
export interface VariantPoint {
  lat: number;
  lon: number;
  ele: number;
}

/** A waypoint of a variant: `totalDistance` is branch km + km along the variant. */
export interface PlannableVariantWaypoint {
  id?: string;
  name?: string;
  type?: string;
  totalDistance?: number;
}

/** An alternate, side trip or terminus, as the trail JSON carries it. */
export interface PlannableVariant {
  name: string;
  type: string;
  points: VariantPoint[];
  distance: number;
  elevation?: { ascent: number; descent: number };
  startDistance?: number;
  endDistance?: number;
  startTrackIndex?: number;
  endTrackIndex?: number;
  parent?: { name: string; index: number };
  waypoints?: PlannableVariantWaypoint[];
}

/** A route break, as far as the splice needs one. */
export interface PlannableRouteBreak {
  index: number;
  displayIndex: number;
  km: number;
}

/** The trail shape the splice reads: both the web and the phone trail fit it. */
export interface PlannableTrail {
  track: {
    points: RoutePoint[];
    displayPoints?: RoutePoint[];
    totalDistance: number;
    totalAscent?: number;
    totalDescent?: number;
    breaks?: PlannableRouteBreak[];
  };
  waypoints?: Array<{
    id?: string;
    name?: string;
    type?: string;
    totalDistance?: number;
  }>;
  alternates?: PlannableVariant[];
  sideTrips?: PlannableVariant[];
  pois?: Array<{ distanceAlongTrail: number }>;
}

// ---------------------------------------------------------------------------
// The alternates a plan can take
// ---------------------------------------------------------------------------

/** An alternate the planner offers, with what taking it changes. */
export interface PlanAlternate {
  /** The alternate's name — the key a plan stores it under. */
  name: string;
  /** Index into the trail's `alternates`. */
  index: number;
  /** Main-route km (NOBO) where it branches off. */
  startKm: number;
  /** Main-route km (NOBO) where it rejoins. */
  endKm: number;
  /** Length of the alternate itself. */
  distanceKm: number;
  /** Length of the main route it replaces (`endKm - startKm`). */
  mainDistanceKm: number;
  /** The alternate's climb, walked from the branch to the rejoin. */
  ascentM: number;
  descentM: number;
}

/**
 * The trail's alternates a plan can take, by branch km.
 *
 * Only alternates off the main route with both junctions on it, in order; a
 * repeated name keeps its first alternate, because a plan names the alternate
 * it takes.
 */
export function plannableAlternates(trail: PlannableTrail): PlanAlternate[] {
  const total = trail.track.totalDistance;
  const seen = new Set<string>();
  const options: PlanAlternate[] = [];
  (trail.alternates ?? []).forEach((variant, index) => {
    if (!variant || variant.type !== 'alternate' || variant.parent) return;
    const { startDistance: startKm, endDistance: endKm } = variant;
    if (typeof startKm !== 'number' || typeof endKm !== 'number') return;
    if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) return;
    if (startKm < 0 || endKm > total + KM_EPSILON || endKm - startKm < KM_EPSILON) return;
    if (!Array.isArray(variant.points) || variant.points.length < 2) return;
    if (!(variant.distance > 0) || typeof variant.name !== 'string' || !variant.name.trim()) return;
    if (seen.has(variant.name)) return;
    seen.add(variant.name);
    options.push({
      name: variant.name,
      index,
      startKm,
      endKm: Math.min(endKm, total),
      distanceKm: variant.distance,
      mainDistanceKm: Math.min(endKm, total) - startKm,
      ascentM: Math.round(variant.elevation?.ascent ?? 0),
      descentM: Math.round(variant.elevation?.descent ?? 0),
    });
  });
  return options.sort((a, b) => a.startKm - b.startKm);
}

/** True when two alternates cover some of the same main route. */
export function alternatesOverlap(a: PlanAlternate, b: PlanAlternate): boolean {
  return a.startKm < b.endKm - KM_EPSILON && b.startKm < a.endKm - KM_EPSILON;
}

// ---------------------------------------------------------------------------
// The planned route
// ---------------------------------------------------------------------------

/** One stretch of the planned route. */
export type RouteSegment =
  | {
      kind: 'main';
      /** Main-route km (NOBO) the stretch runs between. */
      fromKm: number;
      toKm: number;
      /** Route km at `fromKm`. */
      routeFromKm: number;
    }
  | {
      kind: 'alternate';
      alternate: PlanAlternate;
      /** Route km at the branch point. */
      routeFromKm: number;
    };

/** The main route with a plan's alternates spliced in. */
export interface PlannedRoute {
  /** The alternates taken, by branch km. Never two that overlap. */
  alternates: PlanAlternate[];
  /** Main, alternate, main, … in walking order (NOBO). */
  segments: RouteSegment[];
  /** Length of the route as planned. */
  totalDistance: number;
  /** Main-route length, for the trail ends. */
  mainTotalDistance: number;
}

/**
 * The route a plan taking `names` walks.
 *
 * A name the trail has no plannable alternate for is ignored (the data may
 * have been rebuilt since the plan was made), and of two that overlap the one
 * that branches first is taken: the editor never stores such a pair, but a
 * hand-edited document could.
 */
export function buildPlannedRoute(
  trail: PlannableTrail,
  names: readonly string[] | undefined,
): PlannedRoute {
  const total = trail.track.totalDistance;
  const wanted = new Set(names ?? []);
  const chosen: PlanAlternate[] = [];
  for (const option of plannableAlternates(trail)) {
    if (!wanted.has(option.name)) continue;
    if (chosen.some(taken => alternatesOverlap(taken, option))) continue;
    chosen.push(option);
  }

  const segments: RouteSegment[] = [];
  let mainKm = 0;
  let routeKm = 0;
  for (const alternate of chosen) {
    segments.push({ kind: 'main', fromKm: mainKm, toKm: alternate.startKm, routeFromKm: routeKm });
    routeKm += alternate.startKm - mainKm;
    segments.push({ kind: 'alternate', alternate, routeFromKm: routeKm });
    routeKm += alternate.distanceKm;
    mainKm = alternate.endKm;
  }
  segments.push({ kind: 'main', fromKm: mainKm, toKm: total, routeFromKm: routeKm });
  routeKm += total - mainKm;

  return { alternates: chosen, segments, totalDistance: routeKm, mainTotalDistance: total };
}

/**
 * Route km of a main-route km (NOBO), or null when the route as planned does
 * not pass it — it is on a stretch an alternate bypasses. The two junctions
 * themselves are on the route.
 */
export function mainKmToRoute(route: PlannedRoute, km: number): number | null {
  for (const segment of route.segments) {
    if (segment.kind !== 'main') continue;
    if (km >= segment.fromKm - KM_EPSILON && km <= segment.toKm + KM_EPSILON) {
      const along = Math.min(Math.max(km - segment.fromKm, 0), segment.toKm - segment.fromKm);
      return segment.routeFromKm + along;
    }
  }
  return null;
}

/**
 * Route km of a km on an alternate (its own absolute scale: branch km plus km
 * along it), or null when the plan does not take that alternate.
 */
export function alternateKmToRoute(route: PlannedRoute, name: string, km: number): number | null {
  for (const segment of route.segments) {
    if (segment.kind !== 'alternate' || segment.alternate.name !== name) continue;
    const along = Math.min(Math.max(km - segment.alternate.startKm, 0), segment.alternate.distanceKm);
    return segment.routeFromKm + along;
  }
  return null;
}

/** Where a route km is, as a plan stop stores it. */
export interface PlanPosition {
  /** Main-route NOBO km, or the alternate's own km when `alternate` is set. */
  km: number;
  alternate?: string;
}

/**
 * The stored position of a route km. A junction is on the main route: a stop
 * at the branch point is a main-route stop whether or not the alternate is
 * taken, so it survives the alternate being dropped.
 */
export function routeKmToPlan(route: PlannedRoute, routeKm: number): PlanPosition {
  for (const segment of route.segments) {
    if (segment.kind !== 'main') continue;
    const length = segment.toKm - segment.fromKm;
    if (routeKm >= segment.routeFromKm - KM_EPSILON && routeKm <= segment.routeFromKm + length + KM_EPSILON) {
      const along = Math.min(Math.max(routeKm - segment.routeFromKm, 0), length);
      return { km: segment.fromKm + along };
    }
  }
  for (const segment of route.segments) {
    if (segment.kind !== 'alternate') continue;
    const { alternate } = segment;
    if (routeKm >= segment.routeFromKm && routeKm <= segment.routeFromKm + alternate.distanceKm) {
      return { km: alternate.startKm + (routeKm - segment.routeFromKm), alternate: alternate.name };
    }
  }
  // Past either end: clamp to the main route's ends.
  return { km: routeKm <= 0 ? 0 : route.mainTotalDistance };
}

/** The route km of a stored stop, or null when the route does not pass it. */
export function stopRouteKm(route: PlannedRoute, stop: Pick<PlanStop, 'km' | 'alternate'>): number | null {
  return stop.alternate === undefined
    ? mainKmToRoute(route, stop.km)
    : alternateKmToRoute(route, stop.alternate, stop.km);
}

// ---------------------------------------------------------------------------
// The planned route as a trail
// ---------------------------------------------------------------------------

/** Cumulative km along a variant's points, scaled to its recorded length. */
function variantDistances(variant: PlannableVariant): number[] {
  const cum = [0];
  for (let i = 1; i < variant.points.length; i++) {
    const a = variant.points[i - 1];
    const b = variant.points[i];
    cum.push(cum[i - 1] + haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000);
  }
  const raw = cum[cum.length - 1];
  const scale = raw > 0 && variant.distance > 0 ? variant.distance / raw : 1;
  return cum.map(d => d * scale);
}

/** First index whose dist is >= km (points ascending by dist). */
function lowerBound(points: readonly { dist: number }[], km: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < km) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last index whose dist is <= km. */
function upperIndex(points: readonly { dist: number }[], km: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist <= km) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

interface SplicedLine<P extends RoutePoint> {
  points: P[];
  /** For each main segment: the main index range kept and where it starts in `points`. */
  pieces: Array<{ segment: RouteSegment; from: number; to: number; offset: number }>;
}

/**
 * Splice a points array (the full one or the display copy): main points keep
 * their own fields with `dist` moved to route km; an alternate contributes its
 * own line. When the main points carry the cumulative climb pair, the spliced
 * line carries one too, with the alternate's share scaled to its recorded climb.
 */
function spliceLine<P extends RoutePoint>(
  source: readonly P[],
  route: PlannedRoute,
  variants: readonly PlannableVariant[],
): SplicedLine<P> {
  const out: P[] = [];
  const pieces: SplicedLine<P>['pieces'] = [];
  const cumulative = source.length > 0 && typeof source[0].cumAscent === 'number'
    && typeof source[0].cumDescent === 'number';
  let runAscent = 0;
  let runDescent = 0;

  for (const segment of route.segments) {
    if (segment.kind === 'main') {
      const from = lowerBound(source, segment.fromKm - KM_EPSILON);
      const to = upperIndex(source, segment.toKm + KM_EPSILON);
      if (from > to) continue;
      pieces.push({ segment, from, to, offset: out.length });
      const first = source[from];
      const baseAscent = first.cumAscent ?? 0;
      const baseDescent = first.cumDescent ?? 0;
      for (let i = from; i <= to; i++) {
        const p = source[i];
        const along = Math.min(Math.max(p.dist - segment.fromKm, 0), segment.toKm - segment.fromKm);
        const next = { ...p, dist: segment.routeFromKm + along };
        if (cumulative) {
          next.cumAscent = runAscent + ((p.cumAscent ?? 0) - baseAscent);
          next.cumDescent = runDescent + ((p.cumDescent ?? 0) - baseDescent);
        }
        out.push(next);
      }
      if (cumulative) {
        const last = out[out.length - 1];
        runAscent = last.cumAscent ?? runAscent;
        runDescent = last.cumDescent ?? runDescent;
      }
      continue;
    }

    const variant = variants[segment.alternate.index];
    const dists = variantDistances(variant);
    let rawUp = 0;
    let rawDown = 0;
    for (let i = 1; i < variant.points.length; i++) {
      const diff = variant.points[i].ele - variant.points[i - 1].ele;
      if (diff > 0) rawUp += diff;
      else rawDown -= diff;
    }
    const upScale = rawUp > 0 ? segment.alternate.ascentM / rawUp : 0;
    const downScale = rawDown > 0 ? segment.alternate.descentM / rawDown : 0;
    let up = 0;
    let down = 0;
    variant.points.forEach((vp, i) => {
      if (i > 0) {
        const diff = vp.ele - variant.points[i - 1].ele;
        if (diff > 0) up += diff * upScale;
        else down -= diff * downScale;
      }
      const point = {
        lat: vp.lat,
        lon: vp.lon,
        ele: vp.ele,
        dist: segment.routeFromKm + dists[i],
      } as P;
      if (cumulative) {
        point.cumAscent = runAscent + up;
        point.cumDescent = runDescent + down;
      }
      out.push(point);
    });
    runAscent += up;
    runDescent += down;
  }

  return { points: out, pieces };
}

/** Where a main index went in a spliced line, or -1 when it was cut. */
function mapMainIndex(line: SplicedLine<RoutePoint>, index: number): number {
  for (const piece of line.pieces) {
    if (index >= piece.from && index <= piece.to) return piece.offset + (index - piece.from);
  }
  return -1;
}

/**
 * The trail as the plan walks it: `trail` with the route's alternates spliced
 * into the main line and everything measured in route km.
 *
 * - `track.points`/`displayPoints` run main → alternate → main. Route breaks on
 *   a bypassed stretch go; the rest are re-indexed.
 * - `waypoints` are the main route's minus the bypassed ones, plus each taken
 *   alternate's (a junction waypoint both lines share is listed once), with
 *   their km, legs and climb recomputed along the new line.
 * - POIs, side trips and the alternates not taken move to route km; any the
 *   route no longer passes are left out.
 *
 * Returns `trail` itself when the route takes no alternate.
 */
export function plannedRouteTrail<T extends PlannableTrail>(trail: T, route: PlannedRoute): T {
  if (route.alternates.length === 0) return trail;
  const variants = trail.alternates ?? [];
  const track = trail.track;

  const line = spliceLine(track.points, route, variants);
  const display = track.displayPoints ? spliceLine(track.displayPoints, route, variants) : null;

  const breaks = (track.breaks ?? []).flatMap(b => {
    const index = mapMainIndex(line, b.index);
    const before = mapMainIndex(line, b.index - 1);
    if (index === -1 || before !== index - 1) return [];
    let displayIndex = b.displayIndex;
    if (display) {
      displayIndex = mapMainIndex(display, b.displayIndex);
      const displayBefore = mapMainIndex(display, b.displayIndex - 1);
      if (displayIndex === -1 || displayBefore !== displayIndex - 1) return [];
    }
    const km = mainKmToRoute(route, b.km);
    return km === null ? [] : [{ ...b, index, displayIndex, km }];
  });
  const breakStarts = routeBreakStarts(breaks, 'points');

  // Main climb the alternates replace, for the totals.
  const mainBreakStarts = routeBreakStarts(track.breaks, 'points');
  let ascent = track.totalAscent ?? 0;
  let descent = track.totalDescent ?? 0;
  for (const alternate of route.alternates) {
    const bypassed = calculateElevationBetween(alternate.startKm, alternate.endKm, track.points, mainBreakStarts);
    ascent += alternate.ascentM - bypassed.gain;
    descent += alternate.descentM - bypassed.loss;
  }

  // Waypoints: the main route's still on it, then each alternate's own.
  type Waypoint = NonNullable<T['waypoints']>[number];
  const placed: Array<{ wp: Waypoint; km: number; order: number }> = [];
  const keptIds = new Set<string>();
  (trail.waypoints ?? []).forEach((wp, order) => {
    const km = mainKmToRoute(route, wp.totalDistance ?? 0);
    if (km === null) return;
    placed.push({ wp: wp as Waypoint, km, order });
    if (wp.id) keptIds.add(wp.id);
  });
  for (const alternate of route.alternates) {
    for (const wp of variants[alternate.index].waypoints ?? []) {
      if (wp.id && keptIds.has(wp.id)) continue;
      const km = alternateKmToRoute(route, alternate.name, wp.totalDistance ?? alternate.startKm);
      if (km === null) continue;
      // Its index into the alternate's own points means nothing on the route.
      const rest = omitKey(wp, 'variantTrackIndex');
      placed.push({ wp: rest as unknown as Waypoint, km, order: Number.MAX_SAFE_INTEGER });
      if (wp.id) keptIds.add(wp.id);
    }
  }
  placed.sort((a, b) => a.km - b.km || a.order - b.order);
  let previousKm = 0;
  let totalUp = 0;
  let totalDown = 0;
  const waypoints = placed.map(({ wp, km }) => {
    const { gain, loss } = calculateElevationBetween(previousKm, km, line.points, breakStarts);
    totalUp += gain;
    totalDown += loss;
    const next = {
      ...wp,
      totalDistance: Math.round(km * 100) / 100,
      distance: Math.round((km - previousKm) * 100) / 100,
      ascent: gain,
      descent: loss,
      totalAscent: totalUp,
      totalDescent: totalDown,
      trackIndex: findNearestByDistance(line.points, km),
    };
    previousKm = km;
    return next as Waypoint;
  });

  const shiftVariant = (variant: PlannableVariant): PlannableVariant | null => {
    if (variant.parent) return null;
    const start = typeof variant.startDistance === 'number' ? mainKmToRoute(route, variant.startDistance) : null;
    if (start === null) return null;
    let end: number | undefined;
    if (typeof variant.endDistance === 'number') {
      const mapped = mainKmToRoute(route, variant.endDistance);
      if (mapped === null) return null;
      end = mapped;
    }
    const shift = start - (variant.startDistance ?? 0);
    return {
      ...variant,
      startDistance: start,
      startTrackIndex: findNearestByDistance(line.points, start),
      ...(end === undefined ? {} : { endDistance: end, endTrackIndex: findNearestByDistance(line.points, end) }),
      waypoints: variant.waypoints?.map(wp => ({
        ...wp,
        ...(typeof wp.totalDistance === 'number' ? { totalDistance: wp.totalDistance + shift } : {}),
      })),
    };
  };
  const taken = new Set(route.alternates.map(a => a.index));

  const result: PlannableTrail = {
    ...trail,
    track: {
      ...track,
      points: line.points,
      ...(display ? { displayPoints: display.points } : {}),
      totalDistance: route.totalDistance,
      totalAscent: Math.round(ascent),
      totalDescent: Math.round(descent),
      ...(track.breaks ? { breaks } : {}),
    },
    waypoints,
  };
  if (trail.alternates) {
    result.alternates = trail.alternates.flatMap((variant, index) => {
      if (taken.has(index)) return [];
      const shifted = shiftVariant(variant);
      return shifted ? [shifted] : [];
    });
  }
  if (trail.sideTrips) {
    result.sideTrips = trail.sideTrips.flatMap(variant => {
      const shifted = shiftVariant(variant);
      return shifted ? [shifted] : [];
    });
  }
  if (trail.pois) {
    result.pois = trail.pois.flatMap(poi => {
      const km = mainKmToRoute(route, poi.distanceAlongTrail);
      return km === null ? [] : [{ ...poi, distanceAlongTrail: km }];
    });
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// The document in route km
// ---------------------------------------------------------------------------

function omitKey<T extends object>(value: T, key: string): T {
  const next = { ...value } as Record<string, unknown>;
  delete next[key];
  return next as T;
}

function omitAlternate(stop: PlanStop): PlanStop {
  return stop.alternate === undefined ? stop : omitKey(stop, 'alternate');
}

/**
 * The plan with every stop at its route km and no `alternate` on any — the
 * document the planner's editors and calculators work on. A stop the route
 * does not pass is left out (the alternates editor never leaves one behind).
 *
 * Returns `plan` itself when it takes no alternate and has no stop on one.
 */
export function planToRoute(plan: PlanDocument, route: PlannedRoute): PlanDocument {
  if (route.alternates.length === 0 && plan.stops.every(stop => stop.alternate === undefined)) return plan;
  const stops: PlanStop[] = [];
  for (const stop of plan.stops) {
    const km = stopRouteKm(route, stop);
    if (km === null) continue;
    stops.push({ ...omitAlternate(stop), km });
  }
  stops.sort((a, b) => a.km - b.km);
  return { ...plan, stops: dedupeStops(stops, () => '') };
}

/** Convert a route-space plan (from `planToRoute`, then edited) back to the stored form. */
export function planFromRoute(routePlan: PlanDocument, route: PlannedRoute): PlanDocument {
  if (route.alternates.length === 0) return routePlan;
  const stops = routePlan.stops.map(stop => {
    const position = routeKmToPlan(route, stop.km);
    return position.alternate === undefined
      ? { ...omitAlternate(stop), km: position.km }
      : { ...omitAlternate(stop), km: position.km, alternate: position.alternate };
  });
  return { ...routePlan, stops: sortPlanStops(stops) };
}

/** The stored order: by km, a main-route stop before an alternate's at the same km. */
export function sortPlanStops(stops: readonly PlanStop[]): PlanStop[] {
  return [...stops].sort((a, b) =>
    a.km - b.km
    || (a.alternate === undefined ? 0 : 1) - (b.alternate === undefined ? 0 : 1)
    || (a.alternate ?? '').localeCompare(b.alternate ?? ''));
}

/**
 * Drop the second of any two stops that are one place: the same waypoint id,
 * or within `KM_EPSILON` on the same line (`lineOf`). Input sorted by km.
 */
function dedupeStops(stops: PlanStop[], lineOf: (stop: PlanStop) => string): PlanStop[] {
  const ids = new Set<string>();
  const lastKm = new Map<string, number>();
  return stops.filter(stop => {
    if (stop.waypointId) {
      if (ids.has(stop.waypointId)) return false;
    }
    const line = lineOf(stop);
    const previous = lastKm.get(line);
    if (previous !== undefined && Math.abs(stop.km - previous) < KM_EPSILON) return false;
    if (stop.waypointId) ids.add(stop.waypointId);
    lastKm.set(line, stop.km);
    return true;
  });
}

/** The names of the alternates a plan takes (as stored; unknown names included). */
export function planAlternateNames(plan: PlanDocument): string[] {
  return plan.alternates ?? [];
}

/** A cache of built routes per trail object, keyed by the alternates taken. */
const routeCache = new WeakMap<object, Map<string, PlannedRoute>>();

/**
 * `buildPlannedRoute` for a plan, cached per trail object and set of names, so
 * a page that converts on every edit does not rebuild the same route each time.
 */
export function plannedRouteFor(trail: PlannableTrail, plan: PlanDocument | undefined): PlannedRoute {
  const names = [...(plan?.alternates ?? [])].sort();
  const key = JSON.stringify(names);
  let byKey = routeCache.get(trail);
  if (!byKey) {
    byKey = new Map();
    routeCache.set(trail, byKey);
  }
  let route = byKey.get(key);
  if (!route) {
    route = buildPlannedRoute(trail, names);
    byKey.set(key, route);
  }
  return route;
}

/**
 * Run one planner edit in route km: convert the stored plan, edit it, convert
 * back. A no-op edit returns `plan` itself, as every editor does.
 *
 * @param trail the trail as built (NOBO, no alternate spliced in).
 */
export function editPlanOnRoute(
  plan: PlanDocument,
  trail: PlannableTrail,
  edit: (routePlan: PlanDocument) => PlanDocument,
): PlanDocument {
  const route = plannedRouteFor(trail, plan);
  const routePlan = planToRoute(plan, route);
  const next = edit(routePlan);
  if (next === routePlan) return plan;
  return planFromRoute(next, route);
}

// ---------------------------------------------------------------------------
// Taking and dropping an alternate
// ---------------------------------------------------------------------------

function stamp(previous: string, now?: () => string): string {
  const current = (now ?? (() => new Date().toISOString()))();
  const currentMs = Date.parse(current);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs) || currentMs > previousMs) return current;
  return new Date(previousMs + 1).toISOString();
}

/**
 * Take an alternate, or go back to the main route.
 *
 * Taking one drops any alternate it overlaps, and the stops on the main route
 * it bypasses; going back drops the stops on the alternate. A stop at a place
 * both lines share (the same waypoint id — a junction hut, a town both reach)
 * moves to the line the plan now walks instead of being dropped.
 *
 * Returns `plan` itself when nothing changes (the alternate was already taken,
 * or was not, or the trail has no such alternate to plan).
 *
 * @param trail the trail as built (NOBO, no alternate spliced in).
 */
export function setPlanAlternate(
  plan: PlanDocument,
  trail: PlannableTrail,
  name: string,
  take: boolean,
  opts?: { now?: () => string },
): PlanDocument {
  const options = plannableAlternates(trail);
  const option = options.find(o => o.name === name);
  const current = plan.alternates ?? [];
  let next: string[];
  if (take) {
    if (!option) return plan;
    if (current.includes(name)) return plan;
    next = current.filter(other => {
      const taken = options.find(o => o.name === other);
      return !taken || !alternatesOverlap(taken, option);
    });
    next.push(name);
    if (next.length > PLAN_LIMITS.alternatesMax) {
      throw new Error(`plan-editor: a plan can take at most ${PLAN_LIMITS.alternatesMax} alternates`);
    }
  } else {
    if (!current.includes(name)) return plan;
    next = current.filter(other => other !== name);
  }
  next.sort();

  const route = buildPlannedRoute(trail, next);
  const variants = trail.alternates ?? [];
  // Where each waypoint id is on the new route, for the stops that have to move.
  const idPosition = new Map<string, PlanPosition>();
  for (const wp of trail.waypoints ?? []) {
    if (!wp.id || typeof wp.totalDistance !== 'number') continue;
    if (mainKmToRoute(route, wp.totalDistance) !== null) idPosition.set(wp.id, { km: wp.totalDistance });
  }
  for (const alternate of route.alternates) {
    for (const wp of variants[alternate.index].waypoints ?? []) {
      if (!wp.id || idPosition.has(wp.id) || typeof wp.totalDistance !== 'number') continue;
      idPosition.set(wp.id, { km: wp.totalDistance, alternate: alternate.name });
    }
  }

  const stops: PlanStop[] = [];
  for (const stop of plan.stops) {
    if (stopRouteKm(route, stop) !== null) {
      stops.push(stop);
      continue;
    }
    const moved = stop.waypointId ? idPosition.get(stop.waypointId) : undefined;
    if (!moved) continue;
    const base = omitAlternate(stop);
    stops.push(moved.alternate === undefined
      ? { ...base, km: moved.km }
      : { ...base, km: moved.km, alternate: moved.alternate });
  }

  const sorted = sortPlanStops(stops);
  const result: PlanDocument = {
    ...plan,
    stops: dedupeStops(sorted, stop => stop.alternate ?? ''),
    updatedAt: stamp(plan.updatedAt, opts?.now),
  };
  if (next.length > 0) result.alternates = next;
  else delete result.alternates;
  return result;
}

// ---------------------------------------------------------------------------
// Where the planner shows the branch and rejoin
// ---------------------------------------------------------------------------

/** A branch or rejoin card's place in the Stops list, in active km. */
export interface AlternateMarker {
  alternate: PlanAlternate;
  /** Whether the plan takes it. */
  taken: boolean;
  /** 'branch' — where it leaves the line walked; 'rejoin' — where it comes back. */
  kind: 'branch' | 'rejoin';
  /** Active-direction route km of the junction. */
  activeKm: number;
}

/**
 * The branch and rejoin cards for the Stops list, in active km, in walking
 * order.
 *
 * An alternate the plan takes gets both: the branch where the route leaves the
 * main line and the rejoin where it comes back, with the alternate's own places
 * listed between them. One not taken gets only its branch card, at whichever
 * junction is met first in the direction walked. An alternate the route does
 * not reach (it starts on a stretch another taken alternate bypasses) gets
 * none.
 *
 * @param trail the trail as built (NOBO).
 */
export function alternateMarkers(
  trail: PlannableTrail,
  route: PlannedRoute,
  direction: 'NOBO' | 'SOBO',
): AlternateMarker[] {
  const toActive = (routeKm: number) =>
    direction === 'SOBO' ? route.totalDistance - routeKm : routeKm;
  const markers: AlternateMarker[] = [];
  for (const alternate of plannableAlternates(trail)) {
    const segment = route.segments.find(
      s => s.kind === 'alternate' && s.alternate.name === alternate.name,
    );
    if (segment) {
      const a = toActive(segment.routeFromKm);
      const b = toActive(segment.routeFromKm + alternate.distanceKm);
      markers.push({ alternate, taken: true, kind: 'branch', activeKm: Math.min(a, b) });
      markers.push({ alternate, taken: true, kind: 'rejoin', activeKm: Math.max(a, b) });
      continue;
    }
    const start = mainKmToRoute(route, alternate.startKm);
    const end = mainKmToRoute(route, alternate.endKm);
    if (start === null || end === null) continue;
    // Strictly inside a taken alternate's bypass is excluded above; a junction
    // shared with one (it ends where this starts) is still on the route.
    markers.push({
      alternate,
      taken: false,
      kind: 'branch',
      activeKm: Math.min(toActive(start), toActive(end)),
    });
  }
  return markers.sort((a, b) => a.activeKm - b.activeKm || (a.kind === 'rejoin' ? -1 : 1));
}
