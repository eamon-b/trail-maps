/**
 * The Stops list's data layer: which places the planner offers, and where the
 * "Suggest stops" button's one-shot split lands.
 *
 * Two km spaces meet here and must not be confused (`@lib/plan-direction` is
 * the contract). The guide trail is DIRECTION-APPLIED — a reversed guide's
 * `totalDistance` counts from the other end — while a `PlanStop` is stored
 * NOBO-absolute, so a plan survives a direction flip untouched. Every candidate
 * therefore carries both: `activeKm` for display and for anything measured
 * against the guide trail, `noboKm` for anything that goes into the document.
 *
 * Pure and React-free, so the conversion can be tested without a renderer.
 */

import { buildTimeIndex, type PlanTrail } from '@lib/day-calculator';
import { overnightCandidates, type ToggleTarget, type StopKey } from '@lib/plan-editor';
import { toNoboKm, type PlanDirection } from '@lib/plan-direction';
import { routeBreakStarts } from '@lib/route-breaks';
import type { SectionConfig } from '@lib/plan-types';
import type { TrailJson } from '../../services/trail-assets';
import type { Direction } from '../../state/settings-store';
import { generateDayStops } from './plan-adapters';

/** A place the Stops list offers, in both km spaces. */
export interface StopCandidate {
  /** Stable list key: the waypoint id when the trail has one, else its km. */
  key: string;
  /** Registry id (`w_…`/`uw_…`) when the waypoint has one. */
  waypointId?: string;
  name: string;
  type: string;
  /** km along the trail as the hiker is currently walking it (display). */
  activeKm: number;
  /** NOBO-absolute km — what a `PlanStop` stores. */
  noboKm: number;
}

/** The guide's direction setting as the plan document's direction enum. */
export function planDirectionOf(direction: Direction): PlanDirection {
  return direction === 'reversed' ? 'SOBO' : 'NOBO';
}

/** The key that identifies this candidate's stop inside a plan document. */
export function stopKeyOf(candidate: StopCandidate): StopKey {
  return { waypointId: candidate.waypointId, km: candidate.noboKm };
}

/** The candidate as `toggleStop`'s argument. */
export function toggleTargetOf(candidate: StopCandidate): ToggleTarget {
  return { id: candidate.waypointId, km: candidate.noboKm, name: candidate.name };
}

/**
 * One waypoint of a direction-applied guide trail as a stop candidate.
 *
 * Exported because the waypoint detail screen needs exactly this for the one
 * waypoint it is showing, and re-deriving the NOBO conversion there is how the
 * two screens would eventually disagree about which stop a tap means.
 */
export function stopCandidateOf(
  wp: TrailJson['waypoints'][number],
  direction: PlanDirection,
  totalDistance: number,
): StopCandidate {
  const activeKm = wp.totalDistance ?? 0;
  const noboKm = toNoboKm(activeKm, direction, totalDistance);
  return {
    // A waypoint with no id is keyed by km: the array index would change under
    // a direction flip (the list re-sorts), and React would reuse the wrong
    // row's expanded editor.
    key: wp.id ?? `km:${noboKm.toFixed(3)}`,
    ...(wp.id ? { waypointId: wp.id } : {}),
    name: wp.name,
    type: wp.type,
    activeKm,
    noboKm,
  };
}

/** Options for `stopCandidates`. */
export interface StopCandidateOptions {
  /**
   * List every waypoint rather than only the places you can sleep. The Stops
   * list's "All waypoints" switch — off by default, because a trail's waypoint
   * list is mostly water sources and junctions and scrolling it to find a hut
   * is the thing the planner exists to avoid.
   */
  all?: boolean;
}

/**
 * The places offered as stops, in walking order.
 *
 * The default set is `@lib/plan-editor`'s `overnightCandidates` with its shared
 * default (`includeTowns: true`) — for a list you tap, a town is the commonest
 * place to spend a night. That is deliberately WIDER than the day-boundary
 * snapper's set in `plan-adapters.overnightWaypoints`, which passes
 * `includeTowns: false` so a generated boundary lands on a camp or a hut.
 */
export function stopCandidates(
  trail: TrailJson,
  direction: PlanDirection,
  opts: StopCandidateOptions = {},
): StopCandidate[] {
  const total = trail.track.totalDistance;
  const source = opts.all
    ? [...trail.waypoints].sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0))
    : overnightCandidates(trail.waypoints);
  return source.map((wp) => stopCandidateOf(wp, direction, total));
}

/**
 * The stops the hours-and-pace splitter would pick for this section, as
 * candidates — what "Suggest stops" fills an empty plan with.
 *
 * Wild-camp boundaries are dropped. The splitter invents them at a bare km
 * when no camp is in range, and a plan stop is a PLACE: it carries a waypoint
 * id, shows services, and is what a rest day is spent at. A km with no
 * waypoint behind it would be a stop you cannot look up, so the suggestion
 * simply offers one fewer day boundary and leaves the hiker to place it.
 */
export function suggestedStops(
  trail: TrailJson,
  section: SectionConfig,
  targetHours: number,
  baseKmh: number,
  direction: PlanDirection,
): StopCandidate[] {
  const planTrail = trail as unknown as PlanTrail;
  const index = buildTimeIndex(
    planTrail.track.points,
    routeBreakStarts(planTrail.track.breaks, 'points'),
  );
  const { stops, snappedKms } = generateDayStops(trail, section, targetHours, baseKmh, index);
  const byKm = new Map<number, StopCandidate>();
  for (const candidate of stopCandidates(trail, direction, { all: true })) {
    if (!byKm.has(candidate.activeKm)) byKm.set(candidate.activeKm, candidate);
  }
  const picked: StopCandidate[] = [];
  for (const stop of stops) {
    if (!snappedKms.has(stop.km)) continue;
    const candidate = byKm.get(stop.km);
    if (candidate) picked.push(candidate);
  }
  return picked;
}
