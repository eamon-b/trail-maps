/**
 * Waypoint meta repository — the local mirror of curated waypoint
 * descriptions pulled from the comments API.
 *
 * Rows are stored exactly as the server sends them, including the empty-string
 * "cleared" tombstone: keeping the row (rather than deleting it) means the
 * high-water-mark delta stays correct and a later re-fill upserts onto the same
 * key. Readers never see a cleared row — `getDescriptions` / `getDescription`
 * filter empties so callers can fall back to the bundled trail description.
 *
 * The description high-water mark lives in `sync_state.meta_synced_at`,
 * independent of the comment cursor (`last_synced_at`).
 */

import type { SqlDatabase } from './sql-database';

/** One curated description row as pulled from the server. */
export interface DescriptionInput {
  waypointId: string;
  /** Empty string means "cleared" — stored, but hidden from readers. */
  description: string;
  updatedAt: string;
}

interface MetaRow {
  waypoint_id: string;
  description: string;
}

/**
 * Insert or update curated descriptions for a trail. Empty descriptions are
 * stored verbatim (they are the server's tombstone) and filtered on read.
 */
export async function upsertDescriptions(
  db: SqlDatabase,
  trailId: string,
  rows: DescriptionInput[],
): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO waypoint_meta (trail_id, waypoint_id, description, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(trail_id, waypoint_id) DO UPDATE SET
         description = excluded.description,
         updated_at = excluded.updated_at`,
      [trailId, row.waypointId, row.description, row.updatedAt],
    );
  }
}

/** Every non-cleared description for a trail, keyed by waypoint id. */
export async function getDescriptions(
  db: SqlDatabase,
  trailId: string,
): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<MetaRow>(
    "SELECT waypoint_id, description FROM waypoint_meta WHERE trail_id = ? AND description <> ''",
    [trailId],
  );
  return new Map(rows.map((row) => [row.waypoint_id, row.description]));
}

/** One waypoint's synced description, or null when absent or cleared. */
export async function getDescription(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ description: string }>(
    `SELECT description FROM waypoint_meta
      WHERE trail_id = ? AND waypoint_id = ? AND description <> ''`,
    [trailId, waypointId],
  );
  return row?.description ?? null;
}

/** The stored description high-water mark for a trail, or undefined. */
export async function readMetaSyncedAt(
  db: SqlDatabase,
  trailId: string,
): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ meta_synced_at: string | null }>(
    'SELECT meta_synced_at FROM sync_state WHERE trail_id = ?',
    [trailId],
  );
  return row?.meta_synced_at ?? undefined;
}

/** Persist the description high-water mark (leaves the comment cursor alone). */
export async function writeMetaSyncedAt(
  db: SqlDatabase,
  trailId: string,
  syncedAt: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_state (trail_id, meta_synced_at) VALUES (?, ?)
     ON CONFLICT(trail_id) DO UPDATE SET meta_synced_at = excluded.meta_synced_at`,
    [trailId, syncedAt],
  );
}
