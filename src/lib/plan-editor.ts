/**
 * Shared plan editor — pure functions over a `PlanDocument`.
 *
 * The day planner is one document per trail per user, edited by tapping places
 * on or off a list. Every edit on either platform goes through this module, so
 * the web page and the phone cannot drift apart on what a stop is, what a stop
 * key matches, how nights push the dates along, or what the limits are.
 *
 * Rules that hold for everything here:
 *
 * - **Never mutates.** Each editor returns a NEW `PlanDocument` (and new stop
 *   objects for the stops it changed); the input is untouched, so a caller can
 *   keep the previous document for an undo or a reference-equality re-render
 *   check. When an edit is a no-op the *same* document is returned, which is
 *   exactly the signal a store wants ("nothing changed, don't write").
 * - **Stops are stored NOBO-absolute.** `plan-direction.ts` is the km-space
 *   contract; `direction` is a view setting, and flipping it never rewrites a
 *   km. Callers that work in the active direction convert with `toNoboKm`
 *   before calling `toggleStop`, and read back through `stopsToActive`.
 * - **RN-safe.** No DOM, no Node, no `crypto` import. The one thing this module
 *   cannot do for itself is mint a uuid, so `idFactory` is injected (see
 *   `defaultIdFactory`) — never a `Math.random` shim, because the id is the
 *   server's idempotency key.
 * - **Stop identity is id first, km second.** A stop carries the waypoint's
 *   registry id whenever the trail has one; `km` is the key only for a stop
 *   migrated from the km-keyed `PlanState` that matched no waypoint. Matching
 *   by km alone would conflate waypoints that sit 10 m apart — see
 *   `KM_EPSILON`.
 */

import type { PlanDirection } from './plan-direction';
import { KM_EPSILON, stopsToActive } from './plan-direction';
import type { ComputedDay, PlanDocument, PlanState, PlanStop, PlanWaypoint, SectionConfig } from './plan-types';
import { PLAN_LIMITS, PLAN_WAYPOINT_ID_PATTERN, isStoredZeroDays } from './plan-types';
import { computeDays, isStopAtPlace, stopWalk, type PlanStopInput, type PlanTrail } from './day-calculator';
import type { TrailPOI } from './trail-types';
import { baseWaypointType, isAccessWaypoint } from './waypoint-taxonomy';
import { allResupplyOptionIds, resupplyGroupChoice, type ResupplyOptionGroup } from './resupply-plan';

// ---------------------------------------------------------------------------
// Injected clock and id source
// ---------------------------------------------------------------------------

/** Options every editor accepts: the clock that stamps `updatedAt`. */
export interface PlanEditOptions {
  /**
   * ISO timestamp source for `updatedAt`. Default `new Date().toISOString()`.
   * An edit is always stamped at least 1 ms after the document it edits.
   */
  now?: () => string;
}

/** Options for the editors that add stops. */
export interface StopEditOptions extends PlanEditOptions {
  /**
   * The trail's length (`track.totalDistance`). With it, a place at the trail
   * end is refused as well as one at km 0 — see `toggleStop`.
   */
  totalKm?: number;
}

/** Options for the editors that mint an id as well. */
export interface PlanCreateOptions extends PlanEditOptions {
  /**
   * uuid v4 source. Default: `globalThis.crypto.randomUUID` where it exists.
   * React Native has no `crypto.randomUUID` under Hermes — pass
   * `globalThis.expo.uuidv4` (what `mobile/src/api` already uses).
   */
  idFactory?: () => string;
}

/**
 * The default uuid source, or a clear error.
 *
 * Deliberately no `Math.random` fallback: this id is the server's idempotency
 * key for `PUT /v1/plans/:id`, so a weak generator is a cross-user collision,
 * not a cosmetic wart. A runtime without `crypto.randomUUID` must say which
 * generator it wants.
 */
function defaultIdFactory(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  throw new Error(
    'plan-editor: no uuid source available — pass opts.idFactory ' + '(React Native: globalThis.expo.uuidv4)'
  );
}

function mintId(opts?: PlanCreateOptions): string {
  return (opts?.idFactory ?? defaultIdFactory)();
}

/**
 * The `updatedAt` for an edit: the clock, but never at or before the copy
 * being edited (`previous`), which may carry the server's clock. A phone a
 * second behind the server would otherwise stamp its edit *older* than the
 * document it edited, and last-writer-wins would throw the edit away.
 */
export function stamp(opts?: PlanEditOptions, previous?: string): string {
  const now = (opts?.now ?? (() => new Date().toISOString()))();
  if (previous === undefined) return now;
  const nowMs = Date.parse(now);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(nowMs) || !Number.isFinite(previousMs) || nowMs > previousMs) return now;
  return new Date(previousMs + 1).toISOString();
}

// ---------------------------------------------------------------------------
// Stop identity
// ---------------------------------------------------------------------------

/**
 * How a stop is named when looking it up: its waypoint id when the trail has
 * one, its km otherwise. `km` is required even when an id is present because
 * it is the fallback key and the sort key.
 */
export interface StopKey {
  waypointId?: string;
  /** NOBO-absolute km. */
  km: number;
}

/** The place a toggle is about: a waypoint the user tapped. */
export interface ToggleTarget {
  /** Waypoint registry id (`w_…`) or an import's `uw_…`, when there is one. */
  id?: string;
  /** NOBO-absolute km — convert with `toNoboKm` if you are holding active km. */
  km: number;
  name: string;
}

function sameStop(stop: PlanStop, key: StopKey): boolean {
  if (key.waypointId && stop.waypointId) return stop.waypointId === key.waypointId;
  // An id on one side only is not a mismatch: a legacy km-only stop has no id
  // to compare, and it is the same place if it sits at the same km.
  return Math.abs(stop.km - key.km) < KM_EPSILON;
}

/** Index of the stop `key` names, or -1. Id first, then km within `KM_EPSILON`. */
export function findStopIndex(plan: PlanDocument, key: StopKey): number {
  if (key.waypointId) {
    const byId = plan.stops.findIndex(stop => stop.waypointId === key.waypointId);
    if (byId !== -1) return byId;
  }
  return plan.stops.findIndex(stop => sameStop(stop, key));
}

/** The stop `key` names, or `undefined`. */
export function findStop(plan: PlanDocument, key: StopKey): PlanStop | undefined {
  const index = findStopIndex(plan, key);
  return index === -1 ? undefined : plan.stops[index];
}

/** True when this place is already a stop of the plan. */
export function isStopSelected(plan: PlanDocument, key: StopKey): boolean {
  return findStopIndex(plan, key) !== -1;
}

// ---------------------------------------------------------------------------
// Document creation and whole-document edits
// ---------------------------------------------------------------------------

function withStops(plan: PlanDocument, stops: PlanStop[], opts?: PlanEditOptions): PlanDocument {
  return { ...plan, stops, updatedAt: stamp(opts, plan.updatedAt) };
}

function sortStops(stops: PlanStop[]): PlanStop[] {
  return [...stops].sort((a, b) => a.km - b.km);
}

function clampName(name: string): string {
  return name.trim().slice(0, PLAN_LIMITS.nameMax);
}

/** What a stop is called when its waypoint has no usable name. */
const UNNAMED_STOP = 'Stop';

/**
 * A stop's name as the document may hold it: trimmed, never blank, at most
 * `PLAN_LIMITS.stopNameMax` characters. A waypoint name is the import's or
 * the GPX's, so nothing else bounds it, and the server refuses a document
 * with a blank or over-long one.
 */
function clampStopName(name: string | undefined): string {
  const trimmed = (name ?? '').trim().slice(0, PLAN_LIMITS.stopNameMax).trim();
  return trimmed || UNNAMED_STOP;
}

/**
 * True when `km` (NOBO-absolute) is one of the trail's ends: km 0, or
 * `totalKm` when the caller knows it. A night there is not a day boundary —
 * there is no walking before the start or after the end for its nights to
 * move — so the editors never add a stop there: `toggleStop` refuses with a
 * message, and a UI that lists the place can use this to not offer the toggle.
 */
export function isTrailEnd(km: number, totalKm: number | undefined): boolean {
  if (km < KM_EPSILON) return true;
  return typeof totalKm === 'number' && Number.isFinite(totalKm) && km > totalKm - KM_EPSILON;
}

/** A fresh, empty plan for a trail. */
export function newPlan(
  trailId: string,
  name: string,
  direction: PlanDirection,
  opts?: PlanCreateOptions
): PlanDocument {
  return {
    id: mintId(opts),
    trailId,
    name: clampName(name),
    direction,
    startDate: null,
    stops: [],
    updatedAt: stamp(opts),
    version: 1,
  };
}

/** Rename the plan (trimmed, capped at `PLAN_LIMITS.nameMax`). */
export function setPlanName(plan: PlanDocument, name: string, opts?: PlanEditOptions): PlanDocument {
  const next = clampName(name);
  if (next === plan.name) return plan;
  return { ...plan, name: next, updatedAt: stamp(opts, plan.updatedAt) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that names a real calendar day. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Set (or clear) the start date. Throws on anything that is not a real
 * `YYYY-MM-DD` day, so a bad value can never reach the date cascade and
 * silently produce `Invalid Date` in every day card.
 */
export function setStartDate(plan: PlanDocument, iso: string | null, opts?: PlanEditOptions): PlanDocument {
  if (iso !== null && !isIsoDate(iso)) {
    throw new Error(`plan-editor: startDate must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
  if (iso === plan.startDate) return plan;
  return { ...plan, startDate: iso, updatedAt: stamp(opts, plan.updatedAt) };
}

/**
 * Set the viewing direction. Stop km are NOT rewritten — they stay
 * NOBO-absolute (`plan-direction.ts`), and `computePlanDays` mirrors them for
 * the render.
 */
export function setDirection(plan: PlanDocument, direction: PlanDirection, opts?: PlanEditOptions): PlanDocument {
  if (direction === plan.direction) return plan;
  return { ...plan, direction, updatedAt: stamp(opts, plan.updatedAt) };
}

// ---------------------------------------------------------------------------
// Stop edits
// ---------------------------------------------------------------------------

/**
 * Add the place as a stop, or remove it if it is already one.
 *
 * The match is `findStop`'s: the waypoint id when both sides have one,
 * otherwise km within `KM_EPSILON`. That is what makes a toggle idempotent —
 * tapping the same waypoint twice can never leave two stops behind, even if
 * the second tap came from a row whose km differs in the last decimal.
 *
 * Every message thrown here (and by `setStartDate`) starts with `plan-editor:`
 * and is stable, so a UI handler can catch one and show it as it stands.
 *
 * A place at either end of the trail (km 0, or `opts.totalKm`) is never
 * *added*: the toggle throws. Its nights could move no date — there is nothing
 * to walk before the start (zero days before day 1 are out of scope,
 * `plans/day-planner.md`) or after the end — so a stop there would only hold
 * nights that silently count for nothing. Removing one is still allowed, and a
 * UI can keep the toggle off such a place with `isTrailEnd`.
 *
 * The name is trimmed and capped at `PLAN_LIMITS.stopNameMax` (a blank one
 * becomes "Stop"), so no waypoint name can make the document unsendable.
 *
 * @param waypoint.km NOBO-absolute km (convert active km with `toNoboKm`).
 * @throws when `waypoint.km` is not a finite number.
 * @throws when adding a stop at a trail end (`isTrailEnd`).
 * @throws when the plan is already at `PLAN_LIMITS.stopsMax`.
 */
export function toggleStop(plan: PlanDocument, waypoint: ToggleTarget, opts?: StopEditOptions): PlanDocument {
  // A NaN km matches nothing, sorts nowhere and slips past the limits check,
  // but `isPlanDocument` rejects it on the next load — so a single bad number
  // costs the hiker the whole plan. Refuse it here, while the caller still has
  // somewhere to show the error.
  if (!Number.isFinite(waypoint.km)) {
    throw new Error(`plan-editor: stop km must be a finite number, got ${String(waypoint.km)}`);
  }
  const key: StopKey = { waypointId: waypoint.id, km: waypoint.km };
  const index = findStopIndex(plan, key);
  if (index !== -1) {
    return withStops(
      plan,
      plan.stops.filter((_, i) => i !== index),
      opts
    );
  }
  // Uniqueness is a document rule, not just a lookup convenience: two stops
  // never share a waypoint id and never share a km within KM_EPSILON. `index`
  // has already ruled out the first and the same-km-no-id case; what is left is
  // a *different* co-located waypoint (two ids at the same km, e.g. the
  // Standley Chasm cluster). Adding it would build a document the limits check
  // — and the server — would reject, so the toggle is a no-op and returns the
  // same document, which is the "nothing changed" signal every caller reads.
  if (plan.stops.some(existing => Math.abs(existing.km - waypoint.km) < KM_EPSILON)) {
    return plan;
  }
  // Refused out loud, not as a silent no-op: the Stops lists offer the start
  // and finish (a town at either end is a place you can sleep), and a tap that
  // changes nothing with no word why reads as a broken checkbox.
  if (isTrailEnd(waypoint.km, opts?.totalKm)) {
    throw new Error(
      'plan-editor: the start and the end of the trail are not stops — a night there is not a day boundary'
    );
  }
  if (plan.stops.length >= PLAN_LIMITS.stopsMax) {
    throw new Error(`plan-editor: a plan may hold at most ${PLAN_LIMITS.stopsMax} stops`);
  }
  const stop: PlanStop = {
    ...(waypoint.id ? { waypointId: waypoint.id } : {}),
    km: waypoint.km,
    name: clampStopName(waypoint.name),
    nights: 1,
  };
  return withStops(plan, sortStops([...plan.stops, stop]), opts);
}

/**
 * Take one stored stop out of the plan: the stop with this waypoint id on this
 * line (ids are unique in a document, so its km may differ — the stop may have
 * been judged on a copy `refreshStopKms` had moved), or, for a stop with no
 * id, the one at exactly this km on this line. For a stop the route view
 * cannot show (one `planStopIssues` reports with no route km), which
 * `toggleStop` on a route view never reaches. Edits the stored document; the
 * same document when no stop matches.
 */
export function removeStoredStop(
  plan: PlanDocument,
  target: Pick<PlanStop, 'km' | 'waypointId' | 'alternate'>,
  opts?: PlanEditOptions
): PlanDocument {
  const index = plan.stops.findIndex(
    stop =>
      stop.alternate === target.alternate &&
      (target.waypointId
        ? stop.waypointId === target.waypointId
        : stop.waypointId === undefined && stop.km === target.km)
  );
  if (index === -1) return plan;
  return withStops(
    plan,
    plan.stops.filter((_, i) => i !== index),
    opts
  );
}

/**
 * A copy of `value` without `key`, preserving the order of the rest.
 *
 * An absent optional beats a falsy one in this document: it is size-capped and
 * goes over the wire on every edit, so `{"booked": false}` on 300 stops is
 * 5 KB of nothing. Written as a copy-and-delete rather than a rest-destructure
 * so it needs no unused binding.
 */
function omitKey<T extends object>(value: T, key: string): T {
  const next = { ...value } as Record<string, unknown>;
  delete next[key];
  return next as T;
}

function editStop(
  plan: PlanDocument,
  key: StopKey,
  edit: (stop: PlanStop) => PlanStop,
  opts?: PlanEditOptions
): PlanDocument {
  const index = findStopIndex(plan, key);
  if (index === -1) return plan;
  const next = edit(plan.stops[index]);
  if (next === plan.stops[index]) return plan;
  const stops = [...plan.stops];
  stops[index] = next;
  return withStops(plan, stops, opts);
}

/**
 * Nights spent at a stop, clamped to 1..`PLAN_LIMITS.nightsMax`. Two nights is
 * one rest day: the walking days are unchanged, every later date moves on one.
 * A non-finite value is treated as 1.
 */
export function setNights(plan: PlanDocument, key: StopKey, nights: number, opts?: PlanEditOptions): PlanDocument {
  const clamped = clampNights(nights);
  return editStop(plan, key, stop => (stop.nights === clamped ? stop : { ...stop, nights: clamped }), opts);
}

function clampNights(nights: number): number {
  if (!Number.isFinite(nights)) return 1;
  return Math.min(PLAN_LIMITS.nightsMax, Math.max(1, Math.round(nights)));
}

/**
 * Set a stop's note (trimmed, capped at `PLAN_LIMITS.noteMax`). An empty note
 * removes the key rather than storing `''` — the document is size-capped and
 * travels over the wire on every edit.
 */
export function setStopNote(plan: PlanDocument, key: StopKey, note: string, opts?: PlanEditOptions): PlanDocument {
  const trimmed = note.trim().slice(0, PLAN_LIMITS.noteMax);
  return editStop(
    plan,
    key,
    stop => {
      if (!trimmed) {
        return stop.note === undefined ? stop : omitKey(stop, 'note');
      }
      return stop.note === trimmed ? stop : { ...stop, note: trimmed };
    },
    opts
  );
}

/** Tick or untick "booked". `false` drops the key, for the same reason as an empty note. */
export function setStopBooked(plan: PlanDocument, key: StopKey, booked: boolean, opts?: PlanEditOptions): PlanDocument {
  return editStop(
    plan,
    key,
    stop => {
      if (!booked) {
        return stop.booked === undefined ? stop : omitKey(stop, 'booked');
      }
      return stop.booked === true ? stop : { ...stop, booked: true };
    },
    opts
  );
}

/**
 * Replace the stops strictly between two km with `targets` — what applying a
 * suggested few days does.
 *
 * Stops at or outside the bounds are kept: the one the suggestion starts from,
 * and everything planned beyond the window. A target that is already a stop
 * keeps that stop as it stands (nights, note, booked), so re-applying the same
 * suggestion is a no-op and returns the same document.
 *
 * @param range NOBO-absolute km, either order (convert active km with
 *   `toNoboKm`; a SOBO window comes out reversed).
 * @param targets the places to stop at, NOBO-absolute like `toggleStop`'s.
 * A target at a trail end is skipped, as `toggleStop` refuses one.
 * @throws when a target km is not finite, or the result exceeds `PLAN_LIMITS.stopsMax`.
 */
export function replaceStopsInRange(
  plan: PlanDocument,
  range: { fromKm: number; toKm: number },
  targets: readonly ToggleTarget[],
  opts?: StopEditOptions
): PlanDocument {
  const lo = Math.min(range.fromKm, range.toKm);
  const hi = Math.max(range.fromKm, range.toKm);
  const inside = (km: number) => km > lo + KM_EPSILON && km < hi - KM_EPSILON;

  const next: PlanStop[] = plan.stops.filter(stop => !inside(stop.km));
  for (const target of targets) {
    if (!Number.isFinite(target.km)) {
      throw new Error(`plan-editor: stop km must be a finite number, got ${String(target.km)}`);
    }
    const existing = findStop(plan, { waypointId: target.id, km: target.km });
    if (!existing && isTrailEnd(target.km, opts?.totalKm)) continue;
    const stop: PlanStop = existing ?? {
      ...(target.id ? { waypointId: target.id } : {}),
      km: target.km,
      name: clampStopName(target.name),
      nights: 1,
    };
    if (next.some(kept => kept === stop || collidesWith(kept, stop))) continue;
    next.push(stop);
  }
  if (next.length > PLAN_LIMITS.stopsMax) {
    throw new Error(`plan-editor: a plan may hold at most ${PLAN_LIMITS.stopsMax} stops`);
  }
  const sorted = sortStops(next);
  if (sorted.length === plan.stops.length && sorted.every((stop, i) => stop === plan.stops[i])) {
    return plan;
  }
  return withStops(plan, sorted, opts);
}

// ---------------------------------------------------------------------------
// Resupply selection
// ---------------------------------------------------------------------------

/**
 * Set the resupply selection: the ids of the resupply options the hiker
 * ticked, in any order (stored in the order given). `undefined` means "no plan
 * made" — every option feeds the carries and nothing is highlighted — which is
 * a different thing from an explicit empty selection.
 *
 * Zero days follow the selection: an explicit list drops the zero days of
 * every option it leaves out, so a figure set on a town the hiker has since
 * unticked is never counted unseen. `undefined` (every option) keeps them all;
 * {@link resetResupplyPlan} clears both.
 *
 * The same object comes back when the selection (and so the zero days)
 * already reads the same, so a second press of All or None is not a write and
 * not a request.
 */
export function setResupplyStops(
  plan: PlanDocument,
  ids: readonly string[] | undefined,
  opts?: PlanEditOptions
): PlanDocument {
  const current = plan.resupplyStops;
  const stopsChanged =
    ids === undefined
      ? current !== undefined
      : current === undefined || current.length !== ids.length || current.some((id, i) => id !== ids[i]);
  const zeroDays = ids === undefined ? plan.resupplyZeroDays : keepZeroDays(plan.resupplyZeroDays, new Set(ids));
  const zeroDaysChanged = zeroDays !== plan.resupplyZeroDays;
  if (!stopsChanged && !zeroDaysChanged) return plan;

  let next: PlanDocument = plan;
  if (stopsChanged) next = ids === undefined ? omitKey(next, 'resupplyStops') : { ...next, resupplyStops: [...ids] };
  if (zeroDaysChanged) {
    next = zeroDays === undefined ? omitKey(next, 'resupplyZeroDays') : { ...next, resupplyZeroDays: zeroDays };
  }
  return { ...next, updatedAt: stamp(opts, plan.updatedAt) };
}

/**
 * The zero-days map with only the ids in `keep`: the same object when nothing
 * goes, `undefined` when nothing is left.
 */
function keepZeroDays(
  zeroDays: Record<string, number> | undefined,
  keep: ReadonlySet<string>
): Record<string, number> | undefined {
  if (zeroDays === undefined) return undefined;
  const ids = Object.keys(zeroDays);
  if (ids.every(id => keep.has(id))) return zeroDays;
  const kept: Record<string, number> = {};
  for (const id of ids) if (keep.has(id)) kept[id] = zeroDays[id];
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * Back to "no resupply plan made": the selection goes (every option feeds the
 * carries again, nothing is highlighted) and so do the zero days, which would
 * otherwise sit on places no longer chosen. The same object comes back when
 * there is neither.
 */
export function resetResupplyPlan(plan: PlanDocument, opts?: PlanEditOptions): PlanDocument {
  if (plan.resupplyStops === undefined && plan.resupplyZeroDays === undefined) return plan;
  return {
    ...omitKey(omitKey(plan, 'resupplyStops'), 'resupplyZeroDays'),
    updatedAt: stamp(opts, plan.updatedAt),
  };
}

/**
 * Set the zero days the hiker takes at one resupply stop, by option id: a
 * whole or half number of days from 0 to `PLAN_LIMITS.zeroDaysMax`. 0 removes
 * the entry, and the last entry's removal removes the map, so a plan with no
 * zero days stays byte-identical to one saved before they existed.
 *
 * The same object comes back when the value already reads the same (0 on an
 * absent entry included), so nothing is written or synced.
 *
 * @throws RangeError for a value that is not a half-day step in that range,
 *   or an id that is not a waypoint id ({@link PLAN_WAYPOINT_ID_PATTERN}).
 */
export function setResupplyZeroDays(
  plan: PlanDocument,
  optionId: string,
  days: number,
  opts?: PlanEditOptions
): PlanDocument {
  if (!PLAN_WAYPOINT_ID_PATTERN.test(optionId)) {
    throw new RangeError(`setResupplyZeroDays: ${JSON.stringify(optionId)} is not a waypoint id`);
  }
  if (days !== 0 && !isStoredZeroDays(days)) {
    throw new RangeError(
      `setResupplyZeroDays: ${String(days)} is not a half-day step from 0 to ${PLAN_LIMITS.zeroDaysMax}`
    );
  }
  const current = plan.resupplyZeroDays;
  const had = current !== undefined && Object.prototype.hasOwnProperty.call(current, optionId);
  if (days === 0 ? !had : had && current[optionId] === days) return plan;

  const next: Record<string, number> = { ...current };
  if (days === 0) delete next[optionId];
  else next[optionId] = days;
  if (Object.keys(next).length > PLAN_LIMITS.resupplyZeroDaysMax) {
    throw new RangeError(`setResupplyZeroDays: a plan may hold at most ${PLAN_LIMITS.resupplyZeroDaysMax} entries`);
  }
  const updatedAt = stamp(opts, plan.updatedAt);
  if (Object.keys(next).length === 0) return { ...omitKey(plan, 'resupplyZeroDays'), updatedAt };
  return { ...plan, resupplyZeroDays: next, updatedAt };
}

/**
 * Make one decision group's choice: exactly `optionId` in the group, or none
 * of it (`null`), leaving every other group's selection as it was. The group
 * is found by its `key` among `groups` (`listResupplyOptions`' output for the
 * trail as the hiker sees it).
 *
 * An absent selection means every option, so it is materialised first — every
 * other group keeps all its options ticked, exactly as it read before. The
 * chosen id takes the place of the group's first stored id, so the stored
 * order stays stable. A choice the group already reads as — including a lone
 * place under the absent default, which reads as chosen — is a no-op: the
 * same object back, nothing written, and the default kept. Ids no group has
 * (a saved selection from older trail data) are kept untouched.
 *
 * The group's places left unchosen lose their zero days (through
 * {@link setResupplyStops}), so a figure set on Salida does not linger, unseen
 * and still counted, after switching to Poncha Springs or carrying through.
 *
 * @throws RangeError for a `groupKey` no group has, or an `optionId` that is
 *   not in that group — a UI handing over either is a bug.
 */
export function chooseResupplyOption(
  plan: PlanDocument,
  groups: readonly ResupplyOptionGroup[],
  groupKey: string,
  optionId: string | null,
  opts?: PlanEditOptions
): PlanDocument {
  const group = groups.find(candidate => candidate.key === groupKey);
  if (!group) throw new RangeError(`chooseResupplyOption: no resupply group "${groupKey}"`);
  if (optionId !== null && !group.options.some(option => option.id === optionId)) {
    throw new RangeError(`chooseResupplyOption: "${optionId}" is not an option of group "${groupKey}"`);
  }
  // Already reads this way — the absent "every option" default included, under
  // which a lone place is chosen — so nothing is written, and the default
  // (which ticks towns a later data update adds) is kept.
  const choice = resupplyGroupChoice(group, plan.resupplyStops);
  if (optionId === null ? choice.kind === 'none' : choice.kind === 'chosen' && choice.optionId === optionId) {
    return plan;
  }
  const inGroup = new Set(group.options.map(option => option.id));
  const current = plan.resupplyStops ?? allResupplyOptionIds(groups);
  const next: string[] = [];
  let placed = optionId === null;
  for (const id of current) {
    if (!inGroup.has(id)) {
      next.push(id);
    } else if (!placed) {
      next.push(optionId as string);
      placed = true;
    }
  }
  if (!placed) next.push(optionId as string);
  return setResupplyStops(plan, next, opts);
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Turn a `localStorage` `PlanState` into a `PlanDocument`.
 *
 * `StopData` is km-keyed and carries no id, so each legacy km is resolved
 * against the trail's waypoints by `KM_EPSILON` — the same tolerance the stop
 * was matched with when it was saved, since it was saved *from* a waypoint's
 * already-rounded build-time km. Within that tolerance the *nearest* waypoint
 * wins, not the first one the array happens to hold: two waypoints 6 m apart
 * are both inside `KM_EPSILON`, and array order is the build's, not the
 * hiker's. A stop that matches a waypoint takes that waypoint's id and km
 * (canonical from here on); one that matches nothing keeps its km and stays
 * id-less, which `findStop` handles.
 *
 * Every stop gets `nights: 1` — the legacy shape had no notion of a rest day.
 * Name, start date, direction and the resupply selection carry over unchanged.
 *
 * **The result always passes `assertPlanDocumentWithinLimits`.** A migration
 * that produced a document the save path rejects would lose the plan it was
 * meant to rescue, so the two document-level stop rules are applied here:
 * near-duplicates are dropped (same id, or km within `KM_EPSILON` — the
 * uniqueness rule the assert enforces, not the looser `sameStop` lookup), and
 * a legacy save holding more than `PLAN_LIMITS.stopsMax` stops keeps the first
 * `stopsMax` in km order and drops the tail. A legacy stop whose km is not a
 * finite number is skipped outright — there is no position to rescue it to.
 *
 * Runs once on the web, when a `trail-plan-<id>` key is found and no document
 * exists.
 */
/**
 * The waypoint nearest `km` within `KM_EPSILON`, or `undefined`.
 *
 * Nearest, not first: `KM_EPSILON` is 10 m of slack, and real trails carry
 * waypoints closer together than that. Ties keep the earlier waypoint, which
 * is the only stable answer available.
 */
function nearestWaypoint(waypoints: readonly PlanWaypoint[], km: number): PlanWaypoint | undefined {
  let best: PlanWaypoint | undefined;
  let bestGap = KM_EPSILON;
  for (const wp of waypoints) {
    if (typeof wp.totalDistance !== 'number') continue;
    const gap = Math.abs(wp.totalDistance - km);
    if (gap < bestGap) {
      bestGap = gap;
      best = wp;
    }
  }
  return best;
}

/**
 * True when two stops could not both live in one document: the uniqueness rule
 * `assertPlanDocumentWithinLimits` enforces (same waypoint id, OR km within
 * `KM_EPSILON`). Stricter than `sameStop`, which is a *lookup* and stops
 * comparing km once both sides have an id.
 */
function collidesWith(a: PlanStop, b: PlanStop): boolean {
  if (a.waypointId !== undefined && a.waypointId === b.waypointId) return true;
  return Math.abs(a.km - b.km) < KM_EPSILON;
}

export function migratePlanState(
  state: PlanState,
  trailId: string,
  waypoints: PlanWaypoint[],
  opts?: PlanCreateOptions
): PlanDocument {
  const stops: PlanStop[] = [];
  for (const legacy of state.stops ?? []) {
    if (!Number.isFinite(legacy.km)) continue;
    const match = nearestWaypoint(waypoints, legacy.km);
    const stop: PlanStop = {
      ...(match?.id ? { waypointId: match.id } : {}),
      km: match?.totalDistance ?? legacy.km,
      name: clampStopName((typeof legacy.waypointName === 'string' ? legacy.waypointName.trim() : '') || match?.name),
      nights: 1,
    };
    if (stop.km < 0) continue;
    // A legacy save could in principle hold two stops at the same place (two
    // co-located waypoints, or two km that resolved to neighbouring ones); the
    // document forbids both, so the first wins.
    if (stops.some(existing => collidesWith(existing, stop))) continue;
    stops.push(stop);
  }
  return {
    id: mintId(opts),
    trailId,
    name: clampName(state.name ?? ''),
    direction: state.direction ?? 'NOBO',
    startDate: isIsoDate(state.startDate) ? state.startDate : null,
    stops: sortStops(stops).slice(0, PLAN_LIMITS.stopsMax),
    ...(state.resupplyStops
      ? {
          resupplyStops: state.resupplyStops
            .filter(id => typeof id === 'string' && PLAN_WAYPOINT_ID_PATTERN.test(id))
            .slice(0, PLAN_LIMITS.resupplyStopsMax),
        }
      : {}),
    updatedAt: stamp(opts),
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Overnight candidates
// ---------------------------------------------------------------------------

/**
 * Waypoint types you can spend a night at.
 *
 * The camp and shelter families plus `town` — the phone's `overnightWaypoints`
 * grouping (campsite/camp/campground, shelter/hut/accommodation/caravan-park/teahouse)
 * with the place a hiker most often actually sleeps added. `camp` and
 * `campground` are not types our classifier emits; they come from imported
 * GPX, and the phone already accepted them.
 */
const OVERNIGHT_TYPES: ReadonlySet<string> = new Set([
  'camp',
  'campsite',
  'campground',
  'shelter',
  'hut',
  'accommodation',
  'caravan-park',
  // A lodge on a teahouse trek: a bed and meals, the night's stop by design.
  'teahouse',
]);

/** Options for `overnightCandidates`. */
export interface OvernightOptions {
  /**
   * Whether a `town` counts as an overnight candidate. Default true: for the
   * planner's Stops list a town is the commonest place to spend a night.
   *
   * The phone's day-boundary *snapper* passes false — its job is to land a
   * generated day on a camp or a hut, and widening it to towns would move
   * boundaries that its tests pin.
   */
  includeTowns?: boolean;
}

/**
 * The waypoints worth offering as overnight stops, in km order.
 *
 * A turn-off is never a candidate however it is typed: `hut-access` is a
 * roadside with a hut somewhere off the route, and you cannot sleep at a
 * roadside. That check comes before the type match, so a turn-off cannot slip
 * through via `baseWaypointType`.
 */
export function overnightCandidates<W extends PlanWaypoint>(waypoints: readonly W[], opts?: OvernightOptions): W[] {
  const includeTowns = opts?.includeTowns ?? true;
  return waypoints
    .filter(wp => {
      if (isAccessWaypoint(wp.type)) return false;
      const type = baseWaypointType(wp.type);
      if (OVERNIGHT_TYPES.has(type)) return true;
      return includeTowns && type === 'town';
    })
    .slice()
    .sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Options for `computePlanDays`. */
export interface ComputePlanDaysOptions {
  /** Naismith flat-ground base speed: the hiker's pace, never assumed. */
  baseKmh: number;
  /** Section boundaries, in the same (active) km space as `trail`. */
  section?: SectionConfig | null;
}

/** Add `days` whole days to a `YYYY-MM-DD` date, in UTC (as `computeDays` does). */
function addDays(startDate: string, days: number): string {
  const date = new Date(`${startDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The plan's days: `computeDays` over the plan's stops, with the dates pushed
 * along by rest days and `restDays` filled in.
 *
 * **What the caller must pass.** `trail` must already be oriented in
 * `plan.direction` — the web page's `activeTrail()`
 * (`createReversedTrail(trail)` for SOBO, the trail itself for NOBO), and the
 * phone's direction-applied guide trail. This function does the *stop* half of
 * the conversion for you (stored NOBO km → active km via `stopsToActive`,
 * against `trail.track.totalDistance`, which the mirror leaves unchanged); it
 * cannot reverse a track, because reversing pulls in `trail-reverse` and the
 * two platforms already cache a reversed trail of their own.
 *
 * Dates: day *n* starts at `plan.startDate` plus `n` walking days plus the rest
 * days of every stop before it (`nights - 1` each). A rest day is never a day
 * card of its own — it is `restDays` on the day that ends at that stop, so a
 * card can read "2 nights at Salida". The final day's `restDays` is 0: the
 * trail end is not a stop you linger at.
 */
export function computePlanDays(trail: PlanTrail, plan: PlanDocument, opts: ComputePlanDaysOptions): ComputedDay[] {
  const total = trail.track.totalDistance;
  const active = stopsToActive(plan.stops, plan.direction, total);

  // computeDays drops stops outside the computed range; the day boundaries are
  // what the cascade indexes into, so apply the same filter here rather than
  // assuming stops[i] ends day i+1.
  const rangeStartKm = opts.section ? opts.section.startKm : 0;
  const rangeEndKm = opts.section ? opts.section.endKm : total;
  const boundaryStops = active.filter(stop => stop.km > rangeStartKm && stop.km < rangeEndKm);

  // A stop off the route adds its walk in and out to the days either side
  // (`computeDays`); the walk is the stop's waypoint's, by id, while the stop
  // still sits at that waypoint's km (`stopWalk`).
  const byId = new Map<string, PlanWaypoint>();
  for (const wp of trail.waypoints ?? []) if (wp.id && !byId.has(wp.id)) byId.set(wp.id, wp);
  const stopInputs: PlanStopInput[] = boundaryStops.map(stop => ({
    km: stop.km,
    waypointName: stop.name,
    walk: stop.waypointId ? stopWalk(byId.get(stop.waypointId), stop.km) : null,
  }));

  const days = computeDays(trail, stopInputs, plan.startDate, opts.section, opts.baseKmh);

  let restBefore = 0;
  return days.map((day, i) => {
    const endStop = boundaryStops[i];
    const restDays = endStop ? Math.max(0, endStop.nights - 1) : 0;
    const dated: ComputedDay = {
      ...day,
      restDays,
      ...(plan.startDate ? { date: addDays(plan.startDate, i + restBefore) } : {}),
    };
    restBefore += restDays;
    return dated;
  });
}

/**
 * How far past this device's clock a data time may be and still count. Data
 * times are publish times, already past; a later one is clock skew or a bad
 * value, and a far-future stamp would block every device from moving stops.
 */
const DATA_TIME_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * An ISO time as a number, or null when it is absent, not a time, or further
 * in the future than clock skew explains (so a bad stamp reads as none).
 */
function dataTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t) || t > Date.now() + DATA_TIME_FUTURE_TOLERANCE_MS) return null;
  return t;
}

/**
 * Whether trail data published at `dataUpdatedAt` is at least as new as the
 * data `plan` was last saved against (`PlanDocument.dataUpdatedAt`). A plan
 * with no stamp is current for anyone; a device that does not know its data's
 * time (null) is current only for such a plan.
 */
export function planDataIsCurrent(
  plan: Pick<PlanDocument, 'dataUpdatedAt'>,
  dataUpdatedAt: string | null | undefined
): boolean {
  const saved = dataTime(plan.dataUpdatedAt);
  if (saved === null) return true;
  const mine = dataTime(dataUpdatedAt);
  return mine !== null && mine >= saved;
}

/**
 * Raise `plan.dataUpdatedAt` to `dataUpdatedAt`, the data the saving device
 * holds. Never lowers it: an edit made on older data does not make the plan
 * look older. Returns the same document when the stamp stays as it is.
 * Leaves `updatedAt` alone — call it on a document that is being saved anyway.
 */
export function stampPlanData(plan: PlanDocument, dataUpdatedAt: string | null | undefined): PlanDocument {
  const mine = dataTime(dataUpdatedAt);
  if (mine === null) return plan;
  const saved = dataTime(plan.dataUpdatedAt);
  if (saved !== null && saved >= mine) return plan;
  return { ...plan, dataUpdatedAt: dataUpdatedAt as string };
}

/** `refreshStopKms`'s options. */
export interface RefreshStopKmsOptions extends PlanEditOptions {
  /**
   * The publish time (`updatedAt`) of the trail data `trail` was read from;
   * null when the device does not know it. Given, a plan last saved against
   * newer data than this is returned unchanged (`planDataIsCurrent`): older
   * data must not move a stop back. Every caller that saves the result passes
   * it; leave it out only to read a plan without saving it.
   */
  dataUpdatedAt?: string | null;
}

/** A place a stop can be measured against: its id and its km as stored. */
interface StopPlace {
  id?: string;
  totalDistance?: number;
}

/** The trail as stored (NOBO km) that `refreshStopKms` reads its places from. */
export interface StopPlacesTrail {
  waypoints?: readonly StopPlace[];
  alternates?: readonly { name: string; waypoints?: readonly StopPlace[] }[];
}

/**
 * Move each stop to its waypoint's km in `trail`, when a data update has moved
 * the place since the stop was saved (`access.json` re-placing an off-route
 * place at the junction it is walked to from, say). Without this the day keeps
 * ending at the old km, walking the old way there, and the place's walk is
 * left out (`stopWalk`) rather than counted twice.
 *
 * `trail` is the trail as stored — NOBO km, alternates unspliced — so a
 * main-route stop is matched against `trail.waypoints` and a stop on an
 * alternate against that alternate's own waypoints, whose km is on the same
 * absolute scale the stop keeps. A stop whose waypoint is gone, or that would
 * land on another stop's km on its line, is left where it is. Returns the same
 * document when nothing moved, so a caller can save only a real change.
 *
 * A device still on older data than the plan was saved against would move the
 * stops back to where that data has the places, and sync it over the newer
 * device's correction; `opts.dataUpdatedAt` stops it (issue 143).
 */
export function refreshStopKms(plan: PlanDocument, trail: StopPlacesTrail, opts?: RefreshStopKmsOptions): PlanDocument {
  if (opts?.dataUpdatedAt !== undefined && !planDataIsCurrent(plan, opts.dataUpdatedAt)) return plan;
  const index = (places: readonly StopPlace[] | undefined) => {
    const byId = new Map<string, number>();
    for (const place of places ?? []) {
      if (place.id && typeof place.totalDistance === 'number' && Number.isFinite(place.totalDistance)) {
        if (!byId.has(place.id)) byId.set(place.id, place.totalDistance);
      }
    }
    return byId;
  };
  const main = index(trail.waypoints);
  const onAlternate = new Map<string, Map<string, number>>();
  for (const alternate of trail.alternates ?? []) {
    if (!onAlternate.has(alternate.name)) onAlternate.set(alternate.name, index(alternate.waypoints));
  }

  let stops = plan.stops;
  for (let i = 0; i < plan.stops.length; i++) {
    const stop = plan.stops[i];
    if (!stop.waypointId) continue;
    const places = stop.alternate === undefined ? main : onAlternate.get(stop.alternate);
    const km = places?.get(stop.waypointId);
    if (km === undefined || isStopAtPlace(km, stop.km)) continue;
    const line = stop.alternate ?? '';
    const taken = stops.some(
      (other, j) => j !== i && (other.alternate ?? '') === line && Math.abs(other.km - km) < KM_EPSILON
    );
    if (taken) continue;
    if (stops === plan.stops) stops = [...plan.stops];
    stops[i] = { ...stop, km };
  }
  return stops === plan.stops ? plan : withStops(plan, sortStops(stops), opts);
}

/** `splitUnplannedTail`'s answer: the days walked to a stop, and what is left. */
export interface PlannedDays {
  days: ComputedDay[];
  /**
   * The stretch from the last stop to the range end, when it is too long to be
   * a day: not a day card, just the part of the trail not planned yet.
   * `null` when the last day fits.
   */
  unplanned: ComputedDay | null;
}

/**
 * Split off the tail of a plan that is not a day yet.
 *
 * `computePlanDays` always runs its last day to the range end, so a plan with
 * two stops near the start reads as two days and one enormous third. Most
 * plans are made a few days at a time, and the stretch after the last stop is
 * *unplanned*, not a day. It becomes a day again once it fits in one, and
 * `maxFinalHours` is the hiker's own figure for what fits (the phone passes
 * its daily hours plus the splitter's final-day allowance).
 *
 * `unplanned.dayNumber` is the number the next day would take.
 */
export function splitUnplannedTail(days: readonly ComputedDay[], maxFinalHours: number): PlannedDays {
  const last = days[days.length - 1];
  if (!last || !(last.estimatedHours > maxFinalHours)) return { days: [...days], unplanned: null };
  return { days: days.slice(0, -1), unplanned: last };
}

// ---------------------------------------------------------------------------
// Services at a stop
// ---------------------------------------------------------------------------

/** What a stop has, from the OSM POIs around it. */
export interface StopServices {
  /** Somewhere to pitch a tent or lie down unbooked: a camp site, a shelter, a hut. */
  camping: boolean;
  /** A roofed, usually-booked bed: hotel, hostel, guest house, alpine hut. */
  lodging: boolean;
  /** Somewhere to buy food to carry: a shop, a supermarket, a post office, a fuel stop. */
  shop: boolean;
  /** Somewhere to eat a meal now: a restaurant, cafe, pub, bakery. */
  food: boolean;
  water: boolean;
  transport: boolean;
  /** The POIs behind the flags, in the order the trail data holds them (km order). */
  pois: TrailPOI[];
}

const LODGING_TOURISM: ReadonlySet<string> = new Set([
  'hotel',
  'motel',
  'hostel',
  'guest_house',
  'apartment',
  'chalet',
  'alpine_hut',
  'wilderness_hut',
]);

const FOOD_AMENITIES: ReadonlySet<string> = new Set([
  'restaurant',
  'cafe',
  'fast_food',
  'pub',
  'bar',
  'biergarten',
  'food_court',
  'ice_cream',
]);

const WATER_AMENITIES: ReadonlySet<string> = new Set(['drinking_water', 'water_point']);
const WATER_MAN_MADE: ReadonlySet<string> = new Set(['water_tap', 'water_well', 'water_works']);
const TRANSPORT_AMENITIES: ReadonlySet<string> = new Set(['bus_station', 'ferry_terminal', 'taxi']);

/**
 * A tag's value, with the literal `no` read as "the tag is absent".
 *
 * OSM uses `shop=no` and `public_transport=no` to say *there is no shop here*
 * (commonly on a former shop, or on a stop a route no longer serves). Testing
 * such a tag for truthiness flags the opposite of what it says — the same
 * reason `drinking_water` is compared against `'yes'` rather than read as a
 * flag.
 */
function tagValue(value: string | undefined): string | undefined {
  return value === undefined || value === 'no' ? undefined : value;
}

/**
 * The services near a stop, from the trail's OSM POIs.
 *
 * `undefined` means *this trail has no POI data at all* (`pois === undefined`
 * — CDT and Te Araroa have never been fetched). That is not the same as "no
 * services here", and the UI must say so: an empty `StopServices` is a stop
 * with nothing around it, `undefined` is a trail we cannot answer for.
 *
 * POIs flagged `duplicateOf` are **included**. The map hides them because the
 * curated waypoint is the one marker for that place, but their OSM
 * `website`/`opening_hours` is exactly what a stop card wants to show, and
 * dropping them would make the hut you are standing at look service-less.
 *
 * Route breaks are ignored: the window is along-trail km only, so a POI on the
 * far side of a ferry crossing is credited to a stop 1 km away on this side.
 *
 * @param radiusKm along-trail half-window. 1 km by default (the decision in
 *   `plans/day-planner.md`); there is deliberately no cap on
 *   `distanceFromTrail` — a shop 300 m off the route is still the shop here.
 */
export function servicesAtStop(
  stop: { km: number },
  pois: readonly TrailPOI[] | undefined,
  radiusKm = 1
): StopServices | undefined {
  if (pois === undefined) return undefined;
  const near = pois.filter(poi => Math.abs(poi.distanceAlongTrail - stop.km) <= radiusKm);
  const services: StopServices = {
    camping: false,
    lodging: false,
    shop: false,
    food: false,
    water: false,
    transport: false,
    pois: near.slice(),
  };
  for (const poi of near) {
    const tags = poi.tags ?? {};
    const amenity = tags.amenity;
    const tourism = tags.tourism;
    const shop = tagValue(tags.shop);
    if (poi.category === 'camping') services.camping = true;
    if (tourism && LODGING_TOURISM.has(tourism)) services.lodging = true;
    if (poi.category === 'resupply' || shop !== undefined) services.shop = true;
    if (poi.category === 'restaurant' || (amenity && FOOD_AMENITIES.has(amenity)) || shop === 'bakery') {
      services.food = true;
    }
    if (
      poi.category === 'water' ||
      (amenity && WATER_AMENITIES.has(amenity)) ||
      (tags.man_made && WATER_MAN_MADE.has(tags.man_made)) ||
      tags.drinking_water === 'yes'
    ) {
      services.water = true;
    }
    if (
      poi.category === 'transport' ||
      tags.highway === 'bus_stop' ||
      (amenity && TRANSPORT_AMENITIES.has(amenity)) ||
      tagValue(tags.public_transport) !== undefined ||
      tags.railway === 'station'
    ) {
      services.transport = true;
    }
  }
  return services;
}

// ---------------------------------------------------------------------------
// Limits and validation
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length of a string, computed without `TextEncoder` or `Buffer` —
 * neither is reliably present under Hermes, and the server enforces the same
 * ceiling on the bytes it receives, so the client has to measure the same unit.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
        continue;
      }
      bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Serialised size of the document in UTF-8 bytes — what the 64 KB cap counts. */
export function planDocumentBytes(plan: PlanDocument): number {
  return utf8ByteLength(JSON.stringify(plan));
}

/**
 * Throw unless the document is within every `PLAN_LIMITS` bound and obeys the
 * uniqueness rules. Called before a save so a document that the server would
 * reject never reaches the wire (and never lands in `localStorage` either,
 * where it would fail again on the next load).
 */
export function assertPlanDocumentWithinLimits(plan: PlanDocument): void {
  if (plan.name.length > PLAN_LIMITS.nameMax) {
    throw new Error(`plan-editor: name exceeds ${PLAN_LIMITS.nameMax} characters`);
  }
  if (plan.stops.length > PLAN_LIMITS.stopsMax) {
    throw new Error(`plan-editor: ${plan.stops.length} stops exceeds ${PLAN_LIMITS.stopsMax}`);
  }
  const seenIds = new Set<string>();
  for (const stop of plan.stops) {
    // `isPlanDocument` rejects a non-finite km on the next load, so letting one
    // be saved here trades an error the caller can show for a plan that comes
    // back empty.
    if (!Number.isFinite(stop.km)) {
      throw new Error(`plan-editor: "${stop.name}" has a non-finite km (${String(stop.km)})`);
    }
    // The rest mirror the server's checks (`workers/comments-api` validation),
    // so a document it would refuse is refused here, where the caller can say so.
    if (stop.km < 0) {
      throw new Error(`plan-editor: "${stop.name}" has a negative km (${stop.km})`);
    }
    if (stop.name.trim().length === 0) {
      throw new Error(`plan-editor: the stop at km ${stop.km} has no name`);
    }
    if (stop.name.length > PLAN_LIMITS.stopNameMax) {
      throw new Error(`plan-editor: stop name at km ${stop.km} exceeds ${PLAN_LIMITS.stopNameMax} characters`);
    }
    if (stop.waypointId !== undefined && !PLAN_WAYPOINT_ID_PATTERN.test(stop.waypointId)) {
      throw new Error(`plan-editor: "${stop.name}" has an invalid waypoint id ${JSON.stringify(stop.waypointId)}`);
    }
    if (!Number.isFinite(stop.nights) || stop.nights < 1 || stop.nights > PLAN_LIMITS.nightsMax) {
      throw new Error(`plan-editor: "${stop.name}" has ${stop.nights} nights, outside 1..${PLAN_LIMITS.nightsMax}`);
    }
    if (stop.note !== undefined && stop.note.length > PLAN_LIMITS.noteMax) {
      throw new Error(`plan-editor: note on "${stop.name}" exceeds ${PLAN_LIMITS.noteMax} characters`);
    }
    if (stop.waypointId) {
      if (seenIds.has(stop.waypointId)) {
        throw new Error(`plan-editor: two stops share waypoint id ${stop.waypointId}`);
      }
      seenIds.add(stop.waypointId);
    }
  }
  if (plan.resupplyStops !== undefined) {
    if (plan.resupplyStops.length > PLAN_LIMITS.resupplyStopsMax) {
      throw new Error(
        `plan-editor: ${plan.resupplyStops.length} resupply stops exceeds ${PLAN_LIMITS.resupplyStopsMax}`
      );
    }
    for (const id of plan.resupplyStops) {
      if (!PLAN_WAYPOINT_ID_PATTERN.test(id)) {
        throw new Error(`plan-editor: invalid resupply waypoint id ${JSON.stringify(id)}`);
      }
    }
  }
  if (plan.resupplyZeroDays !== undefined) {
    const entries = Object.entries(plan.resupplyZeroDays);
    if (entries.length > PLAN_LIMITS.resupplyZeroDaysMax) {
      throw new Error(`plan-editor: ${entries.length} zero-day entries exceeds ${PLAN_LIMITS.resupplyZeroDaysMax}`);
    }
    for (const [id, days] of entries) {
      if (!PLAN_WAYPOINT_ID_PATTERN.test(id)) {
        throw new Error(`plan-editor: invalid zero-day waypoint id ${JSON.stringify(id)}`);
      }
      if (!isStoredZeroDays(days)) {
        throw new Error(
          `plan-editor: ${String(days)} zero days at ${id} is not a half-day step in 0.5..${PLAN_LIMITS.zeroDaysMax}`
        );
      }
    }
  }
  if (plan.alternates !== undefined) {
    if (plan.alternates.length > PLAN_LIMITS.alternatesMax) {
      throw new Error(`plan-editor: ${plan.alternates.length} alternates exceeds ${PLAN_LIMITS.alternatesMax}`);
    }
    for (const name of plan.alternates) {
      if (name.trim().length === 0 || name.length > PLAN_LIMITS.alternateNameMax) {
        throw new Error(`plan-editor: invalid alternate name ${JSON.stringify(name)}`);
      }
    }
  }
  // One stop per place on each line: a stop on an alternate is measured on the
  // alternate's own scale, which overlaps the main route's km, so only stops on
  // the same line can be the same place.
  const lastOnLine = new Map<string, PlanStop>();
  for (const stop of plan.stops) {
    if (stop.alternate !== undefined) {
      if (!plan.alternates?.includes(stop.alternate)) {
        throw new Error(`plan-editor: "${stop.name}" is on an alternate the plan does not take`);
      }
    }
    const line = stop.alternate ?? '';
    const previous = lastOnLine.get(line);
    if (previous && Math.abs(stop.km - previous.km) < KM_EPSILON) {
      throw new Error(`plan-editor: two stops share km ${stop.km} ("${previous.name}" and "${stop.name}")`);
    }
    lastOnLine.set(line, stop);
  }
  const bytes = planDocumentBytes(plan);
  if (bytes > PLAN_LIMITS.documentBytes) {
    throw new Error(`plan-editor: document is ${bytes} bytes, over the ${PLAN_LIMITS.documentBytes} limit`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlanStop(value: unknown): value is PlanStop {
  if (!isRecord(value)) return false;
  if (value.waypointId !== undefined && typeof value.waypointId !== 'string') return false;
  if (typeof value.km !== 'number' || !Number.isFinite(value.km)) return false;
  if (typeof value.name !== 'string') return false;
  if (typeof value.nights !== 'number' || !Number.isInteger(value.nights) || value.nights < 1) return false;
  if (value.note !== undefined && typeof value.note !== 'string') return false;
  if (value.booked !== undefined && typeof value.booked !== 'boolean') return false;
  if (value.alternate !== undefined && typeof value.alternate !== 'string') return false;
  return true;
}

/**
 * Strict structural check on a parsed value.
 *
 * Both the web (`localStorage`, which anyone can edit) and the phone (a JSON
 * column, a shared-plan payload) parse documents they did not write in this
 * session. A malformed one must be rejected as a whole rather than half-loaded:
 * a stop with a string km would sort into nonsense and a missing `stops` array
 * would throw somewhere far from the cause.
 */
export function isPlanDocument(value: unknown): value is PlanDocument {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (typeof value.trailId !== 'string' || !value.trailId) return false;
  if (typeof value.name !== 'string') return false;
  if (value.direction !== 'NOBO' && value.direction !== 'SOBO') return false;
  if (value.startDate !== null && !isIsoDate(value.startDate)) return false;
  if (!Array.isArray(value.stops) || !value.stops.every(isPlanStop)) return false;
  // Ascending km is a document rule, not a convention: the km-uniqueness check
  // in `assertPlanDocumentWithinLimits` only compares adjacent stops, and the
  // server rejects an unsorted array outright (`stops_unsorted`). Equal km is
  // left to the limits check, which is the one that knows about `KM_EPSILON`.
  const stops = value.stops as PlanStop[];
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].km < stops[i - 1].km) return false;
  }
  if (
    value.resupplyStops !== undefined &&
    (!Array.isArray(value.resupplyStops) || !value.resupplyStops.every(id => typeof id === 'string'))
  ) {
    return false;
  }
  if (
    value.alternates !== undefined &&
    (!Array.isArray(value.alternates) || !value.alternates.every(name => typeof name === 'string'))
  ) {
    return false;
  }
  if (
    value.resupplyZeroDays !== undefined &&
    (!isRecord(value.resupplyZeroDays) || !Object.values(value.resupplyZeroDays).every(isStoredZeroDays))
  ) {
    return false;
  }
  if (typeof value.updatedAt !== 'string') return false;
  if (value.dataUpdatedAt !== undefined && typeof value.dataUpdatedAt !== 'string') return false;
  if (value.version !== 1) return false;
  return true;
}
