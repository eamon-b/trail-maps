/**
 * Comment endpoints: idempotent create, soft delete, per-waypoint feed,
 * trail-wide bulk/delta sync, and the admin listing.
 */

import { HttpError, json, noContent, readJson } from './http';
import type { Env } from './http';
import { requireAdmin, requireUser } from './auth';
import { deleteCommentPhotos, parsePhotoUrls } from './photos';
import {
  assertClientCommentId,
  clampObservedAt,
  parseLimit,
  validateText,
  validateTrailId,
  validateWaterStatus,
  validateWaypointId,
} from './validation';
import type {
  AdminComment,
  AdminCommentsResponse,
  BulkSyncResponse,
  FeedComment,
  FeedResponse,
  SyncEntry,
  WaterStatus,
} from '../../../src/lib/comments-api-types';

/** Max comments a single user may create in a rolling 24h window. */
const RATE_LIMIT_PER_DAY = 60;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const FEED_DEFAULT_LIMIT = 20;
const FEED_MAX_LIMIT = 100;
const BULK_DEFAULT_LIMIT = 500;
const BULK_MAX_LIMIT = 1000;
const ADMIN_DEFAULT_LIMIT = 100;
const ADMIN_MAX_LIMIT = 500;

/** A row as stored in the `comments` table. */
export interface CommentRow {
  id: string;
  trail_id: string;
  waypoint_id: string;
  user_id: string;
  text: string | null;
  water_status: WaterStatus | null;
  observed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: 'owner' | 'admin' | null;
  photo_urls_json: string | null;
}

// ---------------------------------------------------------------------------
// Keyset cursor helpers — base64("sortValue|id")
// ---------------------------------------------------------------------------

function encodeCursor(sortValue: string, id: string): string {
  return btoa(`${sortValue}|${id}`);
}

function decodeCursor(raw: string | null): { sortValue: string; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not valid base64');
  }
  const sep = decoded.indexOf('|');
  if (sep === -1) {
    throw new HttpError(400, 'invalid_cursor', 'malformed cursor');
  }
  return { sortValue: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

function toFeedComment(row: CommentRow, displayName: string): FeedComment {
  return {
    id: row.id,
    waypointId: row.waypoint_id,
    displayName,
    text: row.text,
    waterStatus: row.water_status,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    photoUrls: parsePhotoUrls(row.photo_urls_json),
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/comments/:id — idempotent create
// ---------------------------------------------------------------------------

export async function putComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertClientCommentId(id);
  const user = await requireUser(request, env, ctx);

  const body = await readJson(request);
  const trailId = validateTrailId(body.trailId);
  const waypointId = validateWaypointId(body.waypointId);
  const text = validateText(body.text);
  const waterStatus = validateWaterStatus(body.waterStatus);
  if (text === null && waterStatus === null) {
    throw new HttpError(
      400,
      'empty_comment',
      'A comment must include text, a water status, or both'
    );
  }
  const nowMs = Date.now();
  const observedAt = clampObservedAt(body.observedAt, nowMs);

  // Idempotency: if this client id already exists, replay it (or 409 if it
  // belongs to someone else). This path skips ban/rate-limit checks because the
  // row is already stored — a byte-safe outbox retry must always succeed.
  const existing = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`)
    .bind(id)
    .first<CommentRow>();
  if (existing) {
    if (existing.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This comment id belongs to another user');
    }
    return json(toFeedComment(existing, user.display_name), 200);
  }

  // New comment — enforce moderation guards.
  if (user.is_banned === 1) {
    throw new HttpError(403, 'banned', 'This account may not post comments');
  }

  const windowStart = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at >= ?`
  )
    .bind(user.id, windowStart)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= RATE_LIMIT_PER_DAY) {
    throw new HttpError(
      429,
      'rate_limited',
      `Comment limit of ${RATE_LIMIT_PER_DAY} per day reached`
    );
  }

  const nowIso = new Date(nowMs).toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO comments
       (id, trail_id, waypoint_id, user_id, text, water_status, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING *`
  )
    .bind(id, trailId, waypointId, user.id, text, waterStatus, observedAt, nowIso, nowIso)
    .first<CommentRow>();

  if (!inserted) {
    // Lost a race with a concurrent insert of the same id. Re-read and replay.
    const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`)
      .bind(id)
      .first<CommentRow>();
    if (!row) {
      throw new HttpError(500, 'insert_failed', 'Comment could not be stored');
    }
    if (row.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This comment id belongs to another user');
    }
    return json(toFeedComment(row, user.display_name), 200);
  }

  return json(toFeedComment(inserted, user.display_name), 201);
}

// ---------------------------------------------------------------------------
// DELETE /v1/comments/:id — soft delete (owner or admin)
// ---------------------------------------------------------------------------

export async function deleteComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`)
    .bind(id)
    .first<CommentRow>();
  if (!row) {
    throw new HttpError(404, 'not_found', 'Comment not found');
  }

  const isOwner = row.user_id === user.id;
  const isAdmin = user.is_admin === 1;
  if (!isOwner && !isAdmin) {
    throw new HttpError(403, 'forbidden', 'You may only delete your own comments');
  }

  // Idempotent: already tombstoned → 204 without touching anything.
  if (row.deleted_at !== null) {
    return noContent();
  }

  const now = new Date().toISOString();
  const deletedBy = isOwner ? 'owner' : 'admin';
  await env.DB.prepare(
    `UPDATE comments SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`
  )
    .bind(now, deletedBy, now, id)
    .run();

  // Tombstoned comments must not leak images: best-effort R2 cleanup off the
  // response path. Already-cached client URLs may 404 afterwards — that's fine.
  if (row.photo_urls_json !== null) {
    ctx.waitUntil(deleteCommentPhotos(env, id));
  }

  return noContent();
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/waypoints/:waypointId/comments — public feed
// ---------------------------------------------------------------------------

export async function getWaypointFeed(
  request: Request,
  env: Env,
  trailId: string,
  waypointId: string
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const conditions = ['c.trail_id = ?', 'c.waypoint_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [trailId, waypointId];
  if (cursor) {
    // Newest-first keyset: advance to strictly-older rows.
    conditions.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }

  const sql =
    `SELECT c.*, u.display_name AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<CommentRow & { display_name: string }>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  const comments: FeedComment[] = page.map((row) => toFeedComment(row, row.display_name));
  const payload: FeedResponse = { comments, nextCursor };
  return json(payload);
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/comments — public bulk / delta sync
// ---------------------------------------------------------------------------

export async function getBulkSync(request: Request, env: Env, trailId: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), BULK_DEFAULT_LIMIT, BULK_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const since = url.searchParams.get('since');
  const syncedAt = new Date().toISOString();

  const conditions = ['c.trail_id = ?'];
  const binds: unknown[] = [trailId];

  if (since) {
    // Delta mode: everything touched after `since`, tombstones included.
    conditions.push('c.updated_at > ?');
    binds.push(since);
  } else {
    // Snapshot mode: only live rows.
    conditions.push('c.deleted_at IS NULL');
  }

  if (cursor) {
    // Ascending keyset: continue from the last (updated_at, id) seen.
    conditions.push('(c.updated_at > ? OR (c.updated_at = ? AND c.id > ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }

  const sql =
    `SELECT c.*, u.display_name AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.updated_at ASC, c.id ASC
      LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<CommentRow & { display_name: string }>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.updated_at, last.id);
  }

  const comments: SyncEntry[] = page.map((row) => {
    if (row.deleted_at !== null) {
      return {
        id: row.id,
        waypointId: row.waypoint_id,
        deleted: true as const,
        updatedAt: row.updated_at,
      };
    }
    return {
      id: row.id,
      waypointId: row.waypoint_id,
      displayName: row.display_name,
      text: row.text,
      waterStatus: row.water_status,
      observedAt: row.observed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      photoUrls: parsePhotoUrls(row.photo_urls_json),
    };
  });

  const payload: BulkSyncResponse = { comments, nextCursor, syncedAt };
  return json(payload);
}

// ---------------------------------------------------------------------------
// GET /v1/admin/comments — admin listing (newest across all trails)
// ---------------------------------------------------------------------------

export async function getAdminComments(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), ADMIN_DEFAULT_LIMIT, ADMIN_MAX_LIMIT);

  const { results } = await env.DB.prepare(
    `SELECT c.*, u.display_name AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<CommentRow & { display_name: string }>();

  const comments: AdminComment[] = results.map((row) => ({
    id: row.id,
    trailId: row.trail_id,
    waypointId: row.waypoint_id,
    userId: row.user_id,
    displayName: row.display_name,
    text: row.text,
    waterStatus: row.water_status,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  }));

  const payload: AdminCommentsResponse = { comments };
  return json(payload);
}
