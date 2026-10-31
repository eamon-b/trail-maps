/**
 * Input validation for the comments API. Every function here either returns a
 * cleaned value or throws an `HttpError` with the right status/code.
 */

import { HttpError } from './http';
import type { ReportReason, WaterStatus } from '../../../src/lib/comments-api-types';
import { PLAN_LIMITS, isStoredZeroDays } from '../../../src/lib/plan-types';
import type { PlanDocument, PlanStop } from '../../../src/lib/plan-types';
import { KM_EPSILON } from '../../../src/lib/plan-direction';
import { commentTargetFitsTrail, commentTargetKind } from '../../../src/lib/comment-targets';
import type { CommentTargetKind, CommentTrailKind } from '../../../src/lib/comment-targets';
import { isCommunityRouteId } from '../../../src/lib/community-types';
import type { PlanDirection } from '../../../src/lib/plan-direction';

/**
 * Allowlist of trail ids that may receive comments.
 *
 * IMPORTANT: this MUST stay in sync with the trail ids bundled in the mobile
 * app (the folder names under `data/trails/` that ship in the build). A comment
 * against a trail the app doesn't know about can never be displayed, so we
 * reject it at write time rather than store dead data. The other direction
 * matters more: a bundled trail missing from here has every comment the app
 * posts for it rejected. `scripts/server-trail-allowlist.test.ts` holds the two
 * lists equal.
 */
export const ALLOWED_TRAILS: readonly string[] = [
  'aawt',
  'bibbulmun',
  'cape_to_cape',
  'cdt',
  'grampians_peaks',
  'great_north_walk',
  'great_ocean_walk',
  'great_south_west_walk',
  'heysen',
  'hume-and-hovell',
  'kep_track',
  'larapinta',
  'overland',
  'royal_coast_track',
  'shikoku',
  'six_foot_track',
  'south_coast_track',
  'te_araroa',
  'thorsborne',
  'three_capes',
  'three_passes',
];

const WAYPOINT_ID_RE = /^[a-z0-9_-]{4,64}$/;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WATER_STATUSES: readonly WaterStatus[] = ['flowing', 'low', 'dry'];

const REPORT_REASONS: readonly ReportReason[] = ['spam', 'offensive', 'inaccurate', 'other'];

const MAX_TEXT_LEN = 2000;
const MAX_DISPLAY_NAME_LEN = 40;
const MAX_REPORT_DETAIL_LEN = 500;
const MAX_DESCRIPTION_LEN = 4000;

/** Clock skew we tolerate on client-supplied `observedAt` before clamping. */
const OBSERVED_AT_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/** True if `id` is a lowercase-or-uppercase UUID v4. */
export function isUuidV4(id: string): boolean {
  return UUID_V4_RE.test(id);
}

/** Validate + trim a display name to 1–40 non-empty chars. */
export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_display_name', 'displayName is required');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, 'invalid_display_name', 'displayName must not be empty');
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LEN) {
    throw new HttpError(400, 'invalid_display_name', `displayName must be at most ${MAX_DISPLAY_NAME_LEN} characters`);
  }
  return trimmed;
}

/** Assert `:id` from the PUT path is a client-minted UUID v4. */
export function assertClientCommentId(id: string): void {
  if (!isUuidV4(id)) {
    throw new HttpError(400, 'invalid_comment_id', 'Comment id must be a UUID v4');
  }
}

export function validateTrailId(raw: unknown): string {
  if (typeof raw !== 'string' || !ALLOWED_TRAILS.includes(raw)) {
    throw new HttpError(400, 'invalid_trail', 'Unknown or missing trailId');
  }
  return raw;
}

export function validateWaypointId(raw: unknown): string {
  if (typeof raw !== 'string' || !WAYPOINT_ID_RE.test(raw)) {
    throw new HttpError(400, 'invalid_waypoint', 'waypointId must match ^[a-z0-9_-]{4,64}$');
  }
  return raw;
}

export interface CommentTarget {
  kind: CommentTargetKind;
  id: string;
}

/**
 * Validate a comment's `waypointId` by its prefix (`@lib/comment-targets`),
 * returning which kind it is. The kind must fit the trail's: a curated `w_`
 * id only on a curated trail, a community route's own `uw_` id only on a
 * community route; shared hiker waypoints and OSM places on either. Anything
 * else is shown by no screen, so a comment filed under it could never be read
 * or moderated.
 */
export function validateCommentTarget(raw: unknown, trail: CommentTrailKind): CommentTarget {
  const kind = commentTargetKind(raw);
  if (kind !== null && commentTargetFitsTrail(kind, trail)) {
    return { kind, id: raw as string };
  }
  throw new HttpError(
    400,
    'invalid_waypoint',
    trail === 'community'
      ? "waypointId must be one of the route's waypoints (uw_…), a shared hiker waypoint (hw_…) or an OSM place (osm_…)"
      : 'waypointId must be a waypoint (w_…), a shared hiker waypoint (hw_…) or an OSM place (osm_…)'
  );
}

/** Validate optional comment text (<= 2000 chars). Returns trimmed value or null. */
export function validateText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_text', 'text must be a string');
  }
  if (raw.length > MAX_TEXT_LEN) {
    throw new HttpError(400, 'invalid_text', `text must be at most ${MAX_TEXT_LEN} characters`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Validate optional water status against the enum. Returns value or null. */
export function validateWaterStatus(raw: unknown): WaterStatus | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !WATER_STATUSES.includes(raw as WaterStatus)) {
    throw new HttpError(400, 'invalid_water_status', "waterStatus must be one of 'flowing', 'low', 'dry'");
  }
  return raw as WaterStatus;
}

/** Validate a report reason against the enum. */
export function validateReportReason(raw: unknown): ReportReason {
  if (typeof raw !== 'string' || !REPORT_REASONS.includes(raw as ReportReason)) {
    throw new HttpError(400, 'invalid_reason', "reason must be one of 'spam', 'offensive', 'inaccurate', 'other'");
  }
  return raw as ReportReason;
}

/** Validate optional report detail (<= 500 chars). Returns trimmed value or null. */
export function validateReportDetail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_detail', 'detail must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_REPORT_DETAIL_LEN) {
    throw new HttpError(400, 'invalid_detail', `detail must be at most ${MAX_REPORT_DETAIL_LEN} characters`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate a curated waypoint description (<= 4000 chars after trimming). The
 * empty string is valid and means "cleared".
 */
export function validateDescription(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_description', 'description must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_DESCRIPTION_LEN) {
    throw new HttpError(400, 'invalid_description', `description must be at most ${MAX_DESCRIPTION_LEN} characters`);
  }
  return trimmed;
}

const DAY_MS = 86_400_000;

/**
 * Coarsen an instant to its day: midnight UTC of the UTC calendar date it
 * falls on, as an ISO timestamp (`2026-10-30T00:00:00.000Z`). A water report's
 * `observedAt` is held and published at this granularity only (issue #248),
 * so it cannot place a hiker at a tank at a given hour.
 *
 * The day is the UTC date, not the hiker's local one: clients send
 * `toISOString()` (always `Z`), so the server never knows the local offset,
 * and flooring in UTC only ever moves the time *earlier*, by under a day — a
 * report can look up to a day older than it is, never fresher. The shape stays
 * a full ISO timestamp so clients that `Date.parse` it or compare it as a
 * string against other ISO times keep working.
 */
export function observedDayIso(ms: number): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString();
}

/**
 * Validate + clamp + coarsen an optional `observedAt` timestamp. Malformed
 * timestamps are rejected; timestamps further than 10 min into the future are
 * clamped down to `now + 10min` (never rejected); the result is then coarsened
 * to its UTC day (`observedDayIso`). Returns an ISO string or null.
 */
export function clampObservedAt(raw: unknown, nowMs: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_observed_at', 'observedAt must be an ISO 8601 string');
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, 'invalid_observed_at', 'observedAt must be a valid ISO 8601 timestamp');
  }
  const ceiling = nowMs + OBSERVED_AT_FUTURE_TOLERANCE_MS;
  return observedDayIso(Math.min(parsed, ceiling));
}

/**
 * The published form of a stored `observed_at`: coarsened to its UTC day
 * again on the way out, so a row written before migration `0010` (or by a
 * worker deployed after it) never publishes a finer time. Null stays null, as
 * does a value that no longer parses.
 */
export function publishedObservedAt(stored: string | null): string | null {
  if (stored === null) return null;
  const parsed = Date.parse(stored);
  return Number.isNaN(parsed) ? null : observedDayIso(parsed);
}

/** A pagination limit parser: clamps to [1, max], defaulting to `fallback`. */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// ---------------------------------------------------------------------------
// Plans (day planner)
// ---------------------------------------------------------------------------

const PLAN_DIRECTIONS: readonly PlanDirection[] = ['NOBO', 'SOBO'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A UTC ISO-8601 timestamp, as `Date.prototype.toISOString` writes one. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/**
 * How far past the server clock a plan's `dataUpdatedAt` may be. It is the
 * publish time of trail data, which is already in the past when a client
 * holds it, so this is only clock skew. A far-future stamp would freeze the
 * plan's stops on every device for good (`refreshStopKms` never moves stops
 * from data older than the stamp, and no save lowers it), so it is refused.
 */
const DATA_UPDATED_AT_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
const MAX_STOP_NAME_LEN = 200;

/** Assert `:id` from a plan path is a client-minted UUID v4. */
export function assertClientPlanId(id: string): void {
  if (!isUuidV4(id)) {
    throw new HttpError(400, 'invalid_plan_id', 'Plan id must be a UUID v4');
  }
}

/** The refusal for a plan on a trail the server does not have. */
export const PLAN_TRAIL_REFUSAL = {
  code: 'trail_not_allowed',
  message: 'trailId must be a bundled trail or a community route (imported trails stay on the device)',
} as const;

/**
 * A plan's trail must be a bundled trail or a community route (`c_…`). An
 * imported trail's `u_…` id is rejected here rather than stored, so a bug in
 * a client's "is this trail server-known?" gate can never leak someone's
 * private import to the server. This is the form check; `putPlan` then asks
 * `resolveTrail` whether a `c_` id is a route the server has.
 */
export function validatePlanTrailId(raw: unknown): string {
  if (typeof raw !== 'string' || !(ALLOWED_TRAILS.includes(raw) || isCommunityRouteId(raw))) {
    throw new HttpError(400, PLAN_TRAIL_REFUSAL.code, PLAN_TRAIL_REFUSAL.message);
  }
  return raw;
}

function planError(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

function validatePlanStop(raw: unknown, index: number): PlanStop {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw planError('invalid_stop', `stops[${index}] must be an object`);
  }
  const value = raw as Record<string, unknown>;

  const km = value.km;
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) {
    throw planError('invalid_stop', `stops[${index}].km must be a non-negative number`);
  }

  const name = value.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw planError('invalid_stop', `stops[${index}].name is required`);
  }
  if (name.length > MAX_STOP_NAME_LEN) {
    throw planError('invalid_stop', `stops[${index}].name must be at most ${MAX_STOP_NAME_LEN} characters`);
  }

  const nights = value.nights;
  if (typeof nights !== 'number' || !Number.isInteger(nights) || nights < 1 || nights > PLAN_LIMITS.nightsMax) {
    throw planError('invalid_stop', `stops[${index}].nights must be an integer between 1 and ${PLAN_LIMITS.nightsMax}`);
  }

  const stop: PlanStop = { km, name: name.trim(), nights };

  if (value.waypointId !== undefined && value.waypointId !== null) {
    stop.waypointId = validateWaypointId(value.waypointId);
  }

  if (value.note !== undefined && value.note !== null) {
    if (typeof value.note !== 'string') {
      throw planError('invalid_stop', `stops[${index}].note must be a string`);
    }
    const note = value.note.trim();
    if (note.length > PLAN_LIMITS.noteMax) {
      throw planError('invalid_stop', `stops[${index}].note must be at most ${PLAN_LIMITS.noteMax} characters`);
    }
    if (note.length > 0) stop.note = note;
  }

  if (value.booked !== undefined && value.booked !== null) {
    if (typeof value.booked !== 'boolean') {
      throw planError('invalid_stop', `stops[${index}].booked must be a boolean`);
    }
    if (value.booked) stop.booked = true;
  }

  if (value.alternate !== undefined && value.alternate !== null) {
    stop.alternate = validateAlternateName(value.alternate, `stops[${index}].alternate`);
  }

  return stop;
}

/** An alternate's name, as `alternates` and a stop's `alternate` hold it. */
function validateAlternateName(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw planError('invalid_alternate', `${field} must be a non-empty string`);
  }
  if (raw.length > PLAN_LIMITS.alternateNameMax) {
    throw planError('invalid_alternate', `${field} must be at most ${PLAN_LIMITS.alternateNameMax} characters`);
  }
  return raw;
}

/**
 * Validate a `PUT /v1/plans/:id` body (a `PlanDocument` minus `updatedAt`) and
 * return the document as it will be stored, stamped with the server clock.
 *
 * The whole document is rebuilt field by field rather than passed through, so
 * nothing a client invents is persisted and the 64 KB ceiling is measured on
 * exactly the bytes we store.
 */
export function validatePlanDocument(body: Record<string, unknown>, pathId: string, updatedAt: string): PlanDocument {
  if (typeof body.id !== 'string' || body.id !== pathId) {
    throw planError('id_mismatch', 'Body id must equal the id in the path');
  }

  const trailId = validatePlanTrailId(body.trailId);

  if (typeof body.name !== 'string') {
    throw planError('invalid_plan_name', 'name must be a string');
  }
  const name = body.name.trim();
  if (name.length > PLAN_LIMITS.nameMax) {
    throw planError('invalid_plan_name', `name must be at most ${PLAN_LIMITS.nameMax} characters`);
  }

  if (typeof body.direction !== 'string' || !PLAN_DIRECTIONS.includes(body.direction as PlanDirection)) {
    throw planError('invalid_direction', "direction must be 'NOBO' or 'SOBO'");
  }
  const direction = body.direction as PlanDirection;

  let startDate: string | null = null;
  if (body.startDate !== undefined && body.startDate !== null) {
    if (typeof body.startDate !== 'string' || !ISO_DATE_RE.test(body.startDate)) {
      throw planError('invalid_start_date', 'startDate must be a YYYY-MM-DD date or null');
    }
    const parsed = new Date(`${body.startDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== body.startDate) {
      throw planError('invalid_start_date', 'startDate must be a real calendar date');
    }
    startDate = body.startDate;
  }

  if (!Array.isArray(body.stops)) {
    throw planError('invalid_stops', 'stops must be an array');
  }
  if (body.stops.length > PLAN_LIMITS.stopsMax) {
    throw planError('too_many_stops', `A plan may have at most ${PLAN_LIMITS.stopsMax} stops`);
  }
  const stops = body.stops.map((stop, i) => validatePlanStop(stop, i));

  // The alternates the plan takes (plan-alternates.ts). Names are the trail's
  // own and are not checked against it: the trail data can be rebuilt after a
  // plan is made, and the clients ignore a name they do not know.
  let alternates: string[] | undefined;
  if (body.alternates !== undefined && body.alternates !== null) {
    if (!Array.isArray(body.alternates)) {
      throw planError('invalid_alternates', 'alternates must be an array of names');
    }
    if (body.alternates.length > PLAN_LIMITS.alternatesMax) {
      throw planError('invalid_alternates', `alternates may have at most ${PLAN_LIMITS.alternatesMax} entries`);
    }
    alternates = body.alternates.map((name, i) => validateAlternateName(name, `alternates[${i}]`));
    if (new Set(alternates).size !== alternates.length) {
      throw planError('invalid_alternates', 'alternates must not repeat a name');
    }
  }

  const lastOnLine = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) {
    if (i > 0 && stops[i].km < stops[i - 1].km) {
      throw planError('stops_unsorted', 'stops must be sorted by km ascending');
    }
    const line = stops[i].alternate;
    if (line !== undefined && !alternates?.includes(line)) {
      throw planError('invalid_stop', `stops[${i}].alternate is not one of the plan's alternates`);
    }
    // The document's own rule (plans/day-planner.md): one stop per place. The
    // list is ascending by here, so on each line (the main route, or one
    // alternate — whose km is its own scale, overlapping the main route's) the
    // previous stop is the only one that can collide, and `KM_EPSILON` is the
    // same tolerance the editor matches with — two stops closer than that are
    // one stop the client counted twice.
    const previous = lastOnLine.get(line ?? '');
    if (previous !== undefined && stops[i].km - stops[previous].km < KM_EPSILON) {
      throw planError(
        'duplicate_stop_km',
        `stops[${i}].km is the same place as stops[${previous}].km (within ${KM_EPSILON} km)`
      );
    }
    lastOnLine.set(line ?? '', i);
  }

  const seenWaypoints = new Set<string>();
  for (let i = 0; i < stops.length; i++) {
    const waypointId = stops[i].waypointId;
    if (waypointId === undefined) continue;
    if (seenWaypoints.has(waypointId)) {
      throw planError('duplicate_stop_waypoint', `stops[${i}].waypointId appears twice`);
    }
    seenWaypoints.add(waypointId);
  }

  if (body.version !== 1) {
    throw planError('invalid_plan_version', 'version must be 1');
  }

  const document: PlanDocument = {
    id: pathId,
    trailId,
    name,
    direction,
    startDate,
    stops,
    updatedAt,
    version: 1,
  };

  if (body.resupplyStops !== undefined && body.resupplyStops !== null) {
    if (!Array.isArray(body.resupplyStops)) {
      throw planError('invalid_resupply_stops', 'resupplyStops must be an array of waypoint ids');
    }
    if (body.resupplyStops.length > PLAN_LIMITS.stopsMax) {
      throw planError('invalid_resupply_stops', `resupplyStops may have at most ${PLAN_LIMITS.stopsMax} entries`);
    }
    document.resupplyStops = body.resupplyStops.map((id) => validateWaypointId(id));
  }

  // Zero days per resupply stop, by option (waypoint) id. Refused rather than
  // trimmed, like every other field: a client sending one the editor would
  // not have written is a bug, and dropping it silently would lose the hiker's
  // plan on the next sync. An empty map is stored as no map, so a plan without
  // zero days reads exactly as before the field existed.
  if (body.resupplyZeroDays !== undefined && body.resupplyZeroDays !== null) {
    const raw = body.resupplyZeroDays;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw planError('invalid_resupply_zero_days', 'resupplyZeroDays must be an object of waypoint id to days');
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > PLAN_LIMITS.resupplyZeroDaysMax) {
      throw planError(
        'invalid_resupply_zero_days',
        `resupplyZeroDays may have at most ${PLAN_LIMITS.resupplyZeroDaysMax} entries`
      );
    }
    const zeroDays: Record<string, number> = {};
    for (const [id, days] of entries) {
      if (!WAYPOINT_ID_RE.test(id)) {
        throw planError('invalid_resupply_zero_days', 'resupplyZeroDays keys must match ^[a-z0-9_-]{4,64}$');
      }
      if (!isStoredZeroDays(days)) {
        throw planError(
          'invalid_resupply_zero_days',
          `resupplyZeroDays values must be half-day steps from 0.5 to ${PLAN_LIMITS.zeroDaysMax}`
        );
      }
      zeroDays[id] = days;
    }
    if (entries.length > 0) document.resupplyZeroDays = zeroDays;
  }

  if (alternates !== undefined && alternates.length > 0) {
    document.alternates = alternates;
  }

  // The trail data the plan was last saved against (an ISO time). A client
  // compares it with its own data before moving stops (`refreshStopKms`), so
  // the server keeps it as sent, normalised — and only a real, past time.
  if (body.dataUpdatedAt !== undefined && body.dataUpdatedAt !== null) {
    const raw = body.dataUpdatedAt;
    const t = typeof raw === 'string' && ISO_TIMESTAMP_RE.test(raw) ? Date.parse(raw) : NaN;
    if (Number.isNaN(t)) {
      throw planError('invalid_data_updated_at', 'dataUpdatedAt must be an ISO 8601 UTC timestamp');
    }
    if (t > Date.parse(updatedAt) + DATA_UPDATED_AT_FUTURE_TOLERANCE_MS) {
      throw planError('invalid_data_updated_at', 'dataUpdatedAt must not be in the future');
    }
    document.dataUpdatedAt = new Date(t).toISOString();
  }

  return document;
}

/** Serialise a validated document, rejecting anything over the 64 KB ceiling. */
export function serialisePlanDocument(document: PlanDocument): string {
  const json = JSON.stringify(document);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > PLAN_LIMITS.documentBytes) {
    throw new HttpError(413, 'plan_too_large', `A plan document must be at most ${PLAN_LIMITS.documentBytes} bytes`);
  }
  return json;
}
