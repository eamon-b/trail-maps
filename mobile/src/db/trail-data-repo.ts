/**
 * Every SQLite row scoped to one trail id, cleared by hand.
 *
 * Tracknotes declares no foreign keys against `trail_id` (bundled trails have
 * no registry row to point at) and production never enables
 * `PRAGMA foreign_keys`, so nothing but these DELETEs removes a guide's rows:
 * `route_points` via `routes`, `routes`, `favorites`, `sync_state`,
 * `comments`, `outbox`, `waypoint_meta` and `user_waypoints`. (`plans` has its own repo,
 * `plans-repo.deleteForTrail`; `guides` is dead code that nothing writes.)
 *
 * Used when a guide leaves the phone: an imported trail deleted
 * (`imported-trails-repo.deleteImportedTrail`, inside its transaction) and a
 * community route removed (`services/local-trail-data.deleteLocalTrailData`).
 */

import type { SqlDatabase } from './sql-database';

/**
 * Delete every row scoped to `trailId`. Runs the statements as they are: the
 * caller wraps them in `withTransaction` (which is not re-entrant, so this
 * cannot open its own).
 */
export async function deleteTrailScopedRows(db: SqlDatabase, trailId: string): Promise<void> {
  await db.runAsync(
    'DELETE FROM route_points WHERE route_id IN (SELECT id FROM routes WHERE trail_id = ?)',
    [trailId],
  );
  await db.runAsync('DELETE FROM routes WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM favorites WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM sync_state WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM comments WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM outbox WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM waypoint_meta WHERE trail_id = ?', [trailId]);
  await db.runAsync('DELETE FROM user_waypoints WHERE trail_id = ?', [trailId]);
}
