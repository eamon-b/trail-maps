/**
 * Outbox repository — the durable FIFO queue of pending writes (comment
 * creates, deletes, photo uploads, moderation reports, and day-plan documents)
 * that the sync layer drains against the API. `kind='photo'` rows carry
 * `{ commentId, localUri, contentType }` and are gated by the drain until their
 * comment row is server-confirmed; `kind='report'` rows carry
 * `{ commentId, reason, detail }` and have no local comment row of their own;
 * `kind='plan'` rows carry the whole `PlanDocument` and `kind='plan-delete'`
 * rows carry `{ id }` (see `sync/comment-sync`).
 *
 * `waypoint_id` is the row's ENTITY KEY, not always a waypoint: a comment write
 * names the waypoint it is filed against, a plan write names the plan id. It is
 * what {@link replacePending} matches on, so one column serves both.
 *
 * The outbox holds only un-acknowledged work: a row is removed the moment its
 * write is confirmed. `attempts` / `last_error` drive the retry backoff and the
 * "failed" affordance in the UI; `status` is presentational (pending → sending
 * → failed) and is reset to `pending` when a drain is interrupted (offline /
 * 401) so a subsequent run picks it back up.
 */

import type { SqlDatabase } from './sql-database';

/**
 * What a queued row is.
 *
 * `plan` is a FULL REPLACE of one plan document, so only the newest row for a
 * plan is worth sending — see {@link replacePending}, which the plan enqueue
 * path calls first. `plan-delete` tombstones it server-side.
 */
export type OutboxKind = 'comment' | 'delete' | 'photo' | 'report' | 'plan' | 'plan-delete';
export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  trailId: string | null;
  waypointId: string | null;
  payloadJson: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  status: OutboxStatus;
}

export interface EnqueueInput {
  id: string;
  kind: OutboxKind;
  trailId?: string | null;
  /** The entity this write is about: a waypoint id, or a plan id for plan rows. */
  waypointId?: string | null;
  /** Serialized request body. */
  payload: unknown;
  /** Explicit timestamp (tests); defaults to `datetime('now')`. */
  createdAt?: string;
}

interface OutboxRow {
  id: string;
  kind: OutboxKind;
  trail_id: string | null;
  waypoint_id: string | null;
  payload_json: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
  status: OutboxStatus;
}

function toItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    kind: row.kind,
    trailId: row.trail_id,
    waypointId: row.waypoint_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    attempts: row.attempts,
    lastError: row.last_error,
    status: row.status,
  };
}

/** Enqueue a write. Replaces any prior row for the same id. */
export async function enqueue(db: SqlDatabase, input: EnqueueInput): Promise<void> {
  const payloadJson = JSON.stringify(input.payload ?? null);
  if (input.createdAt !== undefined) {
    await db.runAsync(
      `INSERT INTO outbox (id, kind, trail_id, waypoint_id, payload_json, created_at, attempts, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         trail_id = excluded.trail_id,
         waypoint_id = excluded.waypoint_id,
         payload_json = excluded.payload_json,
         created_at = excluded.created_at,
         attempts = 0,
         last_error = NULL,
         status = 'pending'`,
      [input.id, input.kind, input.trailId ?? null, input.waypointId ?? null, payloadJson, input.createdAt],
    );
    return;
  }
  await db.runAsync(
    `INSERT INTO outbox (id, kind, trail_id, waypoint_id, payload_json, attempts, status)
     VALUES (?, ?, ?, ?, ?, 0, 'pending')
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       trail_id = excluded.trail_id,
       waypoint_id = excluded.waypoint_id,
       payload_json = excluded.payload_json,
       created_at = datetime('now'),
       attempts = 0,
       last_error = NULL,
       status = 'pending'`,
    [input.id, input.kind, input.trailId ?? null, input.waypointId ?? null, payloadJson],
  );
}

/** All queued items in FIFO order (oldest first). */
export async function listPending(db: SqlDatabase): Promise<OutboxItem[]> {
  const rows = await db.getAllAsync<OutboxRow>(
    'SELECT * FROM outbox ORDER BY created_at ASC, id ASC',
  );
  return rows.map(toItem);
}

/** Fetch a single queued item by id. */
export async function getById(db: SqlDatabase, id: string): Promise<OutboxItem | null> {
  const row = await db.getFirstAsync<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
  return row ? toItem(row) : null;
}

/** Mark an item as in-flight. */
export async function markSending(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync("UPDATE outbox SET status = 'sending' WHERE id = ?", [id]);
}

/** Revert an item to pending (drain interrupted; no attempt charged). */
export async function markPending(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync("UPDATE outbox SET status = 'pending' WHERE id = ?", [id]);
}

/** Record a failed attempt: bump `attempts`, store the error, mark failed. */
export async function markFailed(db: SqlDatabase, id: string, error: string): Promise<void> {
  await db.runAsync(
    "UPDATE outbox SET attempts = attempts + 1, last_error = ?, status = 'failed' WHERE id = ?",
    [error, id],
  );
}

/** Remove an item once its write is confirmed. */
export async function remove(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
}

/**
 * Drop every not-in-flight row of `kind` for one entity key, so a freshly
 * enqueued row supersedes them.
 *
 * This is what keeps a burst of plan edits from becoming a burst of PUTs: a
 * plan write replaces the whole document, so the only row worth sending is the
 * latest, and an older one would merely re-send a state the newer row already
 * contains (and burn a request against the server's daily plan-write budget).
 * Comments are never coalesced this way — each one is its own text.
 *
 * `sending` rows are deliberately spared. They are mid-flight against the API;
 * deleting the row would lose the drain's handle on the response, and the
 * newer row simply drains after it (FIFO by `created_at`).
 *
 * @returns how many rows were dropped.
 */
export async function replacePending(
  db: SqlDatabase,
  kind: OutboxKind,
  key: string,
): Promise<number> {
  const before = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox WHERE kind = ? AND waypoint_id = ? AND status != 'sending'",
    [kind, key],
  );
  await db.runAsync(
    "DELETE FROM outbox WHERE kind = ? AND waypoint_id = ? AND status != 'sending'",
    [kind, key],
  );
  return before?.n ?? 0;
}

/**
 * The error on the most recent FAILED row of `kind` for one entity key, or
 * null when nothing of that kind is failing.
 *
 * A 4xx leaves the row `failed` with the server's message on it and drains no
 * further, which is otherwise invisible: the local document still looks saved,
 * because it is. This is how a screen can say that the copy on the server is
 * not the one on the phone.
 */
export async function lastFailure(
  db: SqlDatabase,
  kind: OutboxKind,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ last_error: string | null }>(
    `SELECT last_error FROM outbox
     WHERE kind = ? AND waypoint_id = ? AND status = 'failed'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [kind, key],
  );
  return row ? (row.last_error ?? null) : null;
}

/** Total queued items (for badges / diagnostics). */
export async function count(db: SqlDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
  return row?.n ?? 0;
}
