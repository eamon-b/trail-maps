/**
 * Community routes: hikers' own GPX imports, shared with everyone.
 * Spec: `plans/community-routes.md`; wire types: `src/lib/community-types.ts`.
 *
 * A submission carries the client's processed trail. The worker trusts none of
 * it: `runCommunityChecks` rebuilds the trail from scratch and re-runs every
 * automatic check, the stats in the row come from that rebuilt copy, and the
 * stored JSON's `config` is rewritten here (id, name, source, region,
 * description, attribution). A passing route is public at once as
 * `unverified`; the AI review (`community-review.ts`) runs afterwards from
 * `ctx.waitUntil` and fails open.
 *
 * Storage: a D1 row per route (migration 0005) and, in the PHOTOS bucket:
 *
 * - the canonical trail JSON at `community/private/<id>/<32 random hex>.json`
 *   (`private_key`), written on submit and on every republish;
 * - while the route is live (`unverified`/`verified`), a public copy of the
 *   same bytes at a content-addressed key, `community/v1/<id>.<md5[0..12]>.json`
 *   (`r2_key`, NULL while there is none). A republish (owner edit,
 *   de-attribution) writes a new public key and never deletes the old one:
 *   lists cached for 60 s at the edge and for up to 30 min on phones still
 *   name it. Hiding a route deletes every public object under
 *   `community/v1/<id>.`; restoring it republishes from the private copy;
 *   removing it purges both prefixes;
 * - the optional raw GPX at `community/private/<id>/<32 random hex>.gpx`
 *   (`gpx_key`), kept for re-processing and never returned in any response.
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
import { reviewHides, runAiReview } from './community-review';
import type { ReviewClient } from './community-review';
import { runCommunityChecks } from '../../../src/lib/community-checks';
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
import type { ProcessedTrail } from '../../../src/lib/trail-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIL_PREFIX = 'community/v1/';
/** Under `<id>/`: the canonical JSON and the raw GPX, at random keys (see the header). */
const PRIVATE_PREFIX = 'community/private/';
/**
 * Content-addressed, so a key never changes meaning, but short-lived at the
 * edge: hiding a route deletes its public objects, and an edge copy must not
 * outlive that by more than a few minutes. Clients verify the md5 and keep
 * their own copy, so a short max-age costs little.
 */
const PUBLIC_TRAIL_CACHE = 'public, max-age=300';

/** Whole request: the trail JSON, the GPX as base64 (4/3 of its size), and the text fields. */
const MAX_BODY_BYTES =
  COMMUNITY_LIMITS.trailJsonMaxBytes + Math.ceil((COMMUNITY_LIMITS.gpxMaxBytes * 4) / 3) + 64 * 1024;

const MAX_REPORT_NOTE = 500;
const MAX_STATUS_NOTE = 500;
const REPORTS_PER_DAY = 20;
const LIST_LIMIT = 1000;

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

function toDetail(
  env: Env,
  row: CommunityRouteRow,
  viewer: Viewer,
  isOwner: boolean,
  reports: ReportRow[] = []
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
  }
  if (viewer === 'admin') {
    detail.reportCount = reports.length;
    detail.reports = reports.map((r) => ({ reason: r.reason, note: r.note, createdAt: r.created_at }));
    detail.statusNote = row.status_note;
  }
  return detail;
}

async function loadRoute(env: Env, id: string): Promise<CommunityRouteRow | null> {
  if (!isCommunityRouteId(id)) return null;
  return env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`)
    .bind(id)
    .first<CommunityRouteRow>();
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

function cleanText(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  allowLineBreaks: boolean
): string {
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
async function readCappedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
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
  return readCappedJson(request, 64 * 1024);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** How much of the decoded GPX is looked at for `<` / `<gpx`. */
const GPX_SNIFF_BYTES = 1024;

/** Decode and sanity-check the optional raw GPX. */
function decodeGpx(raw: unknown): Uint8Array | null {
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
  const head = binary.slice(0, GPX_SNIFF_BYTES).replace(/^\xEF\xBB\xBF/, '').trimStart();
  if (head.charAt(0) !== '<' || !head.includes('<gpx')) {
    throw new HttpError(400, 'invalid_gpx', 'gpxBase64 does not look like a GPX file');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Hashes, ids, storage
// ---------------------------------------------------------------------------

function hex(buffer: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** md5 hex; Workers' `crypto.subtle` supports MD5 as a non-standard extension. */
async function md5Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('MD5', bytes));
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

function dataSourceText(submittedBy: string | null, credit: string | null): string {
  return `Shared by ${submittedBy ?? ANONYMOUS_SUBMITTER} under CC0.${credit ? ` ${credit}` : ''}`;
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
      dataSource: { text: dataSourceText(meta.submittedBy, meta.credit) },
    },
  };
}

/** 32 hex chars of randomness: the unguessable part of a private key. */
function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

function privateKey(id: string, ext: 'json' | 'gpx'): string {
  return `${PRIVATE_PREFIX}${id}/${randomHex()}.${ext}`;
}

function publicKey(id: string, md5: string): string {
  return `${TRAIL_PREFIX}${id}.${md5.slice(0, 12)}.json`;
}

function isLive(status: CommunityRouteStatus): boolean {
  return status === 'unverified' || status === 'verified';
}

interface StoredTrail {
  /** The public copy, or null when none was written (the route is not live). */
  publicKey: string | null;
  privateKey: string;
  md5: string;
  bytes: number;
}

async function putPublic(env: Env, key: string, body: Uint8Array): Promise<void> {
  await env.PHOTOS.put(key, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: PUBLIC_TRAIL_CACHE },
  });
}

/**
 * Write a trail's canonical private copy and, when `publish`, its public copy
 * (the same bytes). Nothing is deleted here.
 */
async function storeTrail(env: Env, id: string, trail: ProcessedTrail, publish: boolean): Promise<StoredTrail> {
  const body = new TextEncoder().encode(JSON.stringify(trail));
  if (body.byteLength > COMMUNITY_LIMITS.trailJsonMaxBytes) {
    throw new HttpError(
      413,
      'trail_too_large',
      `The processed route must be at most ${COMMUNITY_LIMITS.trailJsonMaxBytes} bytes`
    );
  }
  const md5 = await md5Hex(body);
  const priv = privateKey(id, 'json');
  await env.PHOTOS.put(priv, body, { httpMetadata: { contentType: 'application/json' } });
  let pub: string | null = null;
  if (publish) {
    pub = publicKey(id, md5);
    await putPublic(env, pub, body);
  }
  return { publicKey: pub, privateKey: priv, md5, bytes: body.byteLength };
}

async function readStoredTrail(env: Env, key: string): Promise<ProcessedTrail | null> {
  const object = await env.PHOTOS.get(key);
  if (!object) return null;
  try {
    return (await object.json()) as ProcessedTrail;
  } catch {
    return null;
  }
}

function deleteObjects(env: Env, keys: (string | null)[]): Promise<void> {
  const live = keys.filter((k): k is string => !!k);
  if (live.length === 0) return Promise.resolve();
  return env.PHOTOS.delete(live).catch(() => {
    /* best-effort: an orphaned object costs storage, never correctness */
  });
}

/**
 * Delete every object under `prefix` except `keep` (paged; R2 deletes up to
 * 1,000 keys a call).
 */
async function purgePrefix(env: Env, prefix: string, keep?: string | null): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const listed = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((o) => o.key).filter((k) => k !== keep);
    if (keys.length > 0) await env.PHOTOS.delete(keys);
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

/**
 * Every public version of a route: the current one and any older ones a
 * republish left for cached lists. The trailing `.` keeps `c_abc` from
 * matching `c_abcd…`.
 */
function purgePublic(env: Env, id: string, keep?: string | null): Promise<void> {
  return purgePrefix(env, `${TRAIL_PREFIX}${id}.`, keep).catch((err) => {
    console.error(`Purging public copies of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function purgeAll(env: Env, id: string): Promise<void> {
  return Promise.all([
    purgePublic(env, id),
    purgePrefix(env, `${PRIVATE_PREFIX}${id}/`).catch((err) => {
      console.error(`Purging private copies of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }),
  ]).then(() => undefined);
}

/**
 * Take a hidden route's public copies down and clear `r2_key`. Run after the
 * status change, from whichever path hid it (admin, AI review, reports). The
 * `status = 'hidden'` guard keeps a restore that raced ahead from losing its
 * fresh key.
 */
async function unpublish(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE community_routes SET r2_key = NULL WHERE id = ? AND status = 'hidden'`)
    .bind(id)
    .run();
  await purgePublic(env, id);
}

/**
 * Put a route that is becoming live again back on the public domain, from its
 * private copy. Returns the public key, or null when the private copy is gone.
 */
async function publishFromPrivate(env: Env, row: CommunityRouteRow): Promise<string | null> {
  const object = await env.PHOTOS.get(row.private_key);
  if (!object) return null;
  const body = new Uint8Array(await object.arrayBuffer());
  const key = publicKey(row.id, await md5Hex(body));
  await putPublic(env, key, body);
  return key;
}

/**
 * Re-store a route's JSON with a fresh config (after an edit or a
 * de-attribution), from its private copy: a new private object, and a new
 * public one while the route is live. The old public object is left alone
 * (cached lists still name it; it is purged when the route is hidden or
 * removed); the old private one is the caller's to drop once the row no longer
 * names it. Returns null when the stored copy is missing.
 */
async function republish(
  env: Env,
  row: CommunityRouteRow,
  meta: Omit<StoredMeta, 'id'>,
  publish: boolean
): Promise<StoredTrail | null> {
  const trail = await readStoredTrail(env, row.private_key);
  if (!trail) return null;
  return storeTrail(env, row.id, withServerConfig(trail, { ...meta, id: row.id }), publish);
}

// ---------------------------------------------------------------------------
// AI review (stored)
// ---------------------------------------------------------------------------

export interface ReviewDeps {
  client?: ReviewClient;
  /** The trail, when the caller already has it (saves an R2 read). */
  trail?: ProcessedTrail;
}

/**
 * Review a stored route and record the outcome. A confident reject hides an
 * `unverified` route; a verified or already hidden one is left to the admin.
 * Never throws (it runs from `waitUntil`).
 */
export async function reviewStoredRoute(env: Env, id: string, deps: ReviewDeps = {}): Promise<void> {
  try {
    const row = await loadRoute(env, id);
    if (!row || row.status === 'removed') return;
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
    const now = new Date().toISOString();
    const hide = reviewHides(review);
    // `status = 'unverified'` in the WHERE: an admin may have verified or
    // hidden the route while the model was thinking, and that decision wins.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_routes SET review_json = ?, review_status = ? WHERE id = ? AND status != 'removed'`
      ).bind(JSON.stringify(review), review.status, id),
      ...(hide
        ? [
            env.DB.prepare(
              `UPDATE community_routes
                  SET status = 'hidden', status_note = ?, updated_at = ?
                WHERE id = ? AND status = 'unverified'`
            ).bind('Hidden by the automatic review', now, id),
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
    `SELECT id, name, length_km, start_lat, start_lon, end_lat, end_lon FROM community_routes
      WHERE status IN ('unverified', 'verified')
        AND start_lat BETWEEN ? AND ? AND start_lon BETWEEN ? AND ?
      LIMIT 50`
  )
    .bind(stats.start.lat - dLat, stats.start.lat + dLat, stats.start.lon - dLon, stats.start.lon + dLon)
    .all<{ id: string; name: string; length_km: number; start_lat: number; start_lon: number; end_lat: number; end_lon: number }>();
  for (const r of results) {
    const startM = haversineDistance(r.start_lat, r.start_lon, stats.start.lat, stats.start.lon);
    const endM = haversineDistance(r.end_lat, r.end_lon, stats.end.lat, stats.end.lon);
    const lengthOff = Math.abs(r.length_km - stats.lengthKm) / Math.max(r.length_km, stats.lengthKm, 0.001);
    if (startM <= NEAR_DUPLICATE_M && endM <= NEAR_DUPLICATE_M && lengthOff <= NEAR_DUPLICATE_LENGTH) {
      return {
        id: 'duplicate',
        level: 'warn',
        message: `This looks like "${r.name}", which is already shared: it starts and ends in the same places and is about as long.`,
      };
    }
  }
  return { id: 'duplicate', level: 'pass', message: 'No shared route matches this one.' };
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
  deps: ReviewDeps = {}
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

  const body = await readCappedJson(request, MAX_BODY_BYTES);
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

  const result = runCommunityChecks(body.trail, { name, description });
  if (!result.ok || !result.trail || !result.stats) {
    return checksFailed(result.checks, 'The route did not pass the automatic checks');
  }
  const checks = [...result.checks, await nearDuplicateCheck(env, result.stats)];

  const hash = await contentHash(result.trail);
  const existing = await env.DB.prepare(
    `SELECT id FROM community_routes WHERE content_hash = ? AND status != 'removed'`
  )
    .bind(hash)
    .first<{ id: string }>();
  if (existing) return duplicateResponse(existing.id);

  await consumeRateLimit(
    env,
    RATE_BUCKETS.communitySubmit,
    user.id,
    Date.now(),
    `You can share at most ${COMMUNITY_LIMITS.submitsPerDay} routes a day`,
    ctx
  );

  const id = generateRouteId();
  const submittedBy = user.display_name;
  const stored = withServerConfig(result.trail, { id, name, description, credit, country, state, submittedBy });
  const put = await storeTrail(env, id, stored, true);
  let gpxKey: string | null = null;
  if (gpx) {
    gpxKey = privateKey(id, 'gpx');
    await env.PHOTOS.put(gpxKey, gpx, { httpMetadata: { contentType: 'application/gpx+xml' } });
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
        `SELECT id FROM community_routes WHERE content_hash = ? AND status != 'removed'`
      )
        .bind(hash)
        .first<{ id: string }>();
      return duplicateResponse(winner?.id ?? null);
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

/**
 * The existing route may be hidden (or someone else's), so the wording says
 * only that the track was shared before, never that it is in the list.
 */
function duplicateResponse(existingId: string | null): Response {
  return json(
    {
      error: { code: 'duplicate', message: 'This exact track has been shared before' },
      existingId,
    },
    409
  );
}

// ---------------------------------------------------------------------------
// GET /v1/community/routes — the public list
// ---------------------------------------------------------------------------

export async function listCommunityRoutes(request: Request, env: Env): Promise<Response> {
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

  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`
  )
    .bind(...binds)
    .all<CommunityRouteRow>();

  const payload: CommunityListResponse = { routes: results.map((row) => toSummary(env, row)) };
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
  deps: ReviewDeps = {}
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
      : cleanText(body.description, 'description', COMMUNITY_LIMITS.descriptionMin, COMMUNITY_LIMITS.descriptionMax, true);
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

  // The admin verified the old text: an edit sends it back to unverified.
  const status: CommunityRouteStatus = row.status === 'verified' ? 'unverified' : row.status;
  const review = initialReview(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE community_routes
        SET name = ?, description = ?, credit = ?, country = ?, state = ?, status = ?,
            verified_at = CASE WHEN ? = 'verified' THEN verified_at ELSE NULL END,
            verified_by = CASE WHEN ? = 'verified' THEN verified_by ELSE NULL END,
            md5 = ?, bytes = ?, r2_key = ?, private_key = ?, review_json = ?, review_status = ?, updated_at = ?
      WHERE id = ?`
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
      review.json,
      review.status,
      now,
      id
    )
    .run();
  // The old public object stays for cached lists; the old private one is
  // named by nothing now.
  ctx.waitUntil(deleteObjects(env, [row.private_key]));

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

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE community_routes SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?`
  )
    .bind(now, now, id)
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

  const already = await env.DB.prepare(
    `SELECT id FROM community_route_reports WHERE route_id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<{ id: number }>();
  if (already) return json({ ok: true }, 200);

  const nowMs = Date.now();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM community_route_reports WHERE user_id = ? AND created_at >= ?`
  )
    .bind(user.id, new Date(nowMs - 24 * 60 * 60 * 1000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORTS_PER_DAY) {
    throw new HttpError(429, 'rate_limited', `Report limit of ${REPORTS_PER_DAY} per day reached`);
  }

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
    // hidden again by the reports the admin already weighed.
    env.DB.prepare(
      `UPDATE community_routes
          SET status = 'hidden', status_note = ?, updated_at = ?
        WHERE id = ? AND status = 'unverified'
          AND (SELECT COUNT(*) FROM community_route_reports r
                WHERE r.route_id = community_routes.id
                  AND r.created_at > community_routes.status_changed_at) >= ?`
    ).bind(`Hidden after ${COMMUNITY_REPORTS_TO_HIDE} reports`, now, id, COMMUNITY_REPORTS_TO_HIDE),
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
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE user_id = ? AND status != 'removed'
      ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`
  )
    .bind(user.id)
    .all<CommunityRouteRow>();
  const payload: CommunityAdminListResponse = {
    routes: results.map((row) => toDetail(env, row, 'owner', true)),
  };
  return json(payload, 200, { 'Cache-Control': 'private, no-store' });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** GET /v1/admin/community/routes — the moderation queue. */
export async function adminListCommunityRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const admin = await requireAdmin(request, env, ctx);
  const [{ results: rows }, { results: reports }] = await env.DB.batch<CommunityRouteRow | ReportRow>([
    env.DB.prepare(
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
    ),
    env.DB.prepare(
      `SELECT r.route_id, r.reason, r.note, r.created_at
         FROM community_route_reports r JOIN community_routes c ON c.id = r.route_id
        WHERE c.status != 'removed'
        ORDER BY r.created_at DESC, r.id DESC`
    ),
  ]);
  const byRoute = new Map<string, ReportRow[]>();
  for (const r of reports as ReportRow[]) {
    const list = byRoute.get(r.route_id) ?? [];
    list.push(r);
    byRoute.set(r.route_id, list);
  }
  const payload: CommunityAdminListResponse = {
    routes: (rows as CommunityRouteRow[]).map((row) =>
      toDetail(env, row, 'admin', row.user_id === admin.id, byRoute.get(row.id) ?? [])
    ),
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
  const row = await loadRoute(env, id);
  if (!row || row.status === 'removed') throw notFound();

  const now = new Date().toISOString();
  const verified = status === 'verified';
  // Back on the public domain before the row says it is live; the copy comes
  // from the private one, which hiding left in place.
  let r2Key = status === 'hidden' ? null : row.r2_key;
  if (status !== 'hidden' && !r2Key) {
    r2Key = await publishFromPrivate(env, row);
    if (!r2Key) throw new HttpError(500, 'trail_missing', 'The stored route could not be read');
  }
  await env.DB.prepare(
    `UPDATE community_routes
        SET status = ?, status_note = ?, updated_at = ?, status_changed_at = ?,
            verified_at = ?, verified_by = ?, r2_key = ?
      WHERE id = ?`
  )
    .bind(
      status,
      note,
      now,
      now,
      verified ? (row.status === 'verified' ? row.verified_at : now) : null,
      verified ? (row.status === 'verified' ? row.verified_by : admin.id) : null,
      r2Key,
      id
    )
    .run();
  if (status === 'hidden') await purgePublic(env, id);
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
 * (they were released as CC0) but lose the submitter's name.
 */
export function deattributeStatement(env: Env, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE community_routes SET submitted_by_name = NULL WHERE user_id = ?`
  ).bind(userId);
}

/**
 * After the row update: rewrite each route's stored JSON (the private copy,
 * and a new public one while it is live) so its attribution line no longer
 * names the account. Unlike an owner's edit, the older public versions are
 * purged straight away: they name the account, and a list cached for a few
 * minutes 404ing on them is the lesser harm. Best-effort, off the response
 * path; a route whose object cannot be read keeps its old key.
 */
export async function deattributeStoredRoutes(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM community_routes WHERE user_id = ? AND status != 'removed'`
  )
    .bind(userId)
    .all<CommunityRouteRow>();
  for (const row of results) {
    try {
      const put = await republish(
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
      if (!put) continue;
      await env.DB.prepare(
        `UPDATE community_routes SET md5 = ?, bytes = ?, r2_key = ?, private_key = ?, updated_at = ? WHERE id = ?`
      )
        .bind(put.md5, put.bytes, put.publicKey, put.privateKey, new Date().toISOString(), row.id)
        .run();
      // Every older copy names the account: drop the old private one and all
      // public versions but the new one.
      await deleteObjects(env, [row.private_key]);
      await purgePublic(env, row.id, put.publicKey);
    } catch (err) {
      console.error(`De-attributing ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
