/**
 * The Stops list's data layer: which places the planner offers, in both km
 * spaces. (Suggestions over these places live in `plan-suggest.ts`.)
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

import {
  isStopSelected,
  overnightCandidates,
  type ToggleTarget,
  type StopKey,
} from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import { KM_EPSILON, toActiveKm, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import { calculateElevationBetween, type ElevationPoint } from '@lib/track-geometry';
import type { TrailJson } from '../../services/trail-assets';
import type { Direction } from '../../state/settings-store';

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

/** The walk to a place from the stop before it — the day so far, were you to stop there. */
export interface StopLeg {
  /** km from the previous stop (or the section start) to this place. */
  distanceKm: number;
  /** Metres climbed over that stretch. */
  ascentM: number;
  /** Metres descended over that stretch. */
  descentM: number;
}

/**
 * Each candidate's leg from the stop before it, so the Stops list reads as a
 * day being built: figures count up from zero after every ticked stop.
 *
 * Measured on the direction-applied guide trail (`activeKm`), from the latest
 * of the section start and the plan's stops behind the place. A ticked place
 * measures from the stop before it (its row shows the whole day it ends); an
 * unticked place measures from the last stop at or behind it. A place behind
 * the section start counts from the trail start.
 *
 * `breakStarts` is `routeBreakStarts(track.breaks, 'points')`, so a ferry is
 * never climbed (and is ignored when the points carry cumulative elevation).
 */
export function stopLegs(
  candidates: StopCandidate[],
  plan: PlanDocument | undefined,
  opts: {
    direction: PlanDirection;
    /** The trail's `track.totalDistance` — the mirror for a reversed guide. */
    totalDistance: number;
    sectionStartKm: number;
    points: ElevationPoint[];
    breakStarts?: ReadonlySet<number>;
  },
): Map<string, StopLeg> {
  const stopKms = (plan?.stops ?? []).map((s) =>
    toActiveKm(s.km, opts.direction, opts.totalDistance),
  );
  const anchors = [opts.sectionStartKm, ...stopKms].sort((a, b) => a - b);

  const legs = new Map<string, StopLeg>();
  for (const candidate of candidates) {
    const km = candidate.activeKm;
    // The same test as the row's checkbox, so the figures and the tick agree.
    const ticked = plan !== undefined && isStopSelected(plan, stopKeyOf(candidate));
    let from = 0;
    for (const anchor of anchors) {
      const behind = ticked ? anchor < km - KM_EPSILON : anchor <= km + KM_EPSILON;
      if (!behind) break;
      from = anchor;
    }
    const distanceKm = Math.max(0, km - from);
    const { gain, loss } =
      distanceKm > 0
        ? calculateElevationBetween(from, km, opts.points, opts.breakStarts)
        : { gain: 0, loss: 0 };
    legs.set(candidate.key, { distanceKm, ascentM: gain, descentM: loss });
  }
  return legs;
}
