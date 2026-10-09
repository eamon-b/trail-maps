/**
 * Shared hiker waypoints: places a hiker added to a trail and shared with
 * everyone (the missing water source, a shop the guide does not list).
 *
 * The rules a waypoint must meet are `checkUserWaypointInput` in
 * `src/lib/user-waypoints.ts`, which the phone runs first, so the two refuse the
 * same things. Post-moderated like comments: anyone signed in may share, every
 * write is tombstoned rather than deleted so offline phones learn it is gone,
 * an owner or admin can delete, and `reportsToHide` distinct reporters hide one.
 *
 *   PUT    /v1/waypoints/:id             create, or the owner's edit (idempotent)
 *   DELETE /v1/waypoints/:id             owner or admin soft delete
 *   POST   /v1/waypoints/:id/report      report (one per reporter)
 *   GET    /v1/trails/:trailId/waypoints public full / delta read
 *   GET    /v1/admin/waypoints           admin listing, reported first
 */

import { HttpError, json, noContent, readJson } from './http';
import type { Env } from './http';
import { getUser, requireAdmin, requireUser } from './auth';
import { appendSinceFilter } from './cursor';
import { RATE_BUCKETS, consumeRateLimit } from './rate-limit';
import {
  parseLimit,
  validateReportDetail,
  validateReportReason,
  validateTrailId,
} from './validation';
import {
  USER_WAYPOINT_LIMITS,
  checkUserWaypointInput,
  isUserWaypointId,
} from '../../../src/lib/user-waypoints';
import type {
  SharedWaypoint,
  SharedWaypointEntry,
  SharedWaypointsResponse,
} from '../../../src/lib/comments-api-types';

/** Rows one read returns; a longer delta resumes from the last row's stamp. */
const SYNC_PAGE_LIMIT = 2000;
const ADMIN_DEFAULT_LIMIT = 100;
const ADMIN_MAX_LIMIT = 500;

interface SharedWaypointRow {
  id: string;
  trail_id: string;
  user_id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  description: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: 'owner' | 'admin' | 'reports' | null;
}

function toSharedWaypoint(
  row: SharedWaypointRow,
  displayName: string,
  viewerId: string | null
): SharedWaypoint {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lon: row.lon,
    description: row.description,
    displayName,
    ...(viewerId !== null ? { mine: row.user_id === viewerId } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertWaypointId(id: string): void {
  if (!isUserWaypointId(id)) {
    throw new HttpError(400, 'invalid_id', 'Waypoint id must be hw_ followed by a uuid v4');
  }
}

async function readRow(env: Env, id: string): Promise<SharedWaypointRow | null> {
  return env.DB.prepare(`SELECT * FROM shared_waypoints WHERE id = ?`)
    .bind(id)
    .first<SharedWaypointRow>();
}

// ---------------------------------------------------------------------------
// PUT /v1/waypoints/:id
// ---------------------------------------------------------------------------

export async function putSharedWaypoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertWaypointId(id);
  const user = await requireUser(request, env, ctx);
  const body = await readJson(request);
  const trailId = validateTrailId(body.trailId);
  const check = checkUserWaypointInput({
    name: body.name as string,
    type: body.type as string,
    lat: body.lat as number,
    lon: body.lon as number,
    description: body.description as string | null | undefined,
  });
  if (!check.ok) throw new HttpError(400, `invalid_${check.field}`, check.message);
  const value = check.value;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const existing = await readRow(env, id);
  if (existing) {
    if (existing.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This waypoint id belongs to another user');
    }
    if (existing.deleted_at !== null) {
      throw new HttpError(410, 'waypoint_deleted', 'This waypoint has been deleted');
    }
    if (existing.trail_id !== trailId) {
      throw new HttpError(400, 'invalid_trail', 'A waypoint cannot move to another trail');
    }
    const unchanged =
      existing.name === value.name &&
      existing.type === value.type &&
      existing.lat === value.lat &&
      existing.lon === value.lon &&
      existing.description === value.description;
    // A replayed create, or an edit that changes nothing: answered as stored,
    // stamp untouched, so no phone re-pulls it. Like a comment replay it skips
    // the ban and the rate limit — an outbox retry must always settle.
    if (unchanged) return json(toSharedWaypoint(existing, user.display_name, user.id), 200);

    if (user.is_banned === 1) {
      throw new HttpError(403, 'banned', 'This account may not share waypoints');
    }
    await consumeRateLimit(
      env,
      RATE_BUCKETS.sharedWaypointEdit,
      user.id,
      nowMs,
      `Waypoint edit limit of ${RATE_BUCKETS.sharedWaypointEdit.limit} per day reached`,
      ctx
    );
    const updated = await env.DB.prepare(
      `UPDATE shared_waypoints
          SET name = ?, type = ?, lat = ?, lon = ?, description = ?,
              updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        RETURNING *`
    )
      .bind(value.name, value.type, value.lat, value.lon, value.description, nowIso, id, user.id)
      .first<SharedWaypointRow>();
    if (!updated) throw new HttpError(410, 'waypoint_deleted', 'This waypoint has been deleted');
    return json(toSharedWaypoint(updated, user.display_name, user.id), 200);
  }

  if (user.is_banned === 1) {
    throw new HttpError(403, 'banned', 'This account may not share waypoints');
  }
  await consumeRateLimit(
    env,
    RATE_BUCKETS.sharedWaypointCreate,
    user.id,
    nowMs,
    `You can share up to ${RATE_BUCKETS.sharedWaypointCreate.limit} waypoints a day`,
    ctx
  );

  const inserted = await env.DB.prepare(
    `INSERT INTO shared_waypoints
       (id, trail_id, user_id, name, type, lat, lon, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING *`
  )
    .bind(id, trailId, user.id, value.name, value.type, value.lat, value.lon, value.description, nowIso, nowIso)
    .first<SharedWaypointRow>();
  if (!inserted) {
    // Lost a race with a concurrent insert of the same id: re-read and replay.
    const row = await readRow(env, id);
    if (!row) throw new HttpError(500, 'insert_failed', 'Waypoint could not be stored');
    if (row.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This waypoint id belongs to another user');
    }
    return json(toSharedWaypoint(row, user.display_name, user.id), 200);
  }
  return json(toSharedWaypoint(inserted, user.display_name, user.id), 201);
}

// ---------------------------------------------------------------------------
// DELETE /v1/waypoints/:id
// ---------------------------------------------------------------------------

export async function deleteSharedWaypoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertWaypointId(id);
  const user = await requireUser(request, env, ctx);
  const row = await readRow(env, id);
  if (!row) throw new HttpError(404, 'not_found', 'Waypoint not found');

  const isOwner = row.user_id === user.id;
  if (!isOwner && user.is_admin !== 1) {
    throw new HttpError(403, 'forbidden', 'You may only delete your own waypoints');
  }
  if (row.deleted_at !== null) return noContent();

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE shared_waypoints SET deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
  )
    .bind(now, isOwner ? 'owner' : 'admin', now, id)
    .run();
  return noContent();
}

// ---------------------------------------------------------------------------
// POST /v1/waypoints/:id/report
// ---------------------------------------------------------------------------

export async function reportSharedWaypoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertWaypointId(id);
  // Reporting is a safety action: a banned account may still report.
  const user = await requireUser(request, env, ctx);
  const body = await readJson(request);
  const reason = validateReportReason(body.reason);
  const detail = validateReportDetail(body.detail);

  const row = await readRow(env, id);
  if (!row) throw new HttpError(404, 'not_found', 'Waypoint not found');
  if (row.deleted_at !== null) throw new HttpError(410, 'waypoint_deleted', 'Waypoint has been deleted');
  if (row.user_id === user.id) {
    throw new HttpError(400, 'own_waypoint', 'You cannot report your own waypoint');
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM shared_waypoint_reports WHERE waypoint_id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<{ id: string }>();
  if (existing) return json({ reportId: existing.id }, 200);

  const nowMs = Date.now();
  await consumeRateLimit(
    env,
    RATE_BUCKETS.sharedWaypointReport,
    user.id,
    nowMs,
    `Report limit of ${RATE_BUCKETS.sharedWaypointReport.limit} per day reached`,
    ctx
  );
  const nowIso = new Date(nowMs).toISOString();
  const reportId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO shared_waypoint_reports (id, waypoint_id, user_id, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(waypoint_id, user_id) DO NOTHING
     RETURNING id`
  )
    .bind(reportId, id, user.id, reason, detail, nowIso)
    .first<{ id: string }>();
  if (!inserted) {
    const again = await env.DB.prepare(
      `SELECT id FROM shared_waypoint_reports WHERE waypoint_id = ? AND user_id = ?`
    )
      .bind(id, user.id)
      .first<{ id: string }>();
    return json({ reportId: again?.id ?? reportId }, 200);
  }

  // Enough distinct reporters hide it. One statement, so two reports landing
  // together cannot both miss the threshold.
  await env.DB.prepare(
    `UPDATE shared_waypoints SET deleted_at = ?, deleted_by = 'reports', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND (SELECT COUNT(*) FROM shared_waypoint_reports WHERE waypoint_id = ?) >= ?`
  )
    .bind(nowIso, nowIso, id, id, USER_WAYPOINT_LIMITS.reportsToHide)
    .run();

  return json({ reportId: inserted.id }, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/waypoints?since=
// ---------------------------------------------------------------------------

export async function getTrailSharedWaypoints(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trailIdRaw: string
): Promise<Response> {
  const trailId = validateTrailId(trailIdRaw);
  // Optional: a signed-in reader learns which waypoints are their own (after a
  // reinstall, say). Never required — the read is public.
  const viewer = await getUser(request, env, ctx);
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const nowIso = new Date().toISOString();

  const conditions = ['w.trail_id = ?'];
  const binds: unknown[] = [trailId];
  if (since) {
    appendSinceFilter(conditions, binds, 'w.updated_at', since);
  } else {
    conditions.push('w.deleted_at IS NULL');
  }

  const { results } = await env.DB.prepare(
    `SELECT w.*, u.display_name AS display_name
       FROM shared_waypoints w JOIN users u ON u.id = w.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY w.updated_at ASC, w.id ASC
      LIMIT ?`
  )
    .bind(...binds, SYNC_PAGE_LIMIT + 1)
    .all<SharedWaypointRow & { display_name: string }>();

  // A longer delta than one page: answer the page and hand back the last row's
  // stamp as the mark. `since` is inclusive, so the next read resumes there.
  let syncedAt = nowIso;
  if (results.length > SYNC_PAGE_LIMIT) {
    results.length = SYNC_PAGE_LIMIT;
    syncedAt = results[results.length - 1].updated_at;
  }

  const waypoints: SharedWaypointEntry[] = results.map((row) =>
    row.deleted_at !== null
      ? { id: row.id, deleted: true as const, updatedAt: row.updated_at }
      : toSharedWaypoint(row, row.display_name, viewer?.id ?? null)
  );
  const payload: SharedWaypointsResponse = { waypoints, syncedAt };
  return json(payload, 200, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// GET /v1/admin/waypoints
// ---------------------------------------------------------------------------

export async function adminListSharedWaypoints(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), ADMIN_DEFAULT_LIMIT, ADMIN_MAX_LIMIT);
  const { results } = await env.DB.prepare(
    `SELECT w.*, u.display_name AS display_name,
            (SELECT COUNT(*) FROM shared_waypoint_reports r WHERE r.waypoint_id = w.id) AS report_count
       FROM shared_waypoints w JOIN users u ON u.id = w.user_id
      ORDER BY report_count DESC, w.created_at DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<SharedWaypointRow & { display_name: string; report_count: number }>();
  return json({
    waypoints: results.map((row) => ({
      ...toSharedWaypoint(row, row.display_name, null),
      userId: row.user_id,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      reportCount: row.report_count,
    })),
  });
}
