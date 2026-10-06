/**
 * Resupply *planning*: which resupply options a trail offers, which of them the
 * hiker has picked, and what the legs between the picked ones cost.
 *
 * `resupply-calculator.ts` answers "where can I buy food" — every resupply-family
 * waypoint, with a flat km/day estimate between them. On a long trail that is not
 * a plan: the CDT has 70 of them and several towns share one turn-off, so reading
 * it as 70 stops invents a carry between Salida and Poncha Springs, which are the
 * same hitch from the same road. This module adds the missing step — the hiker
 * *chooses* — and then measures the legs properly: real ascent over the track,
 * Naismith hours, days from those hours, food weight.
 *
 * Three stages, deliberately separate so a UI can hold the middle one:
 *
 *   listResupplyOptions(resupplyCandidates(trail)) → options, clustered into groups
 *   resolveResupplyStops(groups, ids)   → the stops the selection implies
 *   computeResupplyLegs(trail, stops)   → the carries between them
 *
 * Platform-neutral and DOM-free: structural parameter types, so the web plan
 * page, the phone and an imported GPX all pass their own trail shapes.
 *
 * Off the route. A resupply is often somewhere the trail does not go, and the
 * walk (or hitch) there is part of the carry. Two sources say how far:
 *
 *  - a **side trip** the trail data draws to the place (Heysen's spur to
 *    Cudlee Creek, the AAWT's to Mt Hotham): `resupplyCandidates` offers the
 *    place at the side trip's junction, with the spur's length and climb;
 *  - a turn-off's own `offTrailKm` and `accessMode` (the CDT's, Te Araroa's).
 *
 * Only walked km go into a leg's hours, days and food: a side trip,
 * `accessMode: 'foot'`, or a distance whose mode the data does not give that
 * is short enough to be a walk ({@link WALKED_WHEN_UNSAID_MAX_KM}). A hitch,
 * shuttle or boat — or a longer unsaid distance — is reported beside the leg,
 * never walked: counting a 70 km hitch as three days of food would be as wrong
 * as leaving out a real 4 km walk into town.
 *
 * Nothing here is cached. `computeResupplyLegs` walks the track once per leg,
 * which on a web (full-resolution) track is real work — callers recompute only
 * when the selection, direction or section changes.
 *
 * Pace and hours per day are the caller's to supply, never this module's to
 * assume: how far a day is belongs to the hiker (CLAUDE.md, "the app informs the
 * hiker's decisions"). `computeResupplyLegs` therefore *requires* `dailyHours`
 * and `baseKmh` and throws on a figure it cannot walk at, rather than
 * substituting one — a silent fallback is how a fixed 4 km/h reached the web
 * page in the first place.
 */

import type { ComputedDay, SectionConfig } from './plan-types';
import type { AccessMode, WaypointAccess } from './types';
import { isAccessMode } from './types';
import type { PlanTrail } from './day-calculator';
import { estimateHikingHoursRaw } from './day-calculator';
import { calculateElevationBetween } from './track-geometry';
import { haversineDistance } from './distance';
import { routeBreakStarts } from './route-breaks';
import { isAccessWaypoint, isResupplyWaypoint } from './waypoint-taxonomy';
import type { FoodCarryEstimate, ResupplyGap, ResupplyPoint } from './resupply-calculator';
import {
  calculateFoodWeight,
  computeResupplyGaps,
  correlateResupplyWithDays,
  DEFAULT_GRAMS_PER_DAY,
  DEFAULT_LONG_THRESHOLD_DAYS,
} from './resupply-calculator';

/** Re-exported so a consumer of this module needs one import, not two. */
export type { AccessMode };

/**
 * The waypoint fields this module reads, declared structurally so every
 * platform's own waypoint type is accepted as-is: `EnrichedWaypoint`,
 * `PlanWaypoint`, and an imported trail's waypoints all satisfy it without
 * conversion. The off-trail four come from the shared {@link WaypointAccess}, so
 * they cannot drift from the parsed and built shapes.
 */
export interface ResupplyCandidateWaypoint extends WaypointAccess {
  id?: string;
  name?: string;
  type?: string;
  /** Cumulative km along the trail — the km field on every waypoint shape. */
  totalDistance?: number;
  description?: string;
  /** The walked route to the place, when the trail draws one (see {@link resupplyCandidates}). */
  accessRoute?: AccessRoute;
}

/**
 * A walked route from the trail to an off-trail place: a side trip the trail
 * data draws. Its length is the option's `offTrailKm`; this adds the climb,
 * which a turn-off's bare figure cannot know.
 */
export interface AccessRoute {
  /** The side trip's name ('S3.7 Spur to Cudlee Creek'). */
  name: string;
  /** Metres climbed walking in, from the junction to the place. */
  ascentM: number;
  /** Metres descended walking in. */
  descentM: number;
}

/** A side trip, as far as finding resupply on it goes. Structural, like the rest. */
export interface ResupplySideTrip {
  name: string;
  type: string;
  /** Junction km on the main route (direction-applied). */
  startDistance?: number;
  /** Length of the side trip, km. */
  distance: number;
  /** Climb and descent walking the whole side trip out from the junction. */
  elevation?: { ascent: number; descent: number };
  /** Junction first (`points[0]`), whichever way the trail is walked. */
  points?: readonly { lat: number; lon: number; ele: number }[];
  /** Absolute km: the junction's plus the distance along the side trip. */
  waypoints?: readonly ResupplyCandidateWaypoint[];
}

/** An off-route waypoint record, as `buildTrail` splits them out. */
export interface ResupplyOffTrailWaypoint extends ResupplyCandidateWaypoint {
  lat: number;
  lon: number;
}

/** What {@link resupplyCandidates} reads from a trail. */
export interface ResupplyTrail {
  waypoints?: readonly ResupplyCandidateWaypoint[];
  sideTrips?: readonly ResupplySideTrip[];
  offTrailWaypoints?: readonly ResupplyOffTrailWaypoint[];
}

/** One place a hiker could resupply, as offered to them to tick or not. */
export interface ResupplyOption {
  /** Registry id (`w_…`) or imported id (`uw_…`). Options without one are skipped. */
  id: string;
  name: string;
  /** town | town-access | food | … — kept verbatim, for the icon and the label. */
  type: string;
  /** Active-direction km of the point on the route, not of the place itself. */
  km: number;
  offTrailKm?: number;
  accessMode?: AccessMode;
  /** The side trip walked to reach it, when the trail draws one. */
  accessRoute?: AccessRoute;
  acceptsBoxes?: boolean;
  description?: string;
}

/**
 * The options reachable from one point on the route.
 *
 * From Monarch Pass you can hitch to Salida or to Poncha Springs, or buy what
 * the Crest Store has: three options, one turn-off, and at most one stop.
 */
export interface ResupplyOptionGroup {
  /** Stable across renders: the first option's id. */
  key: string;
  km: number;
  /** The turn-off's name, when the data names it; null for a plain on-trail town. */
  label: string | null;
  options: ResupplyOption[];
}

/** A group the hiker has ticked at least one option in. */
export interface ResupplyStop {
  km: number;
  /** The ticked options' names, joined — 'Salida / Poncha Springs'. */
  name: string;
  optionIds: string[];
  /** Getting from the route to the place and back; absent when the place is on it. */
  access?: StopAccess;
}

/**
 * How a stop is reached from the route, one way. A stop with several ticked
 * places (Salida / Poncha Springs) is measured to the one furthest to walk —
 * the food has to last the longer way — and failing any walk, the furthest
 * ride.
 */
export interface StopAccess {
  /** The place this is measured to. */
  place: string;
  /** km walked between the route and the place: a side trip, `foot` or `on-trail`. */
  walkKm: number;
  /** Metres climbed walking in (0 when the data gives a walk but no route). */
  walkAscentM: number;
  /** Metres descended walking in. */
  walkDescentM: number;
  /** The side trip walked, when there is one. */
  via?: string;
  /** km covered some other way: hitch, shuttle, boat, or an unsaid way too long to walk. */
  rideKm: number;
  /** How the ride is made; undefined when the data does not say. */
  rideMode?: Exclude<AccessMode, 'foot' | 'on-trail'>;
}

/** One not-walked stretch of a leg: the ride out of the stop it starts at, or into the one it ends at. */
export interface LegRide {
  km: number;
  mode?: StopAccess['rideMode'];
  end: 'from' | 'to';
}

/**
 * A carry between two stops (or between a stop and the end of the trail).
 *
 * Everything `ResupplyGap` has, plus what a flat km/day estimate cannot know:
 * the climb, the hours it implies, and the food that many days needs.
 */
export interface ResupplyLeg extends ResupplyGap {
  /**
   * Off-trail km walked on this leg: out of the stop it starts at, and in to
   * the one it ends at. `distanceKm` stays the trail km between the two
   * turn-offs, so the two read separately ("52.3 km + 4.0 km off trail").
   */
  offTrailWalkKm: number;
  /** Trail km plus off-trail walking: what the hours, days and food are worked from. */
  walkedKm: number;
  /** Off-trail km not walked (hitch, shuttle, boat, a long unsaid way): reported, never timed. */
  rides: LegRide[];
  /** Climb over the whole walk, off-trail walking included. */
  ascentM: number;
  descentM: number;
  /** Naismith hours over the track, rounded to 0.1 for display. */
  estimatedHours: number;
  /** max(1, ceil(hours / dailyHours)) — from the *unrounded* hours. */
  estimatedDays: number;
  food: FoodCarryEstimate;
  /** Arrival at the leg's far end, when the caller passes a camp plan. */
  arrival?: { day: number; date?: string };
}

export interface ListResupplyOptionsOptions {
  /**
   * How far apart two options may be and still count as the same turn-off.
   * The CDT's twins share a km exactly; 100 m absorbs a generator that projects
   * each town onto the route separately.
   */
  groupWithinKm?: number;
}

export interface ComputeResupplyLegsOptions {
  /** The hiker's walking hours per day. Drives days-per-leg, and so the food weight. */
  dailyHours: number;
  /** The hiker's Naismith flat-ground base speed (km/h) — `PACE_KMH[pace]`. */
  baseKmh: number;
  /** Scope the legs to a section: only stops inside it, ends at its bounds. */
  section?: SectionConfig | null;
  longThresholdDays?: number;
  gramsPerDay?: number;
  /** The camp plan, when there is one, to report which day each leg lands on. */
  days?: ComputedDay[];
}

export interface ResupplySummary {
  /** Stops the legs pass through; 0 with `hasData` is the full carry, start to end. */
  stops: number;
  longestKm: number;
  longestDays: number;
  totalFoodKg: number;
  hasData: boolean;
}

/**
 * An off-route town this close to a side trip's far end is reached by it, the
 * last stretch from the end of the line into town taken as a straight line:
 * Heysen's spur to Hahndorf stops 550 m short of the town's marker.
 */
export const SIDE_TRIP_END_REACH_M = 1000;

/** A side-trip waypoint closer than this to the junction is at the junction, on the route. */
const AT_JUNCTION_KM = 0.05;

/**
 * The longest off-trail distance taken to be walked when the data does not say
 * how it is covered — every one of Te Araroa's. Its turn-offs fall into two
 * groups with a gap between them: 3.1 km and under (Kerikeri 0.7, Mt Potts
 * Lodge 3.0), then 4.5 km and up (Warkworth 6, Te Anau 35). The CDT, whose data
 * does say, walks to a median 4 km and hitches from 6.4 km, so 5 km sits
 * between what gets walked and what gets hitched. A stated mode always wins.
 */
export const WALKED_WHEN_UNSAID_MAX_KM = 5;

/** Default grouping radius: the CDT's twins share a km, so this is slack, not need. */
export const DEFAULT_GROUP_WITHIN_KM = 0.1;

/** The boundary names `computeResupplyGaps` uses; re-stated so callers can match on them. */
const TRAIL_START_NAME = 'Trail Start';
const TRAIL_END_NAME = 'Trail End';

/** Floating-point slack, so a km difference of exactly the threshold still joins. */
const KM_EPSILON = 1e-9;

/** Reject a pace or hours figure this module would otherwise have to invent. */
function requirePositive(value: number, option: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`computeResupplyLegs: ${option} must be a positive number, got ${String(value)}`);
  }
  return value;
}

/**
 * Every waypoint that could be a resupply option: the main route's, plus the
 * places a side trip leads to, offered at the side trip's junction.
 *
 * A side trip's place is offered once, as an off-route option: at the
 * junction's km, `offTrailKm` the walk along the side trip to it, `accessMode`
 * `foot`, and the climb in `accessRoute`. It counts when it is:
 *
 *  - a resupply-family waypoint on the side trip itself, beyond the junction
 *    (one *at* the junction is a main-route place, and the main route lists it);
 *  - or an off-route resupply waypoint within {@link SIDE_TRIP_END_REACH_M} of
 *    the side trip's far end, which the walk reaches plus the straight line in.
 *
 * Ids already on the main route are never offered twice. Alternates and
 * termini are not side trips to a place and are not read. Off-route places no
 * side trip leads to stay out: a straight line is no measure of the walk.
 */
export function resupplyCandidates(trail: ResupplyTrail): ResupplyCandidateWaypoint[] {
  const main = trail.waypoints ?? [];
  const seen = new Set(main.map(wp => wp.id).filter((id): id is string => typeof id === 'string'));
  const extra: ResupplyCandidateWaypoint[] = [];

  const offer = (
    wp: ResupplyCandidateWaypoint,
    trip: ResupplySideTrip,
    junctionKm: number,
    walkKm: number,
    route: AccessRoute
  ) => {
    if (typeof wp.id !== 'string' || seen.has(wp.id)) return;
    seen.add(wp.id);
    extra.push({
      id: wp.id,
      name: wp.name,
      type: wp.type,
      description: wp.description,
      acceptsBoxes: wp.acceptsBoxes,
      totalDistance: junctionKm,
      offTrailKm: Math.round(walkKm * 10) / 10,
      accessMode: 'foot',
      accessName: wp.accessName ?? trip.name,
      accessRoute: route,
    });
  };

  for (const trip of trail.sideTrips ?? []) {
    const junctionKm = trip.startDistance;
    if (trip.type !== 'side-trip' || typeof junctionKm !== 'number' || !Number.isFinite(junctionKm)) continue;

    for (const wp of trip.waypoints ?? []) {
      if (!isResupplyWaypoint(wp.type) || typeof wp.totalDistance !== 'number') continue;
      const alongKm = wp.totalDistance - junctionKm;
      if (!(alongKm >= AT_JUNCTION_KM)) continue;
      offer(wp, trip, junctionKm, alongKm, { name: trip.name, ...climbAlong(trip, alongKm) });
    }

    const end = trip.points?.[trip.points.length - 1];
    if (!end) continue;
    for (const wp of trail.offTrailWaypoints ?? []) {
      if (!isResupplyWaypoint(wp.type)) continue;
      const remainderM = haversineDistance(end.lat, end.lon, wp.lat, wp.lon);
      if (remainderM > SIDE_TRIP_END_REACH_M) continue;
      offer(wp, trip, junctionKm, trip.distance + remainderM / 1000, {
        name: trip.name,
        ...climbAlong(trip, trip.distance),
      });
    }
  }

  return extra.length === 0 ? [...main] : [...main, ...extra];
}

/**
 * Climb and descent walking a side trip from its junction to `alongKm` along
 * it. The whole trip's figures come from the full-resolution build; the
 * points may be thinned (the phone's are), which under-counts climb, so the
 * part walked is measured on the points and scaled to the whole trip's totals.
 */
function climbAlong(trip: ResupplySideTrip, alongKm: number): { ascentM: number; descentM: number } {
  const points = trip.points ?? [];
  let distM = 0;
  let up = 0;
  let down = 0;
  let upAll = 0;
  let downAll = 0;
  let reached = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const diff = b.ele - a.ele;
    if (diff > 0) upAll += diff;
    else downAll -= diff;
    if (reached) continue;
    distM += haversineDistance(a.lat, a.lon, b.lat, b.lon);
    if (diff > 0) up += diff;
    else down -= diff;
    if (distM >= alongKm * 1000) reached = true;
  }
  const total = trip.elevation;
  const ascentM = total && upAll > 0 ? (up * total.ascent) / upAll : up;
  const descentM = total && downAll > 0 ? (down * total.descent) / downAll : down;
  return { ascentM: Math.round(ascentM), descentM: Math.round(descentM) };
}

/**
 * Every resupply the trail offers, clustered by where you leave the route.
 *
 * An option needs a resupply-family `type`, a string `id` (it is what a saved
 * selection stores) and a finite km. Off-trail waypoint records and POIs never
 * reach here — the former are split out by `buildTrail`, the latter are not
 * waypoints at all — but an id-less waypoint is skipped rather than trusted.
 *
 * Grouping walks the km-sorted options and joins each to the previous one when
 * they are within `groupWithinKm`, so a chain of near-neighbours is one group.
 */
export function listResupplyOptions(
  waypoints: readonly ResupplyCandidateWaypoint[] | undefined,
  opts: ListResupplyOptionsOptions = {}
): ResupplyOptionGroup[] {
  const groupWithinKm = Math.max(0, opts.groupWithinKm ?? DEFAULT_GROUP_WITHIN_KM);

  // The turn-off's name is a property of the *group*, not of an option, so it is
  // carried alongside rather than on `ResupplyOption`.
  const accessNames = new Map<string, string>();

  const options: ResupplyOption[] = (waypoints ?? [])
    .filter(
      wp =>
        isResupplyWaypoint(wp.type) &&
        typeof wp.id === 'string' &&
        wp.id.length > 0 &&
        typeof wp.totalDistance === 'number' &&
        Number.isFinite(wp.totalDistance)
    )
    .map(wp => {
      const option: ResupplyOption = {
        id: wp.id as string,
        name: wp.name ?? 'Resupply',
        type: wp.type ?? 'resupply',
        km: wp.totalDistance as number,
      };
      if (typeof wp.offTrailKm === 'number' && Number.isFinite(wp.offTrailKm)) {
        option.offTrailKm = wp.offTrailKm;
      }
      // Guarded rather than copied: a handed-off or imported trail's JSON can
      // carry anything under this key.
      if (isAccessMode(wp.accessMode)) option.accessMode = wp.accessMode;
      if (wp.accessRoute) option.accessRoute = wp.accessRoute;
      if (typeof wp.acceptsBoxes === 'boolean') option.acceptsBoxes = wp.acceptsBoxes;
      if (typeof wp.description === 'string' && wp.description) option.description = wp.description;
      if (typeof wp.accessName === 'string' && wp.accessName.trim() !== '') {
        accessNames.set(option.id, wp.accessName.trim());
      }
      return option;
    })
    .sort((a, b) => a.km - b.km);

  const groups: ResupplyOptionGroup[] = [];
  let current: ResupplyOptionGroup | null = null;
  let previousKm = 0;

  for (const option of options) {
    if (current && option.km - previousKm <= groupWithinKm + KM_EPSILON) {
      current.options.push(option);
    } else {
      current = { key: option.id, km: option.km, label: null, options: [option] };
      groups.push(current);
    }
    previousKm = option.km;
  }

  // Labelled by whichever option in the group names the turn-off. Both CDT twins
  // at Monarch Pass name it; the Crest Store, being on the route itself, does not.
  for (const group of groups) {
    for (const option of group.options) {
      const name = accessNames.get(option.id);
      if (name) {
        group.label = name;
        break;
      }
    }
  }

  return groups;
}

/**
 * Turn a selection into stops.
 *
 * `undefined` means "nothing has been chosen yet", which is every option ticked
 * — today's behaviour, and the only default that cannot silently hide a town
 * from someone who never opened the list. An explicit `[]` is a real choice and
 * yields no stops.
 *
 * Ids the trail no longer has are ignored rather than failing, so a selection
 * saved against an older build still loads.
 */
export function resolveResupplyStops(
  groups: readonly ResupplyOptionGroup[],
  selectedIds: readonly string[] | undefined
): ResupplyStop[] {
  const selected = selectedIds ? new Set(selectedIds) : null;
  const stops: ResupplyStop[] = [];

  for (const group of groups) {
    const picked = selected ? group.options.filter(option => selected.has(option.id)) : group.options;
    if (picked.length === 0) continue;
    const stop: ResupplyStop = {
      km: group.km,
      name: picked.map(option => option.name).join(' / '),
      optionIds: picked.map(option => option.id),
    };
    const access = stopAccess(picked);
    if (access) stop.access = access;
    stops.push(stop);
  }

  return stops;
}

/**
 * How one option is reached from the route, or null when it is on it. Exported
 * for the surfaces that show a single option (a turn-off's detail).
 */
export function optionAccess(
  option: Pick<ResupplyOption, 'name' | 'offTrailKm' | 'accessMode' | 'accessRoute'>
): StopAccess | null {
  const km = offTrailKmOf(option);
  if (km === 0) return null;
  // An 'on-trail' place with a distance contradicts itself; the distance is
  // what the hiker covers, and on-trail means on foot (as `accessSummary` reads it).
  // With no mode at all, a short distance is a walk and a long one a ride.
  const walked =
    option.accessRoute != null ||
    option.accessMode === 'foot' ||
    option.accessMode === 'on-trail' ||
    (option.accessMode === undefined && km <= WALKED_WHEN_UNSAID_MAX_KM);
  if (walked) {
    const access: StopAccess = {
      place: option.name,
      walkKm: km,
      walkAscentM: option.accessRoute?.ascentM ?? 0,
      walkDescentM: option.accessRoute?.descentM ?? 0,
      rideKm: 0,
    };
    if (option.accessRoute) access.via = option.accessRoute.name;
    return access;
  }
  const access: StopAccess = { place: option.name, walkKm: 0, walkAscentM: 0, walkDescentM: 0, rideKm: km };
  // 'foot' was walked above and 'on-trail' returned null, so what is left rides.
  const mode = option.accessMode;
  if (mode === 'hitch' || mode === 'shuttle' || mode === 'boat') access.rideMode = mode;
  return access;
}

/** The access a stop is measured by: the longest walk among its ticks, else the longest ride. */
function stopAccess(picked: readonly ResupplyOption[]): StopAccess | null {
  let best: StopAccess | null = null;
  for (const option of picked) {
    const access = optionAccess(option);
    if (!access) continue;
    if (
      !best ||
      access.walkKm > best.walkKm ||
      (access.walkKm === best.walkKm && access.rideKm > best.rideKm)
    ) {
      best = access;
    }
  }
  return best;
}

/** Every option id the trail offers, in group order — the "All" selection. */
export function allResupplyOptionIds(groups: readonly ResupplyOptionGroup[]): string[] {
  return groups.flatMap(group => group.options.map(option => option.id));
}

/**
 * The waypoints a selection marks as *planned resupply points*, for the surfaces
 * that highlight them (the phone's map, profile, list, detail and distance strip).
 *
 * `null` in — nothing has been chosen yet — is `null` out: the every-option
 * default feeds the legs, but painting every town as "planned" before anyone
 * planned anything would be noise, not information.
 *
 * Every ticked id is planned. On top of that, a ticked place pulls in the point
 * on the route that serves it, because that is the km the hiker's food has to
 * reach — but *only* that point, never another destination on the same hitch.
 * {@link isTurnOffFor} is where the two are told apart, and the distinction is
 * the whole point of this function: at the CDT's Monarch Pass, Salida (35 km
 * one way) and Poncha Springs (27 km the other) are two options in one group,
 * and a highlight saying "your food reaches here" about the town the hiker did
 * not choose is worse than no highlight at all.
 *
 * Ids no group has are dropped, the way `resolveResupplyStops` ignores them.
 */
export function plannedResupplyIds(
  groups: readonly ResupplyOptionGroup[],
  selectedIds: ReadonlySet<string> | null
): ReadonlySet<string> | null {
  if (!selectedIds) return null;

  const planned = new Set<string>();
  for (const group of groups) {
    const ticked = group.options.filter(option => selectedIds.has(option.id));
    if (ticked.length === 0) continue;
    for (const option of ticked) planned.add(option.id);
    for (const option of group.options) {
      if (ticked.some(pick => isTurnOffFor(option, pick))) planned.add(option.id);
    }
  }
  return planned;
}

/**
 * Is `option` the route point a hiker leaves at to reach `ticked` — rather than
 * a second destination reached from the same place?
 *
 * It has to be access-typed to begin with (`town-access`, `resupply-access`, …),
 * which is how the data says "you are not there yet". Then one of two things
 * makes it this ticked option's turn-off:
 *
 *  - It carries no off-trail distance of its own, so the data places it on the
 *    route. That is a turn-off for whatever the hiker ticked in its group.
 *  - It is the *same place* as a ticked destination, recorded twice: Te Araroa
 *    ships `Kerikeri` (`town`, 0.7 km off) and `Kerikeri turnoff` (`town-access`,
 *    0.7 km off) as a pair, the second being where you leave the route for the
 *    first. Matching on the off-trail distance is what identifies the pair, so a
 *    ticked place only ever pulls in the access record that describes it.
 *
 * Neither holds between two CDT towns on one hitch: both are access-typed (so
 * neither is anybody's turn-off under the second rule, which needs a ticked
 * *destination*) and both are kilometres off the route. `resolveResupplyStops`
 * needs no such test — it reads ticks only, and a group's stop sits at the
 * group's own km either way.
 */
function isTurnOffFor(option: ResupplyOption, ticked: ResupplyOption): boolean {
  if (option.id === ticked.id || !isAccessWaypoint(option.type)) return false;
  const off = offTrailKmOf(option);
  if (off === 0) return true;
  return !isAccessWaypoint(ticked.type) && Math.abs(off - offTrailKmOf(ticked)) < KM_EPSILON;
}

/** How far off the route an option is; an absent or unusable figure means "on it". */
function offTrailKmOf(option: Pick<ResupplyOption, 'offTrailKm'>): number {
  return typeof option.offTrailKm === 'number' && option.offTrailKm > 0 ? option.offTrailKm : 0;
}

/**
 * The carries implied by a set of stops: trail start → stop 1 → … → trail end.
 *
 * No stops in range — "None" ticked, a trail with no options, or a section
 * none of the ticked stops falls in — is one leg from the range start to its
 * end, the *full carry*, with every field any other leg has. Only an empty
 * range returns no legs.
 *
 * Boundary behaviour is `computeResupplyGaps`', because it *is*
 * `computeResupplyGaps` — the gaps it returns are then measured properly. What
 * this adds is elevation (route-break aware, so a ferry's landing-to-landing
 * height difference is never climbed), Naismith hours over that climb, days from
 * those hours rather than from a flat km/day, and the food those days weigh.
 *
 * `distanceKm` stays plain km subtraction between the two turn-offs: the
 * cumulative scale already excludes route-break gaps, so there is nothing to
 * correct. On top of it, a leg walks out of the stop it starts at and in to
 * the one it ends at ({@link StopAccess}): walked km and their climb go into
 * the hours, days and food, ridden km are listed in `rides` and never timed.
 *
 * Legs come out in the order of the trail passed in. Callers hand over the
 * direction-applied trail, as they do to `computeDays`.
 *
 * @throws RangeError if `dailyHours` or `baseKmh` is not a positive finite
 *   number. Both are the hiker's figures; a caller without one is a bug, not a
 *   case to paper over with a default.
 */
export function computeResupplyLegs(
  trail: PlanTrail,
  stops: readonly ResupplyStop[],
  opts: ComputeResupplyLegsOptions
): ResupplyLeg[] {
  const dailyHours = requirePositive(opts.dailyHours, 'dailyHours');
  const baseKmh = requirePositive(opts.baseKmh, 'baseKmh');
  const longThresholdDays = opts.longThresholdDays ?? DEFAULT_LONG_THRESHOLD_DAYS;
  const gramsPerDay = opts.gramsPerDay ?? DEFAULT_GRAMS_PER_DAY;

  const section = opts.section;
  const rangeStartKm = section ? section.startKm : 0;
  const rangeEndKm = section ? section.endKm : trail.track.totalDistance;

  // `type` is unread by computeResupplyGaps; a stop is several waypoints' worth
  // of types anyway, so there is no honest single value to give it.
  const inRange = stops.filter(stop => stop.km >= rangeStartKm && stop.km <= rangeEndKm);
  // computeResupplyGaps keeps the first of two stops at one km; so does this.
  const accessAt = new Map<number, StopAccess | undefined>();
  for (const stop of inRange) if (!accessAt.has(stop.km)) accessAt.set(stop.km, stop.access);

  const points: ResupplyPoint[] = inRange
    .map(stop => ({ name: stop.name, km: stop.km, type: 'resupply' }))
    .sort((a, b) => a.km - b.km);

  const gaps = computeResupplyGaps(points, rangeStartKm, rangeEndKm, undefined, longThresholdDays);
  if (gaps.length === 0) return [];

  const trackPoints = trail.track.points;
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');

  // Which day each leg *ends* on, including the run-in to the trail end.
  const arrivals = opts.days
    ? correlateResupplyWithDays(
        gaps.map(gap => ({ name: gap.toName, km: gap.toKm, type: 'resupply' })),
        opts.days
      )
    : null;

  return gaps.map((gap, i) => {
    const { gain, loss } = calculateElevationBetween(gap.fromKm, gap.toKm, trackPoints, breakStarts);
    // The trail start and end are on the route; only stops have a way off it.
    const out = gap.fromName === TRAIL_START_NAME && gap.fromKm === rangeStartKm ? undefined : accessAt.get(gap.fromKm);
    const into = gap.toName === TRAIL_END_NAME && gap.toKm === rangeEndKm ? undefined : accessAt.get(gap.toKm);

    // Walking out of a town climbs what walking in descended.
    const offTrailWalkKm = (out?.walkKm ?? 0) + (into?.walkKm ?? 0);
    const ascentM = gain + (out?.walkDescentM ?? 0) + (into?.walkAscentM ?? 0);
    const descentM = loss + (out?.walkAscentM ?? 0) + (into?.walkDescentM ?? 0);
    const walkedKm = gap.distanceKm + offTrailWalkKm;
    const rides: LegRide[] = [];
    if (out && out.rideKm > 0) rides.push(rideOf(out, 'from'));
    if (into && into.rideKm > 0) rides.push(rideOf(into, 'to'));

    const rawHours = estimateHikingHoursRaw(walkedKm, ascentM, descentM, baseKmh);
    const estimatedDays = Math.max(1, Math.ceil(rawHours / dailyHours));

    const leg: ResupplyLeg = {
      ...gap,
      offTrailWalkKm: Math.round(offTrailWalkKm * 10) / 10,
      walkedKm: Math.round(walkedKm * 10) / 10,
      rides,
      ascentM,
      descentM,
      estimatedHours: Math.round(rawHours * 10) / 10,
      estimatedDays,
      isLong: estimatedDays > longThresholdDays,
      food: calculateFoodWeight(estimatedDays, gramsPerDay),
    };

    const arrival = arrivals?.[i];
    if (arrival && arrival.arrivalDay > 0) {
      leg.arrival = arrival.arrivalDate
        ? { day: arrival.arrivalDay, date: arrival.arrivalDate }
        : { day: arrival.arrivalDay };
    }

    return leg;
  });
}

function rideOf(access: StopAccess, end: LegRide['end']): LegRide {
  const ride: LegRide = { km: access.rideKm, end };
  if (access.rideMode) ride.mode = access.rideMode;
  return ride;
}

/**
 * The resupply stop the hiker reaches next from `currentKm` (direction-applied),
 * or null past the last one. A stop within 50 m behind counts as reached.
 */
export function nextResupplyStop(
  stops: readonly ResupplyStop[],
  currentKm: number
): ResupplyStop | null {
  let next: ResupplyStop | null = null;
  for (const stop of stops) {
    if (stop.km > currentKm && (!next || stop.km < next.km)) next = stop;
  }
  return next;
}

/**
 * The one-line version of a set of legs, for the summary above the datasheet.
 *
 * `stops` is recovered from the legs' own endpoints rather than counted
 * separately, so the summary can never disagree with the table it sits above —
 * every endpoint that is not the trail start or end is a stop, counted by km so
 * two towns of the same name are still one place.
 */
export function summariseResupplyLegs(legs: readonly ResupplyLeg[]): ResupplySummary {
  const stopKms = new Set<number>();
  let longestKm = 0;
  let longestDays = 0;
  let totalFoodGrams = 0;

  for (const leg of legs) {
    if (leg.fromName !== TRAIL_START_NAME) stopKms.add(leg.fromKm);
    if (leg.toName !== TRAIL_END_NAME) stopKms.add(leg.toKm);
    // The carry is what is walked with the food, off-trail walking included.
    longestKm = Math.max(longestKm, leg.walkedKm);
    longestDays = Math.max(longestDays, leg.estimatedDays);
    totalFoodGrams += leg.food.weightGrams;
  }

  return {
    stops: stopKms.size,
    longestKm,
    longestDays,
    totalFoodKg: Math.round(totalFoodGrams / 100) / 10,
    hasData: legs.length > 0,
  };
}
