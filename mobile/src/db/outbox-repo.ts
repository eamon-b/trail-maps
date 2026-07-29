/**
 * Outbox repository — the durable FIFO queue of pending writes (comment
 * creates and deletes) that the sync layer drains against the API.
 *
 * The outbox holds only un-acknowledged work: a row is removed the moment its
 * write is confirmed. `attempts` / `last_error` drive the retry backoff and the
 * "failed" affordance in the UI; `status` is presentational (pending → sending
 * → failed) and is reset to `pending` when a drain is interrupted (offline /
 * 401) so a subsequent run picks it back up.
 */

import type { SqlDatabase } from './sql-database';

export type OutboxKind = 'comment' | 'delete';
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

/** Total queued items (for badges / diagnostics). */
export async function count(db: SqlDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
  return row?.n ?? 0;
}
