/**
 * Favorites repository — starred waypoints, keyed by (trail_id, waypoint_id).
 *
 * Favorites are purely local (no server round-trip): a small set the guide
 * hydrates on open and the detail screen toggles. Surfacing on the map /
 * profile is Phase 4; this repo only backs the heart and the list-row badge.
 */

import type { SqlDatabase } from './sql-database';

interface FavoriteRow {
  waypoint_id: string;
}

/** Add or remove a star; returns the resulting state (`true` = now favorite). */
export async function toggle(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<boolean> {
  const existing = await isFavorite(db, trailId, waypointId);
  if (existing) {
    await db.runAsync('DELETE FROM favorites WHERE trail_id = ? AND waypoint_id = ?', [
      trailId,
      waypointId,
    ]);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO favorites (trail_id, waypoint_id) VALUES (?, ?)',
    [trailId, waypointId],
  );
  return true;
}

/** Whether a waypoint is starred. */
export async function isFavorite(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<boolean> {
  const row = await db.getFirstAsync<FavoriteRow>(
    'SELECT waypoint_id FROM favorites WHERE trail_id = ? AND waypoint_id = ?',
    [trailId, waypointId],
  );
  return row !== null;
}

/** All starred waypoint ids for a trail. */
export async function list(db: SqlDatabase, trailId: string): Promise<string[]> {
  const rows = await db.getAllAsync<FavoriteRow>(
    'SELECT waypoint_id FROM favorites WHERE trail_id = ? ORDER BY created_at DESC',
    [trailId],
  );
  return rows.map((r) => r.waypoint_id);
}
