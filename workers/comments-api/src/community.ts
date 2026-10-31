/**
 * Community routes: hikers' own GPX imports, shared with everyone.
 * Spec: `plans/community-routes.md`; wire types: `src/lib/community-types.ts`.
 *
 * A submission carries the client's processed trail. The worker trusts none of
 * it: `runCommunityChecks` copies only coordinates, elevations, names and text
 * from the client, recomputes distances, display points, elevation totals and
 * waypoint/variant km itself, drops route breaks, POIs and cumulative
 * elevation, and re-runs every automatic check (the `speed` check reads the
 * raw GPX, when one came with the route). The stats in the row come from that
 * rebuilt copy, and the stored JSON's `config` is rewritten here (id, name,
 * source, region, description, attribution). A passing route is public at
 * once as `unverified`; the AI review (`community-review.ts`) runs afterwards
 * from `ctx.waitUntil` and fails open.
 *
 * Concurrency: every write that changes a row sets `updated_at` to a stamp
 * strictly later than the one it read (`stampAfter`). A write computed from a
 * row it loaded earlier — an owner's edit, a de-attribution, an admin's status
 * change, the AI review — is guarded by `updated_at = <the value it read>`, so
 * a decision made meanwhile (a hide, a restore, a delete) is never undone by
 * stale state; the loser drops the objects it wrote. The review's own write
 * leaves `updated_at` alone, or it would invalidate itself.
 *
 * Storage: a D1 row per route (migrations 0005 and 0006) and, in the PHOTOS bucket:
 *
 * - the canonical trail JSON at `community/private/<id>/<32 random hex>.json`
 *   (`private_key`), written on submit and on every republish;
 * - while the route is live (`unverified`/`verified`), a public copy of the
 *   same bytes at a content-addressed key, `community/v1/<id>.<md5[0..12]>.json`
 *   (`r2_key`, NULL while there is none). An owner's edit writes a new public
 *   key and keeps the one it replaced — lists cached for 60 s at the edge and
 *   for up to 30 min on phones still name it — but purges every version older
 *   than that (`purgeSuperseded`). A de-attribution purges every older
 *   version at once: they name the account. Hiding a route deletes every
 *   public object under `community/v1/<id>.`; restoring it republishes from
 *   the private copy;
 *   removing it purges both prefixes;
 * - the optional raw GPX at `community/private/<id>/<32 random hex>.gpx`
 *   (`gpx_key`), kept for re-processing and never returned in any response.
 *   Deleting the account that shared it deletes it (the de-attribution).
 *
 * The bucket has no private area: all of `aus-map-data` is served at
 * `PHOTOS_PUBLIC_BASE`. What keeps the private objects private is that their
 * keys are unguessable (128 random bits) and never leave the worker — an R2
 * custom domain serves objects by exact key and does not list a bucket.
 */

import { HttpError, json, noContent } from './http';
import type { Env } from './http';
import { getUser, requireAdmin, requireUser, sha256Hex } from './auth';
import type { AuthUser } from './auth';
import { RATE_BUCKETS, consumeRateLimit } from './rate-limit';
import { isUniqueConstraintError } from './plans';
import { decodeCursor, encodeCursor } from './cursor';
import { reviewHides, runAiReview } from './community-review';
import type { ReviewClient } from './community-review';
import {
  deleteObjects,
  encodeTrail,
  privateKey,
  publishFromPrivate,
  purgeAll,
  purgePublic,
  purgePrivateOrThrow,
  purgePublicOrThrow,
  putTrail,
  poiAnswerKey,
  readStoredTrail,
} from './community-storage';
import type { StoredTrail } from './community-storage';
import {
  POI_LIMITS,
  WORST_REQUEST_MS,
  fetchRoutePois,
  newOverpassBudget,
  parseOverpassEndpoints,
  planPoiQueries,
  queryHash,
} from './community-pois';
import type { OverpassBudget, OverpassDeps, PoiAnswerCache, PoiFailure } from './community-pois';
import {
  checkCommunityMetadata,
  checkCommunityRegion,
  hasFailures,
  runCommunityChecks,
} from '../../../src/lib/community-checks';
import type { CommunityRouteStats } from '../../../src/lib/community-checks';
import {
  COMMUNITY_LIMITS,
  COMMUNITY_REPORTS_TO_HIDE,
  COMMUNITY_REPORT_REASONS,
  isCommunityRouteId,
} from '../../../src/lib/community-types';
import type {
  CommunityAdminListResponse,
  CommunityAiReview,
  CommunityCheck,
  CommunityChecksFailedBody,
  CommunityListResponse,
  CommunityReportReason,
  CommunityRouteDetail,
  CommunityRouteStatus,
  CommunityRouteSummary,
} from '../../../src/lib/community-types';
import { isValidCountry, isValidState } from '../../../src/lib/trail-regions';
import { haversineDistance } from '../../../src/lib/distance';
import type { ProcessedTrail, TrailDataSource } from '../../../src/lib/trail-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The text fields and JSON punctuation around the trail and the GPX. */
const BODY_SLACK_BYTES = 64 * 1024;

/** Whole request: the trail JSON, the GPX as base64 (4/3 of its size), and the text fields. */
const MAX_BODY_BYTES =
  COMMUNITY_LIMITS.trailJsonMaxBytes + Math.ceil((COMMUNITY_LIMITS.gpxMaxBytes * 4) / 3) + BODY_SLACK_BYTES;

/**
 * The request without its GPX: refused before it is parsed any further or
 * checked, so a body padded out to the GPX allowance cannot buy a 10 MB trail.
 */
const MAX_BODY_WITHOUT_GPX = COMMUNITY_LIMITS.trailJsonMaxBytes + BODY_SLACK_BYTES;

/**
 * A report counts towards the automatic hide only when its reporter's account
 * was at least this old when it was filed; a younger account's report is kept
 * (admins see it) but counts for nothing, so three fresh registrations cannot
 * take a route down.
 */
export const REPORTER_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

/** How often a de-attribution retries a route that changed under it. */
const DEATTRIBUTE_ATTEMPTS = 3;

const MAX_REPORT_NOTE = 500;

const MAX_STATUS_NOTE = 500;
/**
 * The `status_note` each automatic hide writes. `toDetail` reads them back as
 * the owner's `hiddenReason`; any other note on a hidden route (an admin's own
 * text, or none) means an admin hid it, so an admin may not write these.
 */
export const REVIEW_HIDE_NOTE = 'Hidden by the automatic review';
export const REPORTS_HIDE_NOTE = `Hidden after ${COMMUNITY_REPORTS_TO_HIDE} reports`;
/** Page size of the public and owner lists, and the admin queue's length. */
const LIST_LIMIT = 1000;
/** Reports the admin queue carries per route, newest first (a route's own detail has all of them). */
const ADMIN_REPORTS_PER_ROUTE = 20;

/** The near-duplicate warning: ends within this and length within 5 %. */
const NEAR_DUPLICATE_M = 200;
const NEAR_DUPLICATE_LENGTH = 0.05;

/** Name shown for a route whose submitter is unknown or has deleted their account. */
const ANONYMOUS_SUBMITTER = 'a Tracknotes user';

// Control characters other than tab/newline/carriage return; names and
// credits take no newlines either.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK_RE = /[\r\n\t]/;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface CommunityRouteRow {
  id: string;
  user_id: string;
  status: CommunityRouteStatus;
  name: string;
  description: string;
  credit: string | null;
  country: string;
  state: string | null;
  length_km: number;
  ascent_m: number;
  has_elevation: number;
  waypoint_count: number;
  bbox_json: string;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  content_hash: string;
  md5: string;
  bytes: number;
  /** The public copy, or NULL while the route is hidden. */
  r2_key: string | null;
  /** The canonical trail JSON; never public, never in a response. */
  private_key: string;
  /** Never public, never in a response. */
  gpx_key: string | null;
  checks_json: string;
  review_json: string | null;
  review_status: CommunityAiReview['status'];
  submitted_by_name: string | null;
  status_note: string | null;
  created_at: string;
  updated_at: string;
  /** Insert or the last admin status change; only reports after it count towards a hide. */
  status_changed_at: string;
  verified_at: string | null;
  verified_by: string | null;
  removed_at: string | null;
  /** 1 while the submitter's account is deleted but the stored JSON still names them (0006). */
  deattribute_pending: number;
  /** Who removed it: the owner's own delete or an admin's (0006); NULL while live. */
  removed_by: 'owner' | 'admin' | null;
  /** 1 on a removed route whose track may not be shared again (0006). */
  blocks_resubmit: number;
  /** OSM POI enrichment (0009; `enrichCommunityRoutePois`). Never returned. */
  pois_status: 'pending' | 'done' | 'failed' | 'skipped';
  /** The `content_hash` the POI answer was for; NULL before the first. */
  pois_hash: string | null;
  poi_count: number;
  pois_attempts: number;
  pois_attempted_at: string | null;
  /** When the route is next due for POIs: '' at once, NULL when nothing is due. */
  pois_due_at: string | null;
  /** Consecutive failed attempts of any kind, for the back-off; 0 after an answer. */
  pois_failures: number;
  pois_error: string | null;
}

function publicBase(env: Env): string {
  return (env.PHOTOS_PUBLIC_BASE ?? '').replace(/\/+$/, '');
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toSummary(env: Env, row: CommunityRouteRow): CommunityRouteSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    country: row.country,
    state: row.state,
    lengthKm: row.length_km,
    ascentM: row.ascent_m,
    hasElevation: row.has_elevation === 1,
    waypointCount: row.waypoint_count,
    bbox: parseJson<[number, number, number, number]>(row.bbox_json, [0, 0, 0, 0]),
    start: { lat: row.start_lat, lon: row.start_lon },
    submittedBy: row.submitted_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    reviewed: row.review_status === 'done',
    trailUrl: row.r2_key ? `${publicBase(env)}/${row.r2_key}` : null,
    md5: row.md5,
    bytes: row.bytes,
  };
}

function reviewOf(row: CommunityRouteRow): CommunityAiReview {
  return parseJson<CommunityAiReview>(row.review_json, { status: row.review_status });
}

interface ReportRow {
  route_id: string;
  reason: CommunityReportReason;
  note: string | null;
  created_at: string;
}

type Viewer = 'public' | 'owner' | 'admin';

/** What hid a route, from the note its hide wrote; never the note itself. */
function hiddenReasonOf(note: string | null): NonNullable<CommunityRouteDetail['hiddenReason']> {
  if (note === REVIEW_HIDE_NOTE) return 'review';
  if (note === REPORTS_HIDE_NOTE) return 'reports';
  return 'admin';
}

function toDetail(
  env: Env,
  row: CommunityRouteRow,
  viewer: Viewer,
  isOwner: boolean,
  reports: ReportRow[] = [],
  /** Every report's count, when `reports` is only the newest few. */
  reportCount = reports.length
): CommunityRouteDetail {
  const detail: CommunityRouteDetail = {
    ...toSummary(env, row),
    description: row.description,
    credit: row.credit,
    licence: 'CC0-1.0',
    checks: parseJson<CommunityCheck[]>(row.checks_json, []),
  };
  if (viewer === 'owner' || viewer === 'admin') {
    detail.review = reviewOf(row);
    detail.isOwner = isOwner;
    if (row.status === 'hidden') detail.hiddenReason = hiddenReasonOf(row.status_note);
  }
  if (viewer === 'admin') {
    detail.reportCount = reportCount;
    detail.reports = reports.map((r) => ({ reason: r.reason, note: r.note, createdAt: r.created_at }));
    detail.statusNote = row.status_note;
  }
  return detail;
}

async function loadRoute(env: Env, id: string): Promise<CommunityRouteRow | null> {
  if (!isCommunityRouteId(id)) return null;
  return env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`).bind(id).first<CommunityRouteRow>();
}

async function reportsFor(env: Env, id: string): Promise<ReportRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT route_id, reason, note, created_at FROM community_route_reports
      WHERE route_id = ? ORDER BY created_at DESC, id DESC`
  )
    .bind(id)
    .all<ReportRow>();
  return results;
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Community route not found');
}

function assertNotBanned(user: AuthUser, what: string): void {
  if (user.is_banned === 1) {
    throw new HttpError(403, 'banned', `This account may not ${what}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function cleanText(raw: unknown, field: string, min: number, max: number, allowLineBreaks: boolean): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, `invalid_${field}`, `${field} must be a string`);
  }
  const value = raw.trim();
  if (value.length < min || value.length > max) {
    throw new HttpError(400, `invalid_${field}`, `${field} must be ${min} to ${max} characters`);
  }
  if (CONTROL_RE.test(value) || (!allowLineBreaks && LINE_BREAK_RE.test(value))) {
    throw new HttpError(400, `invalid_${field}`, `${field} contains control characters`);
  }
  return value;
}

function cleanCredit(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return cleanText(raw, 'credit', 1, COMMUNITY_LIMITS.creditMax, false);
}

function cleanRegion(rawCountry: unknown, rawState: unknown): { country: string; state: string | null } {
  if (!isValidCountry(rawCountry)) {
    throw new HttpError(400, 'invalid_country', 'country must be an ISO 3166-1 alpha-2 code');
  }
  const country = rawCountry.toUpperCase();
  if (rawState === undefined || rawState === null || rawState === '') {
    return { country, state: null };
  }
  if (typeof rawState !== 'string') {
    throw new HttpError(400, 'invalid_state', 'state must be a string or null');
  }
  const state = rawState.toUpperCase();
  if (!isValidState(country, state)) {
    throw new HttpError(400, 'invalid_state', `state ${state} is not a region of ${country}`);
  }
  return { country, state };
}

/** Read the body under a byte cap: a 413 rather than buffering an unbounded upload. */
async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'too_large', 'The upload is too large');
  }
  const text = await request.text();
  // UTF-16 length is at most the UTF-8 byte length, so this never under-counts
  // an ASCII body and a non-ASCII one is re-measured below only when close.
  if (text.length > maxBytes || (text.length > maxBytes / 3 && new TextEncoder().encode(text).byteLength > maxBytes)) {
    throw new HttpError(413, 'too_large', 'The upload is too large');
  }
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

async function readSmallJson(request: Request): Promise<Record<string, unknown>> {
  return parseJsonObject(await readCappedText(request, 64 * 1024));
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** How much of the decoded GPX is looked at for `<` / `<gpx`. */
const GPX_SNIFF_BYTES = 1024;

interface DecodedGpx {
  bytes: Uint8Array;
  /** The file as text, for the `speed` check (the processed points carry no timestamps). */
  text: string;
}

/**
 * Decode and sanity-check the optional raw GPX. Malformed base64 is a 400 and
 * an oversized file a 413, but a file that does not look like a GPX is
 * dropped (null): the GPX is optional, and the route is judged on its trail.
 */
function decodeGpx(raw: unknown): DecodedGpx | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_gpx', 'gpxBase64 must be a base64 string');
  }
  const b64 = raw.replace(/\s+/g, '');
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new HttpError(400, 'invalid_gpx', 'gpxBase64 is not valid base64');
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if ((b64.length / 4) * 3 - padding > COMMUNITY_LIMITS.gpxMaxBytes) {
    throw new HttpError(413, 'gpx_too_large', `The GPX file must be at most ${COMMUNITY_LIMITS.gpxMaxBytes} bytes`);
  }
  const binary = atob(b64);
  // Sniff the head only: an XML declaration, a comment or two, then `<gpx`.
  // Decoding all of a 5 MB file to text just to look at its start would hold
  // a third copy of it for nothing.
  const head = binary
    .slice(0, GPX_SNIFF_BYTES)
    .replace(/^\xEF\xBB\xBF/, '')
    .trimStart();
  if (head.charAt(0) !== '<' || !head.includes('<gpx')) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, text: new TextDecoder().decode(bytes) };
}

// ---------------------------------------------------------------------------
// Hashes, ids, stamps, storage
// ---------------------------------------------------------------------------

/**
 * Now, as an ISO stamp strictly later than `previous`: the `updated_at` a
 * write sets. Guarded writes compare `updated_at` for equality, so two writes
 * in the same millisecond (or an isolate whose clock lags) must still leave
 * different stamps.
 */
export function stampAfter(previous: string): string {
  const prev = Date.parse(previous);
  const now = Date.now();
  return new Date(Number.isFinite(prev) && now <= prev ? prev + 1 : now).toISOString();
}

/** `c_` + 16 url-safe random chars (12 random bytes). */
function generateRouteId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `c_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')}`;
}

/**
 * The duplicate key: the route itself (track, waypoints, variants, POIs), not
 * its config — the config carries the client's `u_` id and whatever name it
 * was given, and renaming a route does not make it a different route.
 */
async function contentHash(trail: ProcessedTrail): Promise<string> {
  const { config: _config, ...rest } = trail;
  return sha256Hex(JSON.stringify(rest));
}

/** The credit for OpenStreetMap's POIs in a route that carries them (ODbL requires one). */
export const POI_DATA_CREDIT =
  'Points of interest © OpenStreetMap contributors, under the Open Database Licence (ODbL), not CC0.';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/**
 * A route's `config.dataSource`: the hiker's own contribution is CC0; the
 * OpenStreetMap POIs the enrichment adds stay ODbL and are credited as such,
 * with a link to OSM's copyright page.
 */
function communityDataSource(submittedBy: string | null, credit: string | null, hasPois: boolean): TrailDataSource {
  const text = `Shared by ${submittedBy ?? ANONYMOUS_SUBMITTER} under CC0.${credit ? ` ${credit}` : ''}`;
  if (!hasPois) return { text };
  return { text: `${text} ${POI_DATA_CREDIT}`, url: OSM_COPYRIGHT_URL, linkText: 'openstreetmap.org/copyright' };
}

interface StoredMeta {
  id: string;
  name: string;
  description: string;
  credit: string | null;
  country: string;
  state: string | null;
  submittedBy: string | null;
}

/** The trail as published: the validated copy with the config written here. */
function withServerConfig(trail: ProcessedTrail, meta: StoredMeta): ProcessedTrail {
  return {
    ...trail,
    config: {
      ...trail.config,
      id: meta.id,
      name: meta.name,
      shortName: meta.name,
      region: meta.state ?? meta.country,
      source: 'community',
      country: meta.country,
      states: meta.state ? [meta.state] : [],
      description: meta.description,
      dataSource: communityDataSource(meta.submittedBy, meta.credit, (trail.pois?.length ?? 0) > 0),
    },
  };
}

function isLive(status: CommunityRouteStatus): boolean {
  return status === 'unverified' || status === 'verified';
}

function conflict(message = 'The route changed while you were editing it; reload and try again'): HttpError {
  return new HttpError(409, 'conflict', message);
}

/**
 * After a guarded write lost its race: drop the objects it wrote, except any
 * the row names now. A public key is content-addressed, so the winner may
 * have written (and named) the very same one.
 */
async function discardUnclaimed(env: Env, id: string, keys: (string | null)[]): Promise<void> {
  const current = await loadRoute(env, id);
  const named = new Set([current?.r2_key, current?.private_key, current?.gpx_key]);
  await deleteObjects(
    env,
    keys.filter((k) => k && !named.has(k))
  );
}

/**
 * Take a hidden route's public copies down and clear `r2_key`. Run after the
 * status change, from whichever path hid it (admin, AI review, reports). The
 * `status = 'hidden'` guard keeps a restore that raced ahead from losing its
 * fresh key.
 *
 * A restore can also land while the purge is running, and its public copy is
 * content-addressed — quite possibly the very key being purged. So the row is
 * read again afterwards, and a route that is live by then is put back on the
 * public domain from its private copy.
 */
async function unpublish(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE community_routes SET r2_key = NULL WHERE id = ? AND status = 'hidden'`).bind(id).run();
  await purgePublic(env, id);

  const row = await loadRoute(env, id);
  if (!row || !isLive(row.status)) return;
  const key = await publishFromPrivate(env, row.id, row.private_key);
  if (!key) {
    console.error(`Republishing ${id} after a purge failed: its private copy is missing`);
    return;
  }
  // A repair of the same version, so `updated_at` stays as it is.
  await env.DB.prepare(
    `UPDATE community_routes SET r2_key = ?
      WHERE id = ? AND updated_at = ? AND status IN ('unverified', 'verified')`
  )
    .bind(key, id, row.updated_at)
    .run();
}

/**
 * Re-store a route's JSON with a fresh config (after an edit or a
 * de-attribution), from its private copy: a new private object, and a new
 * public one while the route is live. Nothing is deleted here: the older
 * public versions (`purgeSuperseded`, or every one for a de-attribution)
 * and the old private object are the caller's to drop once the row no longer
 * names them. Returns null when the stored copy is missing.
 */
async function republish(
  env: Env,
  row: CommunityRouteRow,
  meta: Omit<StoredMeta, 'id'>,
  publish: boolean
): Promise<(StoredTrail & { trail: ProcessedTrail }) | null> {
  const trail = await readStoredTrail(env, row.private_key);
  if (!trail) return null;
  const put = await putTrail(env, row.id, await encodeTrail(withServerConfig(trail, { ...meta, id: row.id })), publish);
  return { ...put, trail };
}

/**
 * How long a freshly uploaded public version is safe from `purgeSuperseded`.
 * A concurrent republish (a second edit, a restore) puts its object before its
 * row names it; this keeps a purge running in between from deleting it.
 */
export const SUPERSEDED_PURGE_GRACE_MS = 2 * 60 * 1000;

/**
 * After an owner's edit: drop every public version of the route except the
 * new one, the one it replaced (lists cached on the edge and on phones still
 * name it; it goes at the next edit, hide or removal), whatever the row names
 * by now, and anything uploaded in the last `graceMs`. Never throws.
 */
async function purgeSuperseded(
  env: Env,
  id: string,
  keep: (string | null)[],
  graceMs = SUPERSEDED_PURGE_GRACE_MS
): Promise<void> {
  try {
    const current = await loadRoute(env, id);
    if (!current || current.status === 'removed' || current.status === 'hidden') return; // their own purges cover it
    await purgePublic(env, id, [...keep, current.r2_key], new Date(Date.now() - graceMs));
  } catch (err) {
    console.error(`Purging superseded copies of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// AI review (stored)
// ---------------------------------------------------------------------------

export interface ReviewDeps {
  client?: ReviewClient;
  /** The trail, when the caller already has it (saves an R2 read). */
  trail?: ProcessedTrail;
}

/** Test seams for the owner's edit. */
export interface PatchDeps extends Omit<ReviewDeps, 'trail'> {
  /** `purgeSuperseded`'s grace for fresh uploads (default `SUPERSEDED_PURGE_GRACE_MS`). */
  purgeGraceMs?: number;
}

/** Test seam for the submit handler: the checks it runs (default `runCommunityChecks`). */
export interface SubmitDeps extends Omit<ReviewDeps, 'trail'> {
  runChecks?: typeof runCommunityChecks;
}

/**
 * Review a stored route and record the outcome. A confident reject hides an
 * `unverified` route; a verified or already hidden one is left to the admin.
 * Never throws (it runs from `waitUntil`).
 *
 * The verdict is about the row as it was read here. If anything changed it
 * while the model was thinking — an owner's edit (which schedules its own
 * review), an admin's restore or verify, a de-attribution — `updated_at` has
 * moved and nothing is written: a stale verdict must not overwrite a newer
 * one, nor hide a route an admin has just put back.
 */
export async function reviewStoredRoute(env: Env, id: string, deps: ReviewDeps = {}): Promise<void> {
  try {
    const row = await loadRoute(env, id);
    if (!row || row.status === 'removed') return;
    const version = row.updated_at;
    const trail = deps.trail ?? (await readStoredTrail(env, row.private_key));
    let review: CommunityAiReview;
    if (!trail) {
      review = { status: 'failed', error: 'trail_missing', reviewedAt: new Date().toISOString() };
    } else {
      review = await runAiReview(
        env,
        {
          name: row.name,
          description: row.description,
          credit: row.credit,
          country: row.country,
          state: row.state,
          lengthKm: row.length_km,
          ascentM: row.ascent_m,
          checks: parseJson<CommunityCheck[]>(row.checks_json, []),
          bbox: parseJson<[number, number, number, number]>(row.bbox_json, [0, 0, 0, 0]),
          trail,
        },
        { client: deps.client }
      );
    }
    const hide = reviewHides(review);
    // Both guarded by the version read above. The first leaves `updated_at`
    // alone, so the hide in the same batch still matches it; the hide is a
    // status change and moves it. `status = 'unverified'`: a verified route
    // is the admin's to take down.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_routes SET review_json = ?, review_status = ?
          WHERE id = ? AND status != 'removed' AND updated_at = ?`
      ).bind(JSON.stringify(review), review.status, id, version),
      ...(hide
        ? [
            env.DB.prepare(
              `UPDATE community_routes
                  SET status = 'hidden', status_note = ?, updated_at = ?
                WHERE id = ? AND status = 'unverified' AND updated_at = ?`
            ).bind(REVIEW_HIDE_NOTE, stampAfter(version), id, version),
          ]
        : []),
    ]);
    if (hide && (results[1]?.meta.changes ?? 0) > 0) await unpublish(env, id);
  } catch (err) {
    console.error(`Community review of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The review state a write starts from, and whether to schedule the call. */
function initialReview(env: Env): { status: CommunityAiReview['status']; json: string; run: boolean } {
  if (!env.ANTHROPIC_API_KEY) {
    const review: CommunityAiReview = { status: 'skipped', reviewedAt: new Date().toISOString() };
    return { status: 'skipped', json: JSON.stringify(review), run: false };
  }
  return { status: 'pending', json: JSON.stringify({ status: 'pending' }), run: true };
}

// ---------------------------------------------------------------------------
// POST /v1/community/routes — submit
// ---------------------------------------------------------------------------

/** Worker-only `duplicate` warning: a live route with the same ends and length. */
async function nearDuplicateCheck(env: Env, stats: CommunityRouteStats): Promise<CommunityCheck> {
  const dLat = NEAR_DUPLICATE_M / 111_000 + 1e-6;
  const dLon = dLat / Math.max(0.01, Math.cos((stats.start.lat * Math.PI) / 180));
  const { results } = await env.DB.prepare(
    `SELECT id, length_km, start_lat, start_lon, end_lat, end_lon FROM community_routes
      WHERE status IN ('unverified', 'verified')
        AND start_lat BETWEEN ? AND ? AND start_lon BETWEEN ? AND ?
      LIMIT 50`
  )
    .bind(stats.start.lat - dLat, stats.start.lat + dLat, stats.start.lon - dLon, stats.start.lon + dLon)
    .all<{ id: string; length_km: number; start_lat: number; start_lon: number; end_lat: number; end_lon: number }>();
  for (const r of results) {
    const startM = haversineDistance(r.start_lat, r.start_lon, stats.start.lat, stats.start.lon);
    const endM = haversineDistance(r.end_lat, r.end_lon, stats.end.lat, stats.end.lon);
    const lengthOff = Math.abs(r.length_km - stats.lengthKm) / Math.max(r.length_km, stats.lengthKm, 0.001);
    if (startM <= NEAR_DUPLICATE_M && endM <= NEAR_DUPLICATE_M && lengthOff <= NEAR_DUPLICATE_LENGTH) {
      return {
        id: 'duplicate',
        level: 'warn',
        // The id, not the name: the name is someone else's text, and this
        // message is shown back to the submitter and to the AI reviewer.
        message: `This looks like community route ${r.id}, which is already shared: it starts and ends in the same places and is about as long.`,
      };
    }
  }
  return { id: 'duplicate', level: 'pass', message: 'No shared route matches this one.' };
}

/**
 * The route's stored checks with its `metadata` entry re-run on edited text.
 * On submit a passing `metadata` check can be replaced by the waypoint-text
 * warning (`runCommunityChecks`); the waypoints do not change on an edit, so
 * that warning is kept while the new text still passes.
 */
function metadataChecksAfterEdit(row: CommunityRouteRow, name: string, description: string): CommunityCheck[] {
  const stored = parseJson<CommunityCheck[]>(row.checks_json, []);
  const fresh = checkCommunityMetadata({ name, description });
  const index = stored.findIndex((c) => c.id === 'metadata');
  const previous = index === -1 ? null : stored[index];
  const waypointWarning =
    previous !== null &&
    previous.level === 'warn' &&
    checkCommunityMetadata({ name: row.name, description: row.description }).level === 'pass';
  const entry = fresh.level === 'pass' && waypointWarning ? previous : fresh;
  if (index === -1) return [...stored, entry];
  return stored.map((c, i) => (i === index ? entry : c));
}

/** `checks` with the entry of `entry.id` replaced, or `entry` added before `duplicate`. */
function withCheck(checks: CommunityCheck[], entry: CommunityCheck): CommunityCheck[] {
  const index = checks.findIndex((c) => c.id === entry.id);
  if (index !== -1) return checks.map((c, i) => (i === index ? entry : c));
  const duplicate = checks.findIndex((c) => c.id === 'duplicate');
  return duplicate === -1 ? [...checks, entry] : [...checks.slice(0, duplicate), entry, ...checks.slice(duplicate)];
}

function checksFailed(checks: CommunityCheck[], message: string): Response {
  const body: CommunityChecksFailedBody = {
    error: { code: 'checks_failed', message },
    checks,
  };
  return json(body, 422);
}

export async function submitCommunityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: SubmitDeps = {}
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  assertNotBanned(user, 'share routes');
  // Every attempt, before the body is even read: a rejected submission costs
  // the worker a parse and a full check run, so failures are bounded too. The
  // `communitySubmit` limit below counts only routes that were published.
  await consumeRateLimit(
    env,
    RATE_BUCKETS.communitySubmitAttempt,
    user.id,
    Date.now(),
    `Too many share attempts today (at most ${RATE_BUCKETS.communitySubmitAttempt.limit}). Try again tomorrow.`,
    ctx
  );

  const text = await readCappedText(request, MAX_BODY_BYTES);
  const body = parseJsonObject(text);
  // The cap above allows for a 5 MB GPX. Without one, the trail must fit its
  // own cap: refuse it before the checks spend any CPU on it. (UTF-16 length,
  // so a non-ASCII trail can slip under here; the stored bytes are measured
  // exactly before anything is written.)
  const gpxChars = typeof body.gpxBase64 === 'string' ? body.gpxBase64.length : 0;
  if (text.length - gpxChars > MAX_BODY_WITHOUT_GPX) {
    throw new HttpError(
      413,
      'trail_too_large',
      `The processed route must be at most ${COMMUNITY_LIMITS.trailJsonMaxBytes} bytes`
    );
  }
  const name = cleanText(body.name, 'name', COMMUNITY_LIMITS.nameMin, COMMUNITY_LIMITS.nameMax, false);
  const description = cleanText(
    body.description,
    'description',
    COMMUNITY_LIMITS.descriptionMin,
    COMMUNITY_LIMITS.descriptionMax,
    true
  );
  const credit = cleanCredit(body.credit);
  const { country, state } = cleanRegion(body.country, body.state);
  if (body.rightsConfirmed !== true) {
    throw new HttpError(
      400,
      'rights_not_confirmed',
      'rightsConfirmed must be true: the track must be your own recording or openly licensed, released as CC0'
    );
  }
  const gpx = decodeGpx(body.gpxBase64);

  const runChecks = deps.runChecks ?? runCommunityChecks;
  const result = runChecks(body.trail, { name, description, gpxText: gpx?.text });
  if (!result.ok || !result.trail || !result.stats) {
    return checksFailed(result.checks, 'The route did not pass the automatic checks');
  }
  // The region the hiker chose is stored as given; a `region` warning is the
  // most the coordinates can say against it.
  const checks = [
    ...result.checks,
    checkCommunityRegion(result.trail.track.points, country, state),
    await nearDuplicateCheck(env, result.stats),
  ];

  const hash = await contentHash(result.trail);
  const blocked = await env.DB.prepare(
    `SELECT id FROM community_routes WHERE content_hash = ? AND blocks_resubmit = 1 LIMIT 1`
  )
    .bind(hash)
    .first<{ id: string }>();
  if (blocked) return removedByModeratorResponse();
  const existing = await env.DB.prepare(
    `SELECT id, user_id FROM community_routes WHERE content_hash = ? AND status != 'removed'`
  )
    .bind(hash)
    .first<DuplicateRow>();
  if (existing) return duplicateResponse(existing, user);

  const id = generateRouteId();
  const submittedBy = user.display_name;
  const stored = withServerConfig(result.trail, { id, name, description, credit, country, state, submittedBy });
  // Measured before the day's allowance is spent: an oversized route is
  // refused without costing the hiker one of their ten.
  const encoded = await encodeTrail(stored);

  await consumeRateLimit(
    env,
    RATE_BUCKETS.communitySubmit,
    user.id,
    Date.now(),
    `You can share at most ${COMMUNITY_LIMITS.submitsPerDay} routes a day`,
    ctx
  );

  const put = await putTrail(env, id, encoded, true);
  let gpxKey: string | null = null;
  if (gpx) {
    gpxKey = privateKey(id, 'gpx');
    await env.PHOTOS.put(gpxKey, gpx.bytes, { httpMetadata: { contentType: 'application/gpx+xml' } });
  }

  const stats = result.stats;
  const now = new Date().toISOString();
  const review = initialReview(env);
  try {
    await env.DB.prepare(
      `INSERT INTO community_routes
         (id, user_id, status, name, description, credit, country, state, length_km, ascent_m,
          has_elevation, waypoint_count, bbox_json, start_lat, start_lon, end_lat, end_lon,
          content_hash, md5, bytes, r2_key, private_key, gpx_key, checks_json, review_json, review_status,
          submitted_by_name, status_note, created_at, updated_at, status_changed_at,
          verified_at, verified_by, removed_at)
       VALUES (?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               NULL, ?, ?, ?, NULL, NULL, NULL)`
    )
      .bind(
        id,
        user.id,
        name,
        description,
        credit,
        country,
        state,
        stats.lengthKm,
        stats.ascentM,
        stats.hasElevation ? 1 : 0,
        stats.waypointCount,
        JSON.stringify(stats.bbox),
        stats.start.lat,
        stats.start.lon,
        stats.end.lat,
        stats.end.lon,
        hash,
        put.md5,
        put.bytes,
        put.publicKey,
        put.privateKey,
        gpxKey,
        JSON.stringify(checks),
        review.json,
        review.status,
        submittedBy,
        now,
        now,
        now
      )
      .run();
  } catch (err) {
    await deleteObjects(env, [put.publicKey, put.privateKey, gpxKey]);
    if (isUniqueConstraintError(err)) {
      // Lost a race with an identical submission.
      const winner = await env.DB.prepare(
        `SELECT id, user_id FROM community_routes WHERE content_hash = ? AND status != 'removed'`
      )
        .bind(hash)
        .first<DuplicateRow>();
      return duplicateResponse(winner, user);
    }
    throw err;
  }

  if (review.run || deps.client) {
    ctx.waitUntil(reviewStoredRoute(env, id, { client: deps.client, trail: stored }));
  }

  const row = await loadRoute(env, id);
  if (!row) throw new HttpError(500, 'insert_failed', 'Route could not be stored');
  return json(toDetail(env, row, 'owner', true), 201);
}

interface DuplicateRow {
  id: string;
  user_id: string;
}

/**
 * The track belongs to a route a moderator took down. A 409 `duplicate`
 * (clients already explain that one) with no id: the route it matches is gone.
 */
function removedByModeratorResponse(): Response {
  return json(
    {
      error: {
        code: 'duplicate',
        message: 'This exact track was shared before and removed by a moderator, so it cannot be shared again',
      },
    },
    409
  );
}

/**
 * The existing route may be hidden (or someone else's), so the wording says
 * only that the track was shared before, never that it is in the list. Its id
 * goes back only to its own submitter: anyone else holding a copy of the
 * track could otherwise find a hidden route's id.
 */
function duplicateResponse(existing: DuplicateRow | null, user: AuthUser): Response {
  return json(
    {
      error: { code: 'duplicate', message: 'This exact track has been shared before' },
      ...(existing && existing.user_id === user.id ? { existingId: existing.id } : {}),
    },
    409
  );
}

// ---------------------------------------------------------------------------
// GET /v1/community/routes — the public list
// ---------------------------------------------------------------------------

/** Test seam for the paged lists: the page size (default `LIST_LIMIT`). */
export interface ListDeps {
  pageSize?: number;
}

/**
 * Keyset paging over `ORDER BY created_at DESC, id DESC` (a total order: ids
 * are unique). Adds the cursor's condition to `where`/`binds`; a cursor that
 * does not decode to a stamp and a route id is a 400.
 */
function appendPageCursor(url: URL, where: string[], binds: unknown[]): void {
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (!cursor) return;
  if (!isCommunityRouteId(cursor.id) || !Number.isFinite(Date.parse(cursor.sortValue))) {
    throw new HttpError(400, 'invalid_cursor', 'malformed cursor');
  }
  where.push('(created_at < ? OR (created_at = ? AND id < ?))');
  binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
}

/**
 * Run a paged list: one row past the page tells whether there is another.
 * Returns the page and the cursor for the next one (null on the last page).
 */
async function runPage(
  env: Env,
  where: string[],
  binds: unknown[],
  pageSize: number
): Promise<{ rows: CommunityRouteRow[]; nextCursor: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(...binds, pageSize + 1)
    .all<CommunityRouteRow>();
  const rows = results.slice(0, pageSize);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: results.length > pageSize && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export async function listCommunityRoutes(request: Request, env: Env, deps: ListDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const where: string[] = [];
  const binds: unknown[] = [];

  const status = url.searchParams.get('status');
  if (status === 'unverified' || status === 'verified') {
    where.push('status = ?');
    binds.push(status);
  } else if (status === null || status === '') {
    where.push(`status IN ('unverified', 'verified')`);
  } else {
    throw new HttpError(400, 'invalid_status', "status must be 'unverified' or 'verified'");
  }

  const country = url.searchParams.get('country');
  if (country) {
    if (!isValidCountry(country)) throw new HttpError(400, 'invalid_country', 'country must be a two-letter code');
    where.push('country = ?');
    binds.push(country.toUpperCase());
  }
  const state = url.searchParams.get('state');
  if (state) {
    where.push('state = ?');
    binds.push(state.toUpperCase());
  }

  appendPageCursor(url, where, binds);

  const { rows, nextCursor } = await runPage(env, where, binds, deps.pageSize ?? LIST_LIMIT);
  const payload: CommunityListResponse = { routes: rows.map((row) => toSummary(env, row)), nextCursor };
  return json(payload, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ---------------------------------------------------------------------------
// GET /v1/community/routes/:id
// ---------------------------------------------------------------------------

export async function getCommunityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const row = await loadRoute(env, id);
  if (!row || row.status === 'removed') throw notFound();
  // A response to a request that carried a token is that caller's, even when
  // it holds only the public detail: never let a shared cache keep it.
  const personal = request.headers.has('Authorization');
  const user = await getUser(request, env, ctx);
  const isOwner = !!user && user.id === row.user_id;
  const isAdmin = !!user && user.is_admin === 1;
  const live = row.status === 'unverified' || row.status === 'verified';
  if (!live && !isOwner && !isAdmin) throw notFound();

  if (isAdmin) {
    const reports = await reportsFor(env, id);
    return json(toDetail(env, row, 'admin', isOwner, reports), 200, { 'Cache-Control': 'private, no-store' });
  }
  if (isOwner) {
    return json(toDetail(env, row, 'owner', true), 200, { 'Cache-Control': 'private, no-store' });
  }
  return json(toDetail(env, row, 'public', false), 200, {
    'Cache-Control': personal ? 'private, no-store' : 'public, max-age=60',
    Vary: 'Authorization',
  });
}

// ---------------------------------------------------------------------------
// PATCH /v1/community/routes/:id — owner edits the text
// ---------------------------------------------------------------------------

export async function patchCommunityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
  deps: PatchDeps = {}
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  assertNotBanned(user, 'edit routes');
  const row = await loadRoute(env, id);
  if (!row || row.status === 'removed' || row.user_id !== user.id) throw notFound();

  const body = await readSmallJson(request);
  const name =
    body.name === undefined
      ? row.name
      : cleanText(body.name, 'name', COMMUNITY_LIMITS.nameMin, COMMUNITY_LIMITS.nameMax, false);
  const description =
    body.description === undefined
      ? row.description
      : cleanText(
          body.description,
          'description',
          COMMUNITY_LIMITS.descriptionMin,
          COMMUNITY_LIMITS.descriptionMax,
          true
        );
  const credit = body.credit === undefined ? row.credit : cleanCredit(body.credit);
  const region =
    body.country === undefined && body.state === undefined
      ? { country: row.country, state: row.state }
      : cleanRegion(body.country ?? row.country, body.state === undefined ? row.state : body.state);

  const unchanged =
    name === row.name &&
    description === row.description &&
    credit === row.credit &&
    region.country === row.country &&
    region.state === row.state;
  if (unchanged) return json(toDetail(env, row, 'owner', true));

  // The text is checked as on submit: the same `metadata` check, refused with
  // the same 422 when it fails, and its entry in the stored checks replaced.
  let checks = metadataChecksAfterEdit(row, name, description);
  if (hasFailures(checks)) {
    return checksFailed(checks, 'The route did not pass the automatic checks');
  }

  // Each edit rewrites two R2 objects and re-runs the AI review.
  await consumeRateLimit(
    env,
    RATE_BUCKETS.communityEdit,
    user.id,
    Date.now(),
    `You can edit shared routes at most ${RATE_BUCKETS.communityEdit.limit} times a day`,
    ctx
  );

  const put = await republish(
    env,
    row,
    {
      name,
      description,
      credit,
      country: region.country,
      state: region.state,
      submittedBy: row.submitted_by_name,
    },
    isLive(row.status)
  );
  if (!put) throw new HttpError(500, 'trail_missing', 'The stored route could not be read');
  if (region.country !== row.country || region.state !== row.state) {
    checks = withCheck(checks, checkCommunityRegion(put.trail.track.points, region.country, region.state));
  }

  // The admin verified the old text: an edit sends it back to unverified.
  const status: CommunityRouteStatus = row.status === 'verified' ? 'unverified' : row.status;
  const review = initialReview(env);
  // Guarded by the row this edit was computed from: an admin's hide or a
  // delete that landed during the R2 writes must not be undone.
  const written = await env.DB.prepare(
    `UPDATE community_routes
        SET name = ?, description = ?, credit = ?, country = ?, state = ?, status = ?,
            verified_at = CASE WHEN ? = 'verified' THEN verified_at ELSE NULL END,
            verified_by = CASE WHEN ? = 'verified' THEN verified_by ELSE NULL END,
            md5 = ?, bytes = ?, r2_key = ?, private_key = ?, checks_json = ?,
            review_json = ?, review_status = ?, updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(
      name,
      description,
      credit,
      region.country,
      region.state,
      status,
      status,
      status,
      put.md5,
      put.bytes,
      put.publicKey,
      put.privateKey,
      JSON.stringify(checks),
      review.json,
      review.status,
      stampAfter(row.updated_at),
      id,
      row.status,
      row.updated_at
    )
    .run();
  if (written.meta.changes === 0) {
    await discardUnclaimed(env, id, [put.privateKey, put.publicKey]);
    throw conflict();
  }
  // The old private object is named by nothing now. The public version this
  // edit replaced stays for cached lists; any older one goes.
  ctx.waitUntil(deleteObjects(env, [row.private_key]));
  if (put.publicKey) {
    ctx.waitUntil(purgeSuperseded(env, id, [put.publicKey, row.r2_key], deps.purgeGraceMs));
  }

  if (review.run || deps.client) {
    ctx.waitUntil(reviewStoredRoute(env, id, { client: deps.client }));
  }
  const updated = await loadRoute(env, id);
  if (!updated) throw notFound();
  return json(toDetail(env, updated, 'owner', true));
}

// ---------------------------------------------------------------------------
// DELETE /v1/community/routes/:id — owner or admin
// ---------------------------------------------------------------------------

export async function deleteCommunityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const row = await loadRoute(env, id);
  const isAdmin = user.is_admin === 1;
  if (!row || (row.user_id !== user.id && !isAdmin)) throw notFound();
  if (row.status === 'removed') return noContent();

  // Unguarded: a delete wins over whatever else is in flight, and every
  // guarded write that loses to it drops its own objects.
  //
  // `blocks_resubmit` (decided in the statement, from the row as it is
  // then): an admin's removal of someone else's route keeps its track from
  // being shared again, and so does an owner's delete of a route an admin had
  // hidden — deleting and re-sharing is not a way out of a moderator's hide.
  // An owner's own delete otherwise leaves the track free to share again.
  const removedBy = row.user_id === user.id ? 'owner' : 'admin';
  const now = stampAfter(row.updated_at);
  await env.DB.prepare(
    `UPDATE community_routes
        SET blocks_resubmit = CASE
              WHEN ? = 'admin' THEN 1
              WHEN status = 'hidden' AND COALESCE(status_note, '') NOT IN (?, ?) THEN 1
              ELSE 0
            END,
            status = 'removed', removed_by = ?, removed_at = ?, updated_at = ?
      WHERE id = ? AND status != 'removed'`
  )
    .bind(removedBy, REVIEW_HIDE_NOTE, REPORTS_HIDE_NOTE, removedBy, now, now, id)
    .run();
  // Every public version (older ones are kept for cached lists until now) and
  // both private objects.
  ctx.waitUntil(purgeAll(env, id));
  return noContent();
}

// ---------------------------------------------------------------------------
// POST /v1/community/routes/:id/report
// ---------------------------------------------------------------------------

export async function reportCommunityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  assertNotBanned(user, 'report routes');
  const body = await readSmallJson(request);
  const reason = body.reason;
  if (typeof reason !== 'string' || !(COMMUNITY_REPORT_REASONS as readonly string[]).includes(reason)) {
    throw new HttpError(400, 'invalid_reason', `reason must be one of ${COMMUNITY_REPORT_REASONS.join(', ')}`);
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    note = cleanText(body.note, 'note', 0, MAX_REPORT_NOTE, true) || null;
  }

  const row = await loadRoute(env, id);
  if (!row || (row.status !== 'unverified' && row.status !== 'verified')) throw notFound();
  if (row.user_id === user.id) {
    throw new HttpError(400, 'own_route', 'You cannot report your own route');
  }

  const already = await env.DB.prepare(`SELECT id FROM community_route_reports WHERE route_id = ? AND user_id = ?`)
    .bind(id, user.id)
    .first<{ id: number }>();
  if (already) return json({ ok: true }, 200);

  const nowMs = Date.now();
  await consumeRateLimit(
    env,
    RATE_BUCKETS.communityReport,
    user.id,
    nowMs,
    `Report limit of ${RATE_BUCKETS.communityReport.limit} per day reached`,
    ctx
  );

  const now = new Date(nowMs).toISOString();
  const [inserted, hidden] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_route_reports (route_id, user_id, reason, note, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(route_id, user_id) DO NOTHING`
    ).bind(id, user.id, reason, note, now),
    // Enough distinct reporters take an unverified route down until an admin
    // looks. A verified one stays up — an admin has vouched for it — and
    // heads the admin queue with its report count instead. Only reports filed
    // since the last admin decision count: a route an admin restored is not
    // hidden again by the reports the admin already weighed. And only
    // reports from accounts that were a day old when they filed: registering
    // is free, so three fresh accounts must not be able to take a route down.
    env.DB.prepare(
      `UPDATE community_routes
          SET status = 'hidden', status_note = ?, updated_at = ?
        WHERE id = ? AND status = 'unverified'
          AND (SELECT COUNT(*) FROM community_route_reports r
                 JOIN users u ON u.id = r.user_id
                WHERE r.route_id = community_routes.id
                  AND r.created_at > community_routes.status_changed_at
                  AND (julianday(r.created_at) - julianday(u.created_at)) * 86400000.0 >= ?) >= ?`
    ).bind(REPORTS_HIDE_NOTE, stampAfter(row.updated_at), id, REPORTER_MIN_ACCOUNT_AGE_MS, COMMUNITY_REPORTS_TO_HIDE),
  ]);
  if (hidden.meta.changes > 0) await unpublish(env, id);
  return json({ ok: true }, inserted.meta.changes > 0 ? 201 : 200);
}

// ---------------------------------------------------------------------------
// GET /v1/me/community/routes
// ---------------------------------------------------------------------------

export async function listMyCommunityRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: ListDeps = {}
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const where = ['user_id = ?', `status != 'removed'`];
  const binds: unknown[] = [user.id];
  appendPageCursor(new URL(request.url), where, binds);
  const { rows, nextCursor } = await runPage(env, where, binds, deps.pageSize ?? LIST_LIMIT);
  const payload: CommunityAdminListResponse = {
    routes: rows.map((row) => toDetail(env, row, 'owner', true)),
    nextCursor,
  };
  return json(payload, 200, { 'Cache-Control': 'private, no-store' });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** GET /v1/admin/community/routes — the moderation queue. */
export async function adminListCommunityRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env, ctx);
  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE status != 'removed'
        ORDER BY CASE
                   WHEN status = 'hidden' AND review_status = 'done'
                        AND json_extract(review_json, '$.verdict') = 'reject' THEN 0
                   WHEN status = 'hidden' THEN 1
                   WHEN status = 'unverified' THEN 2
                   ELSE 3
                 END,
                 created_at DESC, id DESC
        LIMIT ${LIST_LIMIT}`
  ).all<CommunityRouteRow>();
  // The reports of the listed routes only: the newest few of each, with the
  // full count beside them (a route's own detail carries every report).
  const { results: reports } = rows.length
    ? await env.DB.prepare(
        `SELECT route_id, reason, note, created_at, n FROM (
           SELECT r.route_id, r.reason, r.note, r.created_at,
                  ROW_NUMBER() OVER (PARTITION BY r.route_id ORDER BY r.created_at DESC, r.id DESC) AS rn,
                  COUNT(*) OVER (PARTITION BY r.route_id) AS n
             FROM community_route_reports r
            WHERE r.route_id IN (SELECT value FROM json_each(?))
         )
         WHERE rn <= ${ADMIN_REPORTS_PER_ROUTE}
         ORDER BY route_id, rn`
      )
        .bind(JSON.stringify(rows.map((row) => row.id)))
        .all<ReportRow & { n: number }>()
    : { results: [] as (ReportRow & { n: number })[] };
  const byRoute = new Map<string, { list: ReportRow[]; count: number }>();
  for (const { n, ...r } of reports) {
    const entry = byRoute.get(r.route_id) ?? { list: [], count: n };
    entry.list.push(r);
    byRoute.set(r.route_id, entry);
  }
  const payload: CommunityAdminListResponse = {
    routes: rows.map((row) => {
      const entry = byRoute.get(row.id);
      return toDetail(env, row, 'admin', row.user_id === admin.id, entry?.list ?? [], entry?.count);
    }),
  };
  return json(payload, 200, { 'Cache-Control': 'private, no-store' });
}

/** POST /v1/admin/community/routes/:id/status */
export async function adminSetCommunityStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(request, env, ctx);
  const body = await readSmallJson(request);
  const status = body.status;
  if (status !== 'verified' && status !== 'unverified' && status !== 'hidden') {
    throw new HttpError(400, 'invalid_status', "status must be 'verified', 'unverified' or 'hidden'");
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    note = cleanText(body.note, 'note', 0, MAX_STATUS_NOTE, true) || null;
  }
  // Those two notes tell the owner an automatic hide did it.
  if (note === REVIEW_HIDE_NOTE || note === REPORTS_HIDE_NOTE) {
    throw new HttpError(400, 'invalid_note', 'That note is reserved for automatic hides');
  }
  const row = await loadRoute(env, id);
  if (!row || row.status === 'removed') throw notFound();

  const now = stampAfter(row.updated_at);
  const verified = status === 'verified';
  // Back on the public domain before the row says it is live; the copy comes
  // from the private one, which hiding left in place. A restore from hidden
  // always puts it (idempotent: the key is content-addressed), whatever
  // `r2_key` says — a hide's purge may still have been running when the row
  // was read.
  const publishing = status !== 'hidden' && (row.status === 'hidden' || !row.r2_key);
  let r2Key = status === 'hidden' ? null : row.r2_key;
  if (publishing) {
    r2Key = await publishFromPrivate(env, row.id, row.private_key);
    if (!r2Key) {
      // The private copy is gone. Usually that is because the route changed
      // since it was read — an owner's delete purged it, an edit replaced it
      // — and the admin should see that, not a server error.
      const current = await loadRoute(env, id);
      if (!current || current.status === 'removed') throw notFound();
      if (current.updated_at !== row.updated_at || current.private_key !== row.private_key) {
        throw conflict('The route changed while you were reviewing it; reload and try again');
      }
      throw new HttpError(500, 'trail_missing', 'The stored route could not be read');
    }
  }
  // Guarded by the row the admin's decision was made on: a delete, an
  // owner's edit or another hide in the meantime is a conflict, not
  // something to overwrite.
  const written = await env.DB.prepare(
    `UPDATE community_routes
        SET status = ?, status_note = ?, updated_at = ?, status_changed_at = ?,
            verified_at = ?, verified_by = ?, r2_key = ?
      WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(
      status,
      note,
      now,
      now,
      verified ? (row.status === 'verified' ? row.verified_at : now) : null,
      verified ? (row.status === 'verified' ? row.verified_by : admin.id) : null,
      r2Key,
      id,
      row.status,
      row.updated_at
    )
    .run();
  if (written.meta.changes === 0) {
    if (publishing) await discardUnclaimed(env, id, [r2Key]);
    throw conflict('The route changed while you were reviewing it; reload and try again');
  }
  if (status === 'hidden') await unpublish(env, id);
  const updated = await loadRoute(env, id);
  if (!updated) throw notFound();
  return json(toDetail(env, updated, 'admin', updated.user_id === admin.id, await reportsFor(env, id)));
}

/** POST /v1/admin/community/routes/:id/review — re-run the AI review now. */
export async function adminRerunCommunityReview(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
  deps: ReviewDeps = {}
): Promise<Response> {
  const admin = await requireAdmin(request, env, ctx);
  const row = await loadRoute(env, id);
  if (!row || row.status === 'removed') throw notFound();
  await reviewStoredRoute(env, id, { client: deps.client });
  const updated = await loadRoute(env, id);
  if (!updated) throw notFound();
  return json(toDetail(env, updated, 'admin', updated.user_id === admin.id, await reportsFor(env, id)));
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

/**
 * The statement `DELETE /v1/me` batches: a deleted account's routes stay up
 * (they were released as CC0) but lose the submitter's name. The same
 * statement marks every route not yet removed `deattribute_pending`, so the
 * rewrite of its stored JSON is retried (`retryPendingDeattributions`) until
 * it has happened.
 */
export function deattributeStatement(env: Env, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE community_routes
        SET submitted_by_name = NULL,
            deattribute_pending = CASE WHEN status != 'removed' THEN 1 ELSE deattribute_pending END
      WHERE user_id = ?`
  ).bind(userId);
}

/**
 * After the row update: rewrite each route's stored JSON (the private copy,
 * and a new public one while it is live) so its attribution line no longer
 * names the account. Unlike an owner's edit, the older public versions are
 * purged straight away: they name the account, and a list cached for a few
 * minutes 404ing on them is the lesser harm. Run off the response path; a
 * route left `deattribute_pending` (the worker was stopped, the route kept
 * changing, R2 failed) is picked up again by the scheduled handler.
 */
export async function deattributeStoredRoutes(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE user_id = ? AND deattribute_pending = 1 AND status != 'removed'`
  )
    .bind(userId)
    .all<CommunityRouteRow>();
  await deattributeRows(env, results, DEATTRIBUTE_SWEEP_GRACE_MS);
}

/** How old an orphaned private object must be before a de-attribution sweeps it. */
export const DEATTRIBUTE_SWEEP_GRACE_MS = 2 * 60 * 1000;

async function deattributeRows(env: Env, results: CommunityRouteRow[], graceMs: number): Promise<void> {
  for (const row of results) {
    try {
      await deattributeRoute(env, row, graceMs);
    } catch (err) {
      console.error(`De-attributing ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * One route's rewrite, guarded like an owner's edit. A route that changed
 * under it (an admin hid or restored it, a review hid it) is read again and
 * rewritten from its new state, a few times at most: the name must not
 * survive in the JSON, and the change that won must not be undone.
 */
async function deattributeRoute(env: Env, first: CommunityRouteRow, graceMs: number): Promise<void> {
  let row: CommunityRouteRow | null = first;
  for (let attempt = 0; attempt < DEATTRIBUTE_ATTEMPTS; attempt++) {
    if (!row || row.deattribute_pending !== 1) return;
    if (row.status === 'removed') {
      // Its objects are purged by the delete; nothing names the account.
      await env.DB.prepare(`UPDATE community_routes SET deattribute_pending = 0 WHERE id = ? AND status = 'removed'`)
        .bind(row.id)
        .run();
      return;
    }
    const put: StoredTrail | null = await republish(
      env,
      row,
      {
        name: row.name,
        description: row.description,
        credit: row.credit,
        country: row.country,
        state: row.state,
        submittedBy: null,
      },
      isLive(row.status)
    );
    if (!put) {
      // Nothing to rewrite from, now or on a retry: say so and stop retrying.
      // The uploaded GPX still goes: it may name the account. A failed delete
      // throws, so the route stays pending and is retried.
      console.error(`De-attributing ${row.id} failed: its private copy is missing`);
      if (row.gpx_key) await env.PHOTOS.delete(row.gpx_key);
      await env.DB.prepare(
        `UPDATE community_routes SET deattribute_pending = 0, gpx_key = NULL WHERE id = ? AND updated_at = ?`
      )
        .bind(row.id, row.updated_at)
        .run();
      return;
    }
    const written = await env.DB.prepare(
      `UPDATE community_routes
          SET md5 = ?, bytes = ?, r2_key = ?, private_key = ?, gpx_key = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND updated_at = ?`
    )
      .bind(
        put.md5,
        put.bytes,
        put.publicKey,
        put.privateKey,
        stampAfter(row.updated_at),
        row.id,
        row.status,
        row.updated_at
      )
      .run();
    if (written.meta.changes > 0) {
      // Every older copy names the account: drop the old private one, the
      // uploaded GPX (a device's file can carry a name, a device and
      // timestamps), any private JSON an earlier, interrupted attempt left
      // behind, and all public versions but the new one. Only then is the route done; if a
      // delete throws, it stays pending and the next retry rewrites it again
      // (the same bytes, so the same public key) and purges again. The sweep
      // spares objects younger than `graceMs`: a concurrent attempt (the
      // cron beside the account deletion's own run) may be writing one.
      await env.PHOTOS.delete(row.gpx_key ? [row.private_key, row.gpx_key] : row.private_key);
      await purgePrivateOrThrow(env, row.id, [put.privateKey], new Date(Date.now() - graceMs));
      await purgePublicOrThrow(env, row.id, put.publicKey);
      // Guarded by the private copy written here: whatever changed the row
      // since, the copy it names is this de-attributed one.
      await env.DB.prepare(`UPDATE community_routes SET deattribute_pending = 0 WHERE id = ? AND private_key = ?`)
        .bind(row.id, put.privateKey)
        .run();
      return;
    }
    await discardUnclaimed(env, row.id, [put.privateKey, put.publicKey]);
    row = await loadRoute(env, row.id);
  }
  console.error(`De-attributing ${first.id} gave up for now: the route kept changing`);
}

// ---------------------------------------------------------------------------
// Scheduled maintenance (the Cron Trigger in wrangler.toml)
// ---------------------------------------------------------------------------

/** De-attributions retried per scheduled run. */
export const DEATTRIBUTE_BATCH = 20;
/** Stale reviews re-run per scheduled run: each may wait on the model for up to 20 s. */
export const STALE_REVIEW_BATCH = 5;
/** A review still `pending` this long after the row last changed was lost. */
export const STALE_REVIEW_AFTER_MS = 10 * 60 * 1000;

/**
 * Routes whose de-attribution `DELETE /v1/me` scheduled but did not finish,
 * oldest change first, at most `limit` of them.
 */
export async function retryPendingDeattributions(
  env: Env,
  limit = DEATTRIBUTE_BATCH,
  graceMs = DEATTRIBUTE_SWEEP_GRACE_MS
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE deattribute_pending = 1
      ORDER BY updated_at ASC, id ASC LIMIT ?`
  )
    .bind(limit)
    .all<CommunityRouteRow>();
  await deattributeRows(env, results, graceMs);
}

/**
 * Re-run reviews left `pending`: a review that loses its guard (the row
 * changed while the model was thinking) writes nothing, and one whose
 * `waitUntil` was cut short never wrote at all. `reviewStoredRoute` keeps its
 * guards, so a route that changes again meanwhile is simply left for the next
 * run. Without an API key nothing is sent: `runAiReview` records `skipped`,
 * as a submission without a key does.
 */
export async function rerunStaleReviews(
  env: Env,
  deps: Pick<ReviewDeps, 'client'> = {},
  limit = STALE_REVIEW_BATCH,
  nowMs = Date.now()
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM community_routes
      WHERE review_status = 'pending' AND status != 'removed' AND updated_at < ?
      ORDER BY updated_at ASC, id ASC LIMIT ?`
  )
    .bind(new Date(nowMs - STALE_REVIEW_AFTER_MS).toISOString(), limit)
    .all<{ id: string }>();
  for (const { id } of results) {
    await reviewStoredRoute(env, id, { client: deps.client });
  }
}

// ---------------------------------------------------------------------------
// OSM POI enrichment (scheduled; `community-pois.ts` does the Overpass part)
// ---------------------------------------------------------------------------

/**
 * Per scheduled run. Workers Free caps an invocation's external subrequests
 * (50), and the stale-review re-run before this may spend 10 on the model;
 * the wall time spent waiting on Overpass is not CPU, but the run must end
 * well inside the Cron Trigger's limit. CPU is the other limit: see
 * `docs/architecture/workers.md` ("community route POIs") before turning this
 * on for a Worker on the Free plan.
 */
export const POI_RUN_LIMITS = {
  /** Overpass requests per run, across every route and endpoint (≥ `POI_LIMITS.maxQueriesPerRoute`). */
  queries: 20,
  /** Routes looked at per run. */
  routes: 3,
  /**
   * Every Overpass request of the run must be able to finish within this
   * much of the run, ms. At least `maxQueriesPerRoute × WORST_REQUEST_MS`, so a
   * route of the longest kind fits a fresh run however slow each answer is.
   */
  wallMs: 6 * 60 * 1000,
  /**
   * Attempts per geometry that failed for a reason tied to the route itself
   * (Overpass refusing its query, its stored copy missing, the platform
   * stopping the run while on it) before it is left without POIs (`failed`).
   * An outage never counts: see `PoiFailure`.
   */
  maxAttempts: 4,
  /**
   * A route is tried again no sooner than this after an attempt starts, ms;
   * after consecutive failures of any kind, this doubled each time
   * (`poiBackoffMs`), up to `maxBackoffMs`.
   */
  retryAfterMs: 60 * 60 * 1000,
  /** The longest wait between two attempts after failures, ms. */
  maxBackoffMs: 2 * 24 * 60 * 60 * 1000,
  /**
   * A `failed` route becomes due again this long after it was given up on,
   * with its attempts reset, so it never needs a hand-run fix to recover.
   */
  failedRetryAfterMs: 14 * 24 * 60 * 60 * 1000,
  /**
   * A route changed less than this long ago waits: the AI review a submit or
   * an edit starts from `waitUntil` is then long finished (a review still
   * `pending` waits too), and this run's write (which moves `updated_at`)
   * cannot make it lose its guard.
   */
  settleMs: 2 * 60 * 1000,
} as const;

/** Test seams for the POI enrichment. */
export interface PoiEnrichDeps extends Partial<OverpassDeps> {
  nowMs?: number;
  /** `purgeSuperseded`'s grace for fresh uploads, and the private sweep's. */
  purgeGraceMs?: number;
}

/**
 * The run's candidates: live routes due for POIs (`pois_due_at` set and
 * passed: '' for a route never tried, the claim's retry time after an attempt;
 * NULL once answered or given up), settled, and with no AI review pending.
 * Longest-waiting first, so a route a run had to pass over is first in the
 * next. Served by `idx_community_routes_pois_due` (0009), range and order
 * both; the unary `+` keeps the planner off the status index, which would
 * read every live route and sort them.
 */
export const POI_CANDIDATES_SQL = `SELECT * FROM community_routes
      WHERE pois_due_at IS NOT NULL AND pois_due_at <= ?
        AND +status IN ('unverified', 'verified')
        AND review_status != 'pending'
        AND updated_at < ?
      ORDER BY pois_due_at ASC, created_at ASC, id ASC
      LIMIT ?`;

async function poiCandidates(env: Env, nowMs: number, limit: number): Promise<CommunityRouteRow[]> {
  const { results } = await env.DB.prepare(POI_CANDIDATES_SQL)
    .bind(new Date(nowMs).toISOString(), new Date(nowMs - POI_RUN_LIMITS.settleMs).toISOString(), limit)
    .all<CommunityRouteRow>();
  return results;
}

/** D1's answer to a query naming a column migration 0009 adds, when it has not been applied. */
function isMissingPoiMigration(err: unknown): boolean {
  return /no such column:?\s*"?pois?_/i.test(err instanceof Error ? err.message : String(err));
}

type PoiMiss = { kind: 'skip'; reason: string } | { kind: 'fail'; reason: string; failure: PoiFailure };

/** The wait before the next attempt after `failures` consecutive failed ones: 1 h, 2 h, 4 h, … up to 2 days. */
export function poiBackoffMs(failures: number): number {
  return Math.min(
    POI_RUN_LIMITS.retryAfterMs * 2 ** Math.min(Math.max(failures - 1, 0), 30),
    POI_RUN_LIMITS.maxBackoffMs
  );
}

/**
 * Record an attempt that ended without POIs. Guarded by the claim's stamp: a
 * change that reset the bookkeeping meanwhile wins.
 * - `skip`: final for this geometry.
 * - `fail`, `failure: 'none'`: the attempt is given back and the route goes
 *   back where it was in the queue (the due time the claim replaced).
 * - `fail`, `'transient'` (Overpass down or busy): the attempt is given back
 *   too, but the route backs off (`poiBackoffMs`), so an outage costs a few
 *   requests a day per route and never uses up its attempts.
 * - `fail`, `'route'`: counts. It backs off the same way, and the last allowed
 *   one marks the route `failed`, due again after `failedRetryAfterMs` with
 *   its attempts reset.
 */
async function recordPoiMiss(env: Env, row: CommunityRouteRow, claimedAt: string, miss: PoiMiss): Promise<void> {
  const reason = miss.reason.slice(0, 500);
  const claimMs = Date.parse(claimedAt);
  if (miss.kind === 'skip') {
    await env.DB.prepare(
      `UPDATE community_routes
          SET pois_status = 'skipped', pois_hash = content_hash, pois_due_at = NULL, pois_error = ?
        WHERE id = ? AND pois_attempted_at = ?`
    )
      .bind(reason, row.id, claimedAt)
      .run();
    return;
  }
  if (miss.failure === 'none') {
    await env.DB.prepare(
      `UPDATE community_routes SET pois_attempts = MAX(pois_attempts - 1, 0), pois_due_at = ?, pois_error = ?
        WHERE id = ? AND pois_attempted_at = ?`
    )
      .bind(row.pois_due_at ?? '', reason, row.id, claimedAt)
      .run();
    return;
  }
  const failures = row.pois_failures + 1;
  if (miss.failure === 'route' && row.pois_attempts + 1 >= POI_RUN_LIMITS.maxAttempts) {
    await env.DB.prepare(
      `UPDATE community_routes
          SET pois_status = 'failed', pois_hash = content_hash, pois_attempts = 0, pois_failures = 0,
              pois_due_at = ?, pois_error = ?
        WHERE id = ? AND pois_attempted_at = ?`
    )
      .bind(new Date(claimMs + POI_RUN_LIMITS.failedRetryAfterMs).toISOString(), reason, row.id, claimedAt)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE community_routes
        SET pois_attempts = MAX(pois_attempts - ?, 0), pois_failures = ?, pois_due_at = ?, pois_error = ?
      WHERE id = ? AND pois_attempted_at = ?`
  )
    .bind(
      miss.failure === 'route' ? 0 : 1,
      failures,
      new Date(claimMs + poiBackoffMs(failures)).toISOString(),
      reason,
      row.id,
      claimedAt
    )
    .run();
}

/**
 * A route removed while an attempt was on it: removal purged its private
 * prefix, but an answer this attempt cached afterwards would outlive it.
 * Purge the prefix again, whole. Never throws.
 */
async function purgeIfRemoved(env: Env, id: string): Promise<void> {
  try {
    const current = await loadRoute(env, id);
    if (current && current.status !== 'removed') return;
    await purgePrivateOrThrow(env, id, [], new Date(Date.now() + 60_000));
  } catch (err) {
    console.error(`Purging POI leftovers of removed ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Once a route is answered or given up on: delete whatever under its private
 * prefix the row does not name — the cached Overpass answers, and any trail
 * JSON a run stopped between its R2 write and its D1 write left behind. Spares
 * anything younger than `graceMs` (an edit's object, written before its row
 * names it) except `answerKeys`, the answers this run cached. Never throws.
 */
async function sweepPoiLeftovers(env: Env, id: string, graceMs: number, answerKeys: string[] = []): Promise<void> {
  // This run's own cached answers are younger than the grace: named outright.
  await deleteObjects(env, answerKeys);
  try {
    const current = await loadRoute(env, id);
    if (!current || current.status === 'removed') {
      await purgeIfRemoved(env, id);
      return;
    }
    await purgePrivateOrThrow(env, id, [current.private_key, current.gpx_key], new Date(Date.now() - graceMs));
  } catch (err) {
    console.error(`Sweeping POI leftovers of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function storedMetaOf(row: CommunityRouteRow): StoredMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    credit: row.credit,
    country: row.country,
    state: row.state,
    submittedBy: row.submitted_by_name,
  };
}

/** Enrich one route, within the run's budget. */
async function enrichRoutePois(
  env: Env,
  row: CommunityRouteRow,
  budget: OverpassBudget,
  deps: PoiEnrichDeps & OverpassDeps
): Promise<void> {
  const now = deps.now ?? Date.now;
  const graceMs = deps.purgeGraceMs ?? SUPERSEDED_PURGE_GRACE_MS;
  if (row.pois_attempts >= POI_RUN_LIMITS.maxAttempts) {
    // The last attempts ended without recording an answer (the run was
    // stopped mid-way): stop trying this geometry.
    const gaveUp = await env.DB.prepare(
      `UPDATE community_routes
          SET pois_status = 'failed', pois_hash = content_hash, pois_attempts = 0, pois_failures = 0,
              pois_due_at = ?, pois_error = 'gave_up'
        WHERE id = ? AND pois_attempted_at IS ? AND pois_due_at IS ?`
    )
      .bind(
        new Date(Date.now() + POI_RUN_LIMITS.failedRetryAfterMs).toISOString(),
        row.id,
        row.pois_attempted_at,
        row.pois_due_at
      )
      .run();
    if (gaveUp.meta.changes > 0) await sweepPoiLeftovers(env, row.id, graceMs);
    return;
  }

  // Claim before any work: a run the platform stops (out of CPU or time)
  // after this still counts as an attempt, so a route that always kills the
  // run is given up on rather than retried for ever. The claim also sets the
  // retry time, which a run that finishes clears or keeps.
  const claimedAt = stampAfter(row.pois_attempted_at ?? '');
  const claim = await env.DB.prepare(
    `UPDATE community_routes
        SET pois_attempts = pois_attempts + 1, pois_status = 'pending', pois_attempted_at = ?, pois_due_at = ?
      WHERE id = ? AND updated_at = ? AND pois_attempted_at IS ? AND pois_due_at IS ?`
  )
    .bind(
      claimedAt,
      new Date(Date.parse(claimedAt) + POI_RUN_LIMITS.retryAfterMs).toISOString(),
      row.id,
      row.updated_at,
      row.pois_attempted_at,
      row.pois_due_at
    )
    .run();
  if (claim.meta.changes === 0) return;
  const miss = (outcome: PoiMiss) => recordPoiMiss(env, row, claimedAt, outcome);
  let answerKeys: string[] = [];
  const finished = async (outcome: PoiMiss) => {
    await miss(outcome);
    await sweepPoiLeftovers(env, row.id, graceMs, answerKeys);
  };

  const trail = await readStoredTrail(env, row.private_key);
  if (!trail) return miss({ kind: 'fail', reason: 'trail_missing', failure: 'route' });
  const plan = planPoiQueries(trail);
  if (plan.queries.length > POI_LIMITS.maxQueriesPerRoute) {
    return finished({ kind: 'skip', reason: 'route_too_long' });
  }

  // Salted with what stays put while the geometry does: an edit or a
  // de-attribution rewrites the private copy, not the answers it needs.
  const hashes = await Promise.all(plan.queries.map((q) => queryHash(`${row.id}\n${row.content_hash}`, q)));
  answerKeys = hashes.map((hash) => poiAnswerKey(row.id, hash));
  const cache: PoiAnswerCache = {
    async get(hash) {
      const object = await env.PHOTOS.get(poiAnswerKey(row.id, hash));
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async put(hash, body) {
      // Nothing more is written for a route removed meanwhile: its removal
      // purged the private prefix, and must stay purged.
      const current = await loadRoute(env, row.id);
      if (!current || current.status === 'removed') return false;
      await env.PHOTOS.put(poiAnswerKey(row.id, hash), body, { httpMetadata: { contentType: 'application/json' } });
      return true;
    },
  };
  // Only a route whose missing answers all fit what the run has left is
  // started; otherwise it gives the attempt back, untouched, for a run with
  // room for it.
  let needed = 0;
  for (const hash of hashes) {
    if (!(await env.PHOTOS.head(poiAnswerKey(row.id, hash)))) needed++;
  }
  if (needed > budget.queriesLeft || now() + needed * WORST_REQUEST_MS > budget.deadline) {
    return miss({ kind: 'fail', reason: 'run_budget', failure: 'none' });
  }

  const outcome = await fetchRoutePois(trail, plan, hashes, cache, budget, deps);
  if (outcome.kind === 'skip') {
    console.error(`POIs for ${row.id}: skipped (${outcome.reason})`);
    return finished(outcome);
  }
  if (outcome.kind === 'fail') {
    console.error(`POIs for ${row.id}: ${outcome.failure === 'none' ? 'deferred' : 'failed'} (${outcome.reason})`);
    await miss(outcome);
    if (outcome.reason === 'route_removed') {
      await purgeIfRemoved(env, row.id);
    } else if (outcome.failure === 'route' && row.pois_attempts + 1 >= POI_RUN_LIMITS.maxAttempts) {
      await sweepPoiLeftovers(env, row.id, graceMs, answerKeys);
    }
    return;
  }

  const changed = JSON.stringify(outcome.pois) !== JSON.stringify(trail.pois ?? []);
  let put: StoredTrail | null = null;
  if (changed) {
    try {
      const { pois: _old, ...rest } = trail;
      // Rebuilt as an edit rebuilds it: the same config, with the
      // OpenStreetMap credit the POIs now need (`communityDataSource`).
      const next = withServerConfig({ ...rest, pois: outcome.pois }, storedMetaOf(row));
      put = await putTrail(env, row.id, await encodeTrail(next), isLive(row.status));
    } catch (err) {
      if (err instanceof HttpError && err.code === 'trail_too_large') {
        return finished({ kind: 'skip', reason: 'trail_too_large' });
      }
      throw err;
    }
  }

  // Guarded like an owner's edit: whatever changed the row since it was read
  // (an edit, a hide, a de-attribution) wins, and this run's objects go. The
  // new JSON is a new version, so `updated_at` moves and clients that list
  // the route see its md5 change. (`status_changed_at`, which the report
  // count runs from, and the review are untouched.)
  const written = await env.DB.prepare(
    `UPDATE community_routes
        SET pois_status = 'done', pois_hash = content_hash, poi_count = ?, pois_error = NULL, pois_due_at = NULL,
            pois_failures = 0,
            md5 = ?, bytes = ?, r2_key = ?, private_key = ?, updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ? AND pois_attempted_at = ?`
  )
    .bind(
      outcome.pois.length,
      put ? put.md5 : row.md5,
      put ? put.bytes : row.bytes,
      put ? put.publicKey : row.r2_key,
      put ? put.privateKey : row.private_key,
      put ? stampAfter(row.updated_at) : row.updated_at,
      row.id,
      row.status,
      row.updated_at,
      claimedAt
    )
    .run();
  if (written.meta.changes === 0) {
    if (put) await discardUnclaimed(env, row.id, [put.privateKey, put.publicKey]);
    // Not Overpass's doing: the attempt is given back, and the answers stay
    // cached for the next one (their keys survive an edit or a
    // de-attribution) — unless the change was a removal, whose purge they
    // may have missed.
    await miss({ kind: 'fail', reason: 'route_changed', failure: 'none' });
    await purgeIfRemoved(env, row.id);
    return;
  }
  if (put) {
    await deleteObjects(env, [row.private_key]);
    if (put.publicKey) await purgeSuperseded(env, row.id, [put.publicKey, row.r2_key], deps.purgeGraceMs);
  }
  await sweepPoiLeftovers(env, row.id, graceMs, answerKeys);
}

/**
 * The scheduled POI enrichment: up to `POI_RUN_LIMITS.routes` live routes due
 * for POIs, longest-waiting first, within one Overpass budget for the run.
 * Off when `OVERPASS_ENDPOINTS` is empty (the default). Never on a request's
 * path: a submit stores the route without POIs and this adds them within a
 * run or two. Before migration 0009 is applied it logs and does nothing.
 */
export async function enrichCommunityRoutePois(env: Env, deps: PoiEnrichDeps = {}): Promise<void> {
  const endpoints = deps.endpoints ?? parseOverpassEndpoints(env.OVERPASS_ENDPOINTS);
  if (endpoints.length === 0) return;
  const nowMs = deps.nowMs ?? Date.now();
  const now = deps.now ?? Date.now;
  const budget = newOverpassBudget(endpoints.length, POI_RUN_LIMITS.queries, now() + POI_RUN_LIMITS.wallMs);
  let rows: CommunityRouteRow[];
  try {
    rows = await poiCandidates(env, nowMs, POI_RUN_LIMITS.routes);
  } catch (err) {
    if (isMissingPoiMigration(err)) {
      console.error('POI enrichment skipped: migration 0009 (community route POIs) is not applied');
      return;
    }
    throw err;
  }
  for (const row of rows) {
    if (budget.queriesLeft <= 0 || now() + WORST_REQUEST_MS > budget.deadline) return;
    try {
      await enrichRoutePois(env, row, budget, { ...deps, endpoints });
    } catch (err) {
      console.error(`POI enrichment of ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Everything the scheduled handler does. Never throws. */
export async function runCommunityMaintenance(
  env: Env,
  deps: Pick<ReviewDeps, 'client'> & { pois?: PoiEnrichDeps } = {}
): Promise<void> {
  // In this order: a stale review re-run finishes before the POI run reads
  // the same route, so the two never race on its `updated_at`.
  for (const [what, task] of [
    ['de-attribution retry', () => retryPendingDeattributions(env)],
    ['stale review re-run', () => rerunStaleReviews(env, deps)],
    ['POI enrichment', () => enrichCommunityRoutePois(env, deps.pois)],
  ] as const) {
    try {
      await task();
    } catch (err) {
      console.error(`Community ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
