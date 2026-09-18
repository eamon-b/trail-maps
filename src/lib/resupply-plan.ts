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
 *   listResupplyOptions(waypoints)      → options, clustered into groups
 *   resolveResupplyStops(groups, ids)   → the stops the selection implies
 *   computeResupplyLegs(trail, stops)   → the carries between them
 *
 * Platform-neutral and DOM-free: structural parameter types, so the web plan
 * page, the phone and an imported GPX all pass their own trail shapes.
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
}

/**
 * A carry between two stops (or between a stop and the end of the trail).
 *
 * Everything `ResupplyGap` has, plus what a flat km/day estimate cannot know:
 * the climb, the hours it implies, and the food that many days needs.
 */
export interface ResupplyLeg extends ResupplyGap {
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
  /** Scope the legs to a section, exactly as `analyzeResupplyForSection` does. */
  section?: SectionConfig | null;
  longThresholdDays?: number;
  gramsPerDay?: number;
  /** The camp plan, when there is one, to report which day each leg lands on. */
  days?: ComputedDay[];
}

export interface ResupplySummary {
  stops: number;
  longestKm: number;
  longestDays: number;
  totalFoodKg: number;
  hasData: boolean;
}

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
    stops.push({
      km: group.km,
      name: picked.map(option => option.name).join(' / '),
      optionIds: picked.map(option => option.id),
    });
  }

  return stops;
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
 * A place and its turn-off are two waypoints (Kerikeri the town, `Kerikeri
 * turnoff` the `town-access` point on the route), and both belong to the plan
 * when either is ticked: the turn-off is the km the hiker's food has to reach.
 * So every ticked id is planned, plus every turn-off sharing a group with one.
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
      if (isAccessWaypoint(option.type)) planned.add(option.id);
    }
  }
  return planned;
}

/**
 * The carries implied by a set of stops: trail start → stop 1 → … → trail end.
 *
 * Boundary behaviour is `computeResupplyGaps`', because it *is*
 * `computeResupplyGaps` — the gaps it returns are then measured properly. What
 * this adds is elevation (route-break aware, so a ferry's landing-to-landing
 * height difference is never climbed), Naismith hours over that climb, days from
 * those hours rather than from a flat km/day, and the food those days weigh.
 *
 * Distance stays plain km subtraction: the cumulative scale already excludes
 * route-break gaps, so there is nothing to correct.
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
  const points: ResupplyPoint[] = stops
    .filter(stop => stop.km >= rangeStartKm && stop.km <= rangeEndKm)
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
    const rawHours = estimateHikingHoursRaw(gap.distanceKm, gain, loss, baseKmh);
    const estimatedDays = Math.max(1, Math.ceil(rawHours / dailyHours));

    const leg: ResupplyLeg = {
      ...gap,
      ascentM: gain,
      descentM: loss,
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
    longestKm = Math.max(longestKm, leg.distanceKm);
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
