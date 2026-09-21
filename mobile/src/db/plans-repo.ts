/**
 * Plans repository — one `PlanDocument` per trail, stored whole as JSON.
 *
 * The plan is a single document by design (see `@lib/plan-types`): the same
 * shape is the wire body of `PUT /v1/plans/:id`, the web's `localStorage`
 * value and the share payload. Shredding it into stop rows here would buy
 * nothing (a plan is read and written whole, never queried by stop) and cost a
 * lossy re-assembly on every sync, so this repo is a thin, typed door onto the
 * `plans` table: parse on the way out, stringify on the way in.
 *
 * Two rules the table itself cannot express:
 *
 * - **A malformed row is an absent plan.** `document_json` can be a document
 *   written by a newer build, a half-written row, or (after a restore) noise.
 *   `getByTrail` runs `isPlanDocument` over it and returns `null` rather than
 *   handing a half-valid object to the day calculator, where a string km would
 *   surface as `NaN` in a day card far from the cause. The row is left alone —
 *   the next local edit replaces it, and a server copy still can.
 * - **Last-writer-wins on `updatedAt`.** `upsertServer` only lands a copy that
 *   is strictly newer than what is stored, which is the same conflict rule
 *   comments use. `upsertLocal` always wins: it IS this device's newest edit.
 *
 * The unique index is partial (live rows only), so a tombstone never blocks a
 * fresh plan for the same trail. Both upserts additionally clear any *other*
 * live row for the trail — the id can legitimately change when the server
 * answers `plan_exists` with its own id and the client adopts it.
 */

import { isPlanDocument } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import type { SqlDatabase } from './sql-database';

/** Where the stored copy came from: a local edit, or the server. */
export type PlanSource = 'local' | 'server';

/** A stored plan row with its document already parsed. */
export interface StoredPlan {
  id: string;
  trailId: string;
  document: PlanDocument;
  updatedAt: string;
  source: PlanSource;
  /** Tombstone timestamp; null for a live plan. */
  deletedAt: string | null;
}

interface PlanRow {
  id: string;
  trail_id: string;
  document_json: string;
  updated_at: string;
  source: PlanSource;
  deleted_at: string | null;
}

function parseRow(row: PlanRow): StoredPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document_json);
  } catch {
    console.warn(`plans-repo: plan ${row.id} holds unparseable JSON — treating it as absent`);
    return null;
  }
  if (!isPlanDocument(parsed)) {
    console.warn(`plans-repo: plan ${row.id} is not a valid PlanDocument — treating it as absent`);
    return null;
  }
  return {
    id: row.id,
    trailId: row.trail_id,
    document: parsed,
    updatedAt: row.updated_at,
    source: row.source,
    deletedAt: row.deleted_at,
  };
}

async function liveRow(db: SqlDatabase, trailId: string): Promise<PlanRow | null> {
  return db.getFirstAsync<PlanRow>(
    'SELECT * FROM plans WHERE trail_id = ? AND deleted_at IS NULL',
    [trailId],
  );
}

async function rowById(db: SqlDatabase, id: string): Promise<PlanRow | null> {
  return db.getFirstAsync<PlanRow>('SELECT * FROM plans WHERE id = ?', [id]);
}

/** The live plan for a trail, or null (absent, tombstoned, or malformed). */
export async function getByTrail(db: SqlDatabase, trailId: string): Promise<PlanDocument | null> {
  const row = await liveRow(db, trailId);
  return row ? (parseRow(row)?.document ?? null) : null;
}

/** One plan by id, tombstones included — the sync side's lookup. */
export async function getById(db: SqlDatabase, id: string): Promise<StoredPlan | null> {
  const row = await rowById(db, id);
  return row ? parseRow(row) : null;
}

async function write(db: SqlDatabase, doc: PlanDocument, source: PlanSource): Promise<void> {
  await db.execAsync('BEGIN');
  try {
    // Any other LIVE plan for this trail loses: the unique index allows only
    // one, and an id change (server `plan_exists` adoption) is the case that
    // produces a second. Tombstones for other ids are left alone — they are
    // deletes still waiting to drain.
    await db.runAsync('DELETE FROM plans WHERE trail_id = ? AND id <> ? AND deleted_at IS NULL', [
      doc.trailId,
      doc.id,
    ]);
    await db.runAsync(
      `INSERT INTO plans (id, trail_id, document_json, updated_at, source, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         trail_id = excluded.trail_id,
         document_json = excluded.document_json,
         updated_at = excluded.updated_at,
         source = excluded.source,
         deleted_at = NULL`,
      [doc.id, doc.trailId, JSON.stringify(doc), doc.updatedAt, source],
    );
    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK');
    throw e;
  }
}

/**
 * Store a document this device just edited. Unconditional: a local edit is by
 * definition newer than whatever it was made from, and it is the outbox's job
 * to reconcile it with the server.
 */
export async function upsertLocal(db: SqlDatabase, doc: PlanDocument): Promise<void> {
  await write(db, doc, 'local');
}

/**
 * Store a copy that came from the server, last-writer-wins.
 *
 * Fed by `pullPlans` in `sync/comment-sync.ts`, one document per entry of
 * `GET /v1/plans?since=` (a tombstone entry calls `tombstone` instead), and by
 * the drain when a `PUT` comes back with the server's own clock on it.
 *
 * Applied only when nothing is stored for this plan (by id, else the trail's
 * live row) or the incoming `updatedAt` is strictly newer. A stored tombstone
 * counts: a delete made after the server's copy keeps winning until the delete
 * drains.
 *
 * @returns true when the copy was stored, false when the local one won.
 */
export async function upsertServer(db: SqlDatabase, doc: PlanDocument): Promise<boolean> {
  const stored = (await rowById(db, doc.id)) ?? (await liveRow(db, doc.trailId));
  if (stored && !isNewer(doc.updatedAt, stored.updated_at)) return false;
  await write(db, doc, 'server');
  return true;
}

/**
 * Whether `incoming` is a later instant than `stored`. Parsed rather than
 * string-compared: both sides are ISO-8601, but only a shared `Z` suffix makes
 * lexicographic order the same as chronological order, and a plan can be
 * stamped by three clocks (this device, another device, the server). Falls back
 * to a string compare when either side is unparseable, which at least stays
 * deterministic.
 */
function isNewer(incoming: string, stored: string): boolean {
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  if (Number.isNaN(a) || Number.isNaN(b)) return incoming > stored;
  return a > b;
}

/**
 * Store the server's acknowledgement of a document THIS device just sent —
 * same document, server clock — so the local copy is stamped by the one clock
 * last-writer-wins can compare across devices.
 *
 * Unconditional, unlike {@link upsertServer}: by construction this is the
 * newest copy there is, and a device clock running ahead of the server would
 * otherwise keep its own stamp and then discard every browser edit until the
 * clocks crossed. The caller (`sync/comment-sync`'s `applyServerPlan`) is
 * responsible for checking that the stored row is still the document that was
 * sent, and is not a tombstone — this function asks no questions.
 */
export async function upsertServerAck(db: SqlDatabase, doc: PlanDocument): Promise<void> {
  await write(db, doc, 'server');
}

/**
 * Soft-delete a plan: the row stays as a tombstone so the delete can be synced
 * (and so a stale server copy cannot resurrect it), and the partial unique
 * index immediately frees the trail for a new plan.
 */
export async function tombstone(db: SqlDatabase, id: string, now?: string): Promise<void> {
  const at = now ?? new Date().toISOString();
  await db.runAsync('UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
}

/**
 * Apply a delete the SERVER reported, last-writer-wins — the tombstone half of
 * {@link upsertServer}, and the same rule.
 *
 * A pull can carry a delete older than an edit this device has made but not yet
 * sent; applying it unconditionally would throw that edit away, and the queued
 * write would then resurrect the plan server-side. An unknown id is stored
 * nowhere to tombstone, so it is simply ignored.
 *
 * @returns true when the delete was applied, false when the local copy won.
 */
export async function tombstoneFromServer(
  db: SqlDatabase,
  id: string,
  updatedAt: string,
): Promise<boolean> {
  const stored = await rowById(db, id);
  if (!stored || !isNewer(updatedAt, stored.updated_at)) return false;
  await tombstone(db, id, updatedAt);
  return true;
}

/**
 * Hard-delete every plan row for a trail, tombstones included. Called when an
 * imported trail is deleted (`services/imported-trail-store`): its plan is
 * local-only and has nothing to sync, so there is nothing to tombstone for.
 */
export async function deleteForTrail(db: SqlDatabase, trailId: string): Promise<void> {
  await db.runAsync('DELETE FROM plans WHERE trail_id = ?', [trailId]);
}

/**
 * Drop the plans that belonged to the account being erased. Account deletion
 * only — those copies go with the identity rather than lingering to re-sync
 * under a new one. Called by `features/settings/account-deletion.ts`
 * `purgeLocalAccountData`, which also clears the `__plans__` sync mark.
 *
 * `isSynced` is the server boundary (`services/server-trails.isServerKnown`):
 * an imported guide's plan was never on the server and is not the account's to
 * delete — it is device-local content, exactly like the import it belongs to,
 * and Settings promises that content stays.
 *
 * @returns how many trails' plans were dropped.
 */
export async function purgeSynced(
  db: SqlDatabase,
  isSynced: (trailId: string) => boolean,
): Promise<number> {
  const rows = await db.getAllAsync<{ trail_id: string }>('SELECT DISTINCT trail_id FROM plans');
  const trailIds = rows.map((r) => r.trail_id).filter(isSynced);
  for (const trailId of trailIds) await deleteForTrail(db, trailId);
  return trailIds.length;
}
