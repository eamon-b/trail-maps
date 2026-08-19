/**
 * User-submitted moderation reports.
 *
 * Reporting is a safety action, so banned accounts may still report (unlike
 * posting). One report per (comment, reporter): a repeat submission replays the
 * original id so a retried outbox flush never creates duplicates.
 */

import { HttpError, json, readJson } from './http';
import type { Env } from './http';
import { requireAdmin, requireUser } from './auth';
import {
  assertClientCommentId,
  parseLimit,
  validateReportDetail,
  validateReportReason,
} from './validation';
import type {
  AdminReport,
  AdminReportsResponse,
  ReportCommentResponse,
  ReportReason,
} from '../../../src/lib/comments-api-types';

/** Max reports a single user may file in a rolling 24h window. */
const REPORT_RATE_LIMIT_PER_DAY = 20;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ADMIN_DEFAULT_LIMIT = 100;
const ADMIN_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// POST /v1/comments/:id/report — file a report (any authenticated user)
// ---------------------------------------------------------------------------

/** POST /v1/comments/:id/report — idempotent per (comment, reporter). */
export async function reportComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertClientCommentId(id);
  const user = await requireUser(request, env, ctx);

  const body = await readJson(request);
  const reason = validateReportReason(body.reason);
  const detail = validateReportDetail(body.detail);

  const comment = await env.DB.prepare(`SELECT id, deleted_at FROM comments WHERE id = ?`)
    .bind(id)
    .first<{ id: string; deleted_at: string | null }>();
  if (!comment) {
    throw new HttpError(404, 'not_found', 'Comment not found');
  }
  if (comment.deleted_at !== null) {
    throw new HttpError(410, 'comment_deleted', 'Comment has been deleted');
  }

  // Idempotency: replay the original report id rather than stacking duplicates.
  // This path skips the rate limit because nothing new is stored.
  const existing = await env.DB.prepare(
    `SELECT id FROM comment_reports WHERE comment_id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<{ id: string }>();
  if (existing) {
    const replay: ReportCommentResponse = { reportId: existing.id };
    return json(replay, 200);
  }

  const nowMs = Date.now();
  const windowStart = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM comment_reports WHERE user_id = ? AND created_at >= ?`
  )
    .bind(user.id, windowStart)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= REPORT_RATE_LIMIT_PER_DAY) {
    throw new HttpError(
      429,
      'rate_limited',
      `Report limit of ${REPORT_RATE_LIMIT_PER_DAY} per day reached`
    );
  }

  const reportId = crypto.randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO comment_reports (id, comment_id, user_id, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(comment_id, user_id) DO NOTHING
     RETURNING id`
  )
    .bind(reportId, id, user.id, reason, detail, nowIso)
    .first<{ id: string }>();

  if (!inserted) {
    // Lost a race with a concurrent report of the same comment. Re-read + replay.
    const row = await env.DB.prepare(
      `SELECT id FROM comment_reports WHERE comment_id = ? AND user_id = ?`
    )
      .bind(id, user.id)
      .first<{ id: string }>();
    if (!row) {
      throw new HttpError(500, 'insert_failed', 'Report could not be stored');
    }
    const replay: ReportCommentResponse = { reportId: row.id };
    return json(replay, 200);
  }

  const payload: ReportCommentResponse = { reportId: inserted.id };
  return json(payload, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/admin/reports — admin listing (newest first)
// ---------------------------------------------------------------------------

interface AdminReportRow {
  id: string;
  comment_id: string;
  user_id: string;
  reason: ReportReason;
  detail: string | null;
  created_at: string;
  joined_id: string | null;
  trail_id: string | null;
  waypoint_id: string | null;
  comment_text: string | null;
  comment_deleted_at: string | null;
}

/** GET /v1/admin/reports — every report with its comment context. */
export async function getAdminReports(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), ADMIN_DEFAULT_LIMIT, ADMIN_MAX_LIMIT);

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.comment_id, r.user_id, r.reason, r.detail, r.created_at,
            c.id AS joined_id, c.trail_id, c.waypoint_id,
            c.text AS comment_text, c.deleted_at AS comment_deleted_at
       FROM comment_reports r LEFT JOIN comments c ON c.id = r.comment_id
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<AdminReportRow>();

  const reports: AdminReport[] = results.map((row) => {
    const deleted = row.joined_id === null || row.comment_deleted_at !== null;
    return {
      id: row.id,
      commentId: row.comment_id,
      trailId: row.trail_id ?? '',
      waypointId: row.waypoint_id ?? '',
      reporterUserId: row.user_id,
      reason: row.reason,
      detail: row.detail,
      createdAt: row.created_at,
      commentText: deleted ? null : row.comment_text,
      commentDeleted: deleted,
    };
  });

  const payload: AdminReportsResponse = { reports };
  return json(payload);
}
