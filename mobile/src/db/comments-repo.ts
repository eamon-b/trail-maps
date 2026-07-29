/**
 * Comments repository — the local mirror of server comments plus optimistic
 * local rows.
 *
 * id/source reconciliation
 * ------------------------
 * The comment id is the client-minted UUID that ALSO becomes the server id, so
 * there is exactly one row per comment keyed by that UUID. A comment composed
 * offline is inserted with `source='local'`; once the outbox drain gets a 2xx
 * from the idempotent PUT we flip the SAME row to `source='server'` (see
 * `confirmServer`). A trail sync that later returns that comment upserts onto
 * the same id — `author_id` is deliberately preserved on conflict so our own
 * comments stay attributable (the public feed carries only a display name, not
 * a user id), which is how the detail screen decides who may delete a row.
 */

import type { WaterStatus } from '@lib/comments-api-types';
import type { SqlDatabase } from './sql-database';

export type CommentSource = 'server' | 'local';

/** A comment row as consumed by the UI. */
export interface CommentRecord {
  id: string;
  trailId: string;
  waypointId: string;
  authorId: string | null;
  authorName: string | null;
  body: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
  source: CommentSource;
}

/** A comment row joined with any pending/failed outbox state. */
export interface CommentWithSyncState extends CommentRecord {
  /** Outbox status for a not-yet-confirmed local comment, else null. */
  outboxStatus: 'pending' | 'sending' | 'failed' | null;
  outboxAttempts: number | null;
  outboxLastError: string | null;
}

/** Normalized server comment (from the feed or the bulk/delta sync). */
export interface ServerCommentInput {
  id: string;
  trailId: string;
  waypointId: string;
  displayName: string;
  text: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
}

/** A locally-composed, not-yet-synced comment. */
export interface LocalCommentInput {
  id: string;
  trailId: string;
  waypointId: string;
  authorId: string;
  authorName: string;
  body: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
}

interface CommentRow {
  id: string;
  trail_id: string;
  waypoint_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string | null;
  water_status: WaterStatus | null;
  observed_at: string | null;
  created_at: string;
  source: CommentSource;
}

interface CommentJoinRow extends CommentRow {
  outbox_status: 'pending' | 'sending' | 'failed' | null;
  outbox_attempts: number | null;
  outbox_last_error: string | null;
}

function toRecord(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    trailId: row.trail_id,
    waypointId: row.waypoint_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    waterStatus: row.water_status,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    source: row.source,
  };
}

/**
 * Insert or update a confirmed server comment. `author_id` is preserved on
 * conflict so a comment we authored stays ours after it round-trips through a
 * trail sync (the public feed carries no user id).
 */
export async function upsertServerComment(
  db: SqlDatabase,
  input: ServerCommentInput,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO comments
       (id, trail_id, waypoint_id, author_id, author_name, body,
        water_status, observed_at, created_at, source)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'server')
     ON CONFLICT(id) DO UPDATE SET
       trail_id = excluded.trail_id,
       waypoint_id = excluded.waypoint_id,
       author_name = excluded.author_name,
       body = excluded.body,
       water_status = excluded.water_status,
       observed_at = excluded.observed_at,
       created_at = excluded.created_at,
       source = 'server'`,
    [
      input.id,
      input.trailId,
      input.waypointId,
      input.displayName,
      input.text,
      input.waterStatus,
      input.observedAt,
      input.createdAt,
    ],
  );
}

/** Apply a server tombstone: drop the mirrored row entirely. */
export async function applyTombstone(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM comments WHERE id = ?', [id]);
}

/** Insert an optimistic, not-yet-synced local comment (`source='local'`). */
export async function insertLocalComment(
  db: SqlDatabase,
  input: LocalCommentInput,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO comments
       (id, trail_id, waypoint_id, author_id, author_name, body,
        water_status, observed_at, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
    [
      input.id,
      input.trailId,
      input.waypointId,
      input.authorId,
      input.authorName,
      input.body,
      input.waterStatus,
      input.observedAt,
      input.createdAt,
    ],
  );
}

/**
 * Flip a local row to server-confirmed, adopting the server's authoritative
 * display name / created_at from the PUT response. `author_id` is left intact.
 */
export async function confirmServer(
  db: SqlDatabase,
  id: string,
  server: { displayName: string; text: string | null; waterStatus: WaterStatus | null; observedAt: string | null; createdAt: string },
): Promise<void> {
  await db.runAsync(
    `UPDATE comments
        SET source = 'server',
            author_name = ?,
            body = ?,
            water_status = ?,
            observed_at = ?,
            created_at = ?
      WHERE id = ?`,
    [server.displayName, server.text, server.waterStatus, server.observedAt, server.createdAt, id],
  );
}

/** Fetch a single comment by id, or null. */
export async function getById(db: SqlDatabase, id: string): Promise<CommentRecord | null> {
  const row = await db.getFirstAsync<CommentRow>('SELECT * FROM comments WHERE id = ?', [id]);
  return row ? toRecord(row) : null;
}

/** Remove a comment row by id (local cancel or optimistic delete). */
export async function deleteById(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM comments WHERE id = ?', [id]);
}

/**
 * All comments for a waypoint, newest-first, each joined with its outbox state
 * so the UI can render "waiting to send" / "failed" badges without a second
 * query.
 */
export async function listByWaypoint(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<CommentWithSyncState[]> {
  const rows = await db.getAllAsync<CommentJoinRow>(
    `SELECT c.*,
            o.status AS outbox_status,
            o.attempts AS outbox_attempts,
            o.last_error AS outbox_last_error
       FROM comments c
       LEFT JOIN outbox o ON o.id = c.id AND o.kind = 'comment'
      WHERE c.trail_id = ? AND c.waypoint_id = ?
      ORDER BY c.created_at DESC, c.id DESC`,
    [trailId, waypointId],
  );
  return rows.map((row) => ({
    ...toRecord(row),
    outboxStatus: row.outbox_status,
    outboxAttempts: row.outbox_attempts,
    outboxLastError: row.outbox_last_error,
  }));
}

/** Count comments mirrored for a waypoint (for list-row badges). */
export async function countByWaypoint(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM comments WHERE trail_id = ? AND waypoint_id = ?',
    [trailId, waypointId],
  );
  return row?.n ?? 0;
}
