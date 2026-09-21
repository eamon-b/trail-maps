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
import type {
  ComputedDay,
  PlanDocument,
  PlanState,
  PlanStop,
  PlanWaypoint,
  SectionConfig,
} from './plan-types';
import { PLAN_LIMITS } from './plan-types';
import { computeDays, type PlanStopInput, type PlanTrail } from './day-calculator';
import type { TrailPOI } from './trail-types';
import { baseWaypointType, isAccessWaypoint } from './waypoint-taxonomy';

// ---------------------------------------------------------------------------
// Injected clock and id source
// ---------------------------------------------------------------------------

/** Options every editor accepts: the clock that stamps `updatedAt`. */
export interface PlanEditOptions {
  /** ISO timestamp source for `updatedAt`. Default `new Date().toISOString()`. */
  now?: () => string;
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
    'plan-editor: no uuid source available — pass opts.idFactory ' +
      '(React Native: globalThis.expo.uuidv4)',
  );
}

function mintId(opts?: PlanCreateOptions): string {
  return (opts?.idFactory ?? defaultIdFactory)();
}

function stamp(opts?: PlanEditOptions): string {
  return (opts?.now ?? (() => new Date().toISOString()))();
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

function withStops(
  plan: PlanDocument,
  stops: PlanStop[],
  opts?: PlanEditOptions,
): PlanDocument {
  return { ...plan, stops, updatedAt: stamp(opts) };
}

function sortStops(stops: PlanStop[]): PlanStop[] {
  return [...stops].sort((a, b) => a.km - b.km);
}

function clampName(name: string): string {
  return name.trim().slice(0, PLAN_LIMITS.nameMax);
}

/** A fresh, empty plan for a trail. */
export function newPlan(
  trailId: string,
  name: string,
  direction: PlanDirection,
  opts?: PlanCreateOptions,
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
  return { ...plan, name: next, updatedAt: stamp(opts) };
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
export function setStartDate(
  plan: PlanDocument,
  iso: string | null,
  opts?: PlanEditOptions,
): PlanDocument {
  if (iso !== null && !isIsoDate(iso)) {
    throw new Error(`plan-editor: startDate must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
  if (iso === plan.startDate) return plan;
  return { ...plan, startDate: iso, updatedAt: stamp(opts) };
}

/**
 * Set the viewing direction. Stop km are NOT rewritten — they stay
 * NOBO-absolute (`plan-direction.ts`), and `computePlanDays` mirrors them for
 * the render.
 */
export function setDirection(
  plan: PlanDocument,
  direction: PlanDirection,
  opts?: PlanEditOptions,
): PlanDocument {
  if (direction === plan.direction) return plan;
  return { ...plan, direction, updatedAt: stamp(opts) };
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
 * @param waypoint.km NOBO-absolute km (convert active km with `toNoboKm`).
 * @throws when `waypoint.km` is not a finite number.
 * @throws when the plan is already at `PLAN_LIMITS.stopsMax`.
 */
export function toggleStop(
  plan: PlanDocument,
  waypoint: ToggleTarget,
  opts?: PlanEditOptions,
): PlanDocument {
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
    return withStops(plan, plan.stops.filter((_, i) => i !== index), opts);
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
  if (plan.stops.length >= PLAN_LIMITS.stopsMax) {
    throw new Error(`plan-editor: a plan may hold at most ${PLAN_LIMITS.stopsMax} stops`);
  }
  const stop: PlanStop = {
    ...(waypoint.id ? { waypointId: waypoint.id } : {}),
    km: waypoint.km,
    name: waypoint.name,
    nights: 1,
  };
  return withStops(plan, sortStops([...plan.stops, stop]), opts);
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
  opts?: PlanEditOptions,
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
export function setNights(
  plan: PlanDocument,
  key: StopKey,
  nights: number,
  opts?: PlanEditOptions,
): PlanDocument {
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
export function setStopNote(
  plan: PlanDocument,
  key: StopKey,
  note: string,
  opts?: PlanEditOptions,
): PlanDocument {
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
    opts,
  );
}

/** Tick or untick "booked". `false` drops the key, for the same reason as an empty note. */
export function setStopBooked(
  plan: PlanDocument,
  key: StopKey,
  booked: boolean,
  opts?: PlanEditOptions,
): PlanDocument {
  return editStop(
    plan,
    key,
    stop => {
      if (!booked) {
        return stop.booked === undefined ? stop : omitKey(stop, 'booked');
      }
      return stop.booked === true ? stop : { ...stop, booked: true };
    },
    opts,
  );
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
 * The same object comes back when the selection already reads the same, so a
 * second press of All or None is not a write and not a request.
 */
export function setResupplyStops(
  plan: PlanDocument,
  ids: readonly string[] | undefined,
  opts?: PlanEditOptions,
): PlanDocument {
  const current = plan.resupplyStops;
  if (ids === undefined) {
    return current === undefined ? plan : { ...omitKey(plan, 'resupplyStops'), updatedAt: stamp(opts) };
  }
  if (current !== undefined && current.length === ids.length && current.every((id, i) => id === ids[i])) {
    return plan;
  }
  return { ...plan, resupplyStops: [...ids], updatedAt: stamp(opts) };
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
  opts?: PlanCreateOptions,
): PlanDocument {
  const stops: PlanStop[] = [];
  for (const legacy of state.stops ?? []) {
    if (!Number.isFinite(legacy.km)) continue;
    const match = nearestWaypoint(waypoints, legacy.km);
    const stop: PlanStop = {
      ...(match?.id ? { waypointId: match.id } : {}),
      km: match?.totalDistance ?? legacy.km,
      name: legacy.waypointName || match?.name || 'Stop',
      nights: 1,
    };
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
    ...(state.resupplyStops ? { resupplyStops: [...state.resupplyStops] } : {}),
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
 * grouping (campsite/camp/campground, shelter/hut/accommodation/caravan-park)
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
export function overnightCandidates<W extends PlanWaypoint>(
  waypoints: readonly W[],
  opts?: OvernightOptions,
): W[] {
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
  /** Naismith flat-ground base speed. Default 4, as `computeDays`. */
  baseKmh?: number;
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
export function computePlanDays(
  trail: PlanTrail,
  plan: PlanDocument,
  opts: ComputePlanDaysOptions = {},
): ComputedDay[] {
  const total = trail.track.totalDistance;
  const active = stopsToActive(plan.stops, plan.direction, total);

  // computeDays drops stops outside the computed range; the day boundaries are
  // what the cascade indexes into, so apply the same filter here rather than
  // assuming stops[i] ends day i+1.
  const rangeStartKm = opts.section ? opts.section.startKm : 0;
  const rangeEndKm = opts.section ? opts.section.endKm : total;
  const boundaryStops = active.filter(stop => stop.km > rangeStartKm && stop.km < rangeEndKm);

  const stopInputs: PlanStopInput[] = boundaryStops.map(stop => ({
    km: stop.km,
    waypointName: stop.name,
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
  radiusKm = 1,
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
    if (!Number.isFinite(stop.nights) || stop.nights < 1 || stop.nights > PLAN_LIMITS.nightsMax) {
      throw new Error(
        `plan-editor: "${stop.name}" has ${stop.nights} nights, outside 1..${PLAN_LIMITS.nightsMax}`,
      );
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
  for (let i = 1; i < plan.stops.length; i++) {
    if (Math.abs(plan.stops[i].km - plan.stops[i - 1].km) < KM_EPSILON) {
      throw new Error(
        `plan-editor: two stops share km ${plan.stops[i].km} ("${plan.stops[i - 1].name}" and "${plan.stops[i].name}")`,
      );
    }
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
  if (typeof value.updatedAt !== 'string') return false;
  if (value.version !== 1) return false;
  return true;
}
