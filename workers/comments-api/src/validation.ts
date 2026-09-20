/**
 * Input validation for the comments API. Every function here either returns a
 * cleaned value or throws an `HttpError` with the right status/code.
 */

import { HttpError } from './http';
import type { ReportReason, WaterStatus } from '../../../src/lib/comments-api-types';
import { PLAN_LIMITS } from '../../../src/lib/plan-types';
import type { PlanDocument, PlanStop } from '../../../src/lib/plan-types';
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
  'heysen',
  'hume-and-hovell',
  'larapinta',
  'te_araroa',
];

const WAYPOINT_ID_RE = /^[a-z0-9_-]{4,64}$/;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    throw new HttpError(
      400,
      'invalid_display_name',
      `displayName must be at most ${MAX_DISPLAY_NAME_LEN} characters`
    );
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
    throw new HttpError(
      400,
      'invalid_waypoint',
      'waypointId must match ^[a-z0-9_-]{4,64}$'
    );
  }
  return raw;
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
    throw new HttpError(
      400,
      'invalid_water_status',
      "waterStatus must be one of 'flowing', 'low', 'dry'"
    );
  }
  return raw as WaterStatus;
}

/** Validate a report reason against the enum. */
export function validateReportReason(raw: unknown): ReportReason {
  if (typeof raw !== 'string' || !REPORT_REASONS.includes(raw as ReportReason)) {
    throw new HttpError(
      400,
      'invalid_reason',
      "reason must be one of 'spam', 'offensive', 'inaccurate', 'other'"
    );
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
    throw new HttpError(
      400,
      'invalid_detail',
      `detail must be at most ${MAX_REPORT_DETAIL_LEN} characters`
    );
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
    throw new HttpError(
      400,
      'invalid_description',
      `description must be at most ${MAX_DESCRIPTION_LEN} characters`
    );
  }
  return trimmed;
}

/**
 * Validate + clamp an optional `observedAt` timestamp. Malformed timestamps are
 * rejected; timestamps further than 10 min into the future are clamped down to
 * `now + 10min` (never rejected). Returns an ISO string or null.
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
  const clamped = Math.min(parsed, ceiling);
  return new Date(clamped).toISOString();
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
const MAX_STOP_NAME_LEN = 200;

/** Assert `:id` from a plan path is a client-minted UUID v4. */
export function assertClientPlanId(id: string): void {
  if (!isUuidV4(id)) {
    throw new HttpError(400, 'invalid_plan_id', 'Plan id must be a UUID v4');
  }
}

/**
 * A plan's trail must be a bundled trail. An imported trail's `u_…` id is
 * rejected here rather than stored, so a bug in a client's "is this trail
 * server-known?" gate can never leak someone's private import to the server.
 */
export function validatePlanTrailId(raw: unknown): string {
  if (typeof raw !== 'string' || !ALLOWED_TRAILS.includes(raw)) {
    throw new HttpError(
      400,
      'trail_not_allowed',
      'trailId must be one of the bundled trails (imported trails stay on the device)'
    );
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
  if (
    typeof nights !== 'number' ||
    !Number.isInteger(nights) ||
    nights < 1 ||
    nights > PLAN_LIMITS.nightsMax
  ) {
    throw planError(
      'invalid_stop',
      `stops[${index}].nights must be an integer between 1 and ${PLAN_LIMITS.nightsMax}`
    );
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
      throw planError(
        'invalid_stop',
        `stops[${index}].note must be at most ${PLAN_LIMITS.noteMax} characters`
      );
    }
    if (note.length > 0) stop.note = note;
  }

  if (value.booked !== undefined && value.booked !== null) {
    if (typeof value.booked !== 'boolean') {
      throw planError('invalid_stop', `stops[${index}].booked must be a boolean`);
    }
    if (value.booked) stop.booked = true;
  }

  return stop;
}

/**
 * Validate a `PUT /v1/plans/:id` body (a `PlanDocument` minus `updatedAt`) and
 * return the document as it will be stored, stamped with the server clock.
 *
 * The whole document is rebuilt field by field rather than passed through, so
 * nothing a client invents is persisted and the 64 KB ceiling is measured on
 * exactly the bytes we store.
 */
export function validatePlanDocument(
  body: Record<string, unknown>,
  pathId: string,
  updatedAt: string
): PlanDocument {
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
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].km < stops[i - 1].km) {
      throw planError('stops_unsorted', 'stops must be sorted by km ascending');
    }
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
      throw planError(
        'invalid_resupply_stops',
        `resupplyStops may have at most ${PLAN_LIMITS.stopsMax} entries`
      );
    }
    document.resupplyStops = body.resupplyStops.map((id) => validateWaypointId(id));
  }

  return document;
}

/** Serialise a validated document, rejecting anything over the 64 KB ceiling. */
export function serialisePlanDocument(document: PlanDocument): string {
  const json = JSON.stringify(document);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > PLAN_LIMITS.documentBytes) {
    throw new HttpError(
      413,
      'plan_too_large',
      `A plan document must be at most ${PLAN_LIMITS.documentBytes} bytes`
    );
  }
  return json;
}
