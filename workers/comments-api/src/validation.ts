/**
 * Input validation for the comments API. Every function here either returns a
 * cleaned value or throws an `HttpError` with the right status/code.
 */

import { HttpError } from './http';
import type { ReportReason, WaterStatus } from '../../../src/lib/comments-api-types';

/**
 * Allowlist of trail ids that may receive comments.
 *
 * IMPORTANT: this MUST stay in sync with the trail ids bundled in the mobile
 * app (the folder names under `data/trails/` that ship in the build). A comment
 * against a trail the app doesn't know about can never be displayed, so we
 * reject it at write time rather than store dead data.
 */
export const ALLOWED_TRAILS: readonly string[] = [
  'aawt',
  'bibbulmun',
  'cape_to_cape',
  'heysen',
  'hume-and-hovell',
  'larapinta',
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
