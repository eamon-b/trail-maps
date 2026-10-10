/**
 * Hiker-added waypoints (`@lib/user-waypoints`) — schema v7 `user_waypoints`.
 *
 * Private rows are the only copy anywhere. Shared rows mirror the server the
 * way `comments` does: this device's own write is `source='local'` until the
 * outbox drain confirms it, and a pull never overwrites a `local` row — the
 * queued write is newer than anything the server can have.
 */

import type { SharedWaypoint } from '@lib/comments-api-types';
import {
  isUserWaypointType,
  type UserWaypoint,
  type UserWaypointVisibility,
} from '@lib/user-waypoints';
import type { SqlDatabase } from './sql-database';

export type UserWaypointSource = 'local' | 'server';

interface Row {
  id: string;
  trail_id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  description: string;
  visibility: UserWaypointVisibility;
  mine: number;
  author_name: string | null;
  source: UserWaypointSource;
  created_at: string;
  updated_at: string;
}

export interface StoredUserWaypoint extends UserWaypoint {
  source: UserWaypointSource;
}

function toWaypoint(row: Row): StoredUserWaypoint | null {
  // A type this build does not offer (a newer app's, synced down): skip it
  // rather than show a place as something it is not.
  if (!isUserWaypointType(row.type)) return null;
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lon: row.lon,
    description: row.description,
    visibility: row.visibility,
    mine: row.mine === 1,
    authorName: row.author_name,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every hiker waypoint on a trail, oldest first. */
export async function listForTrail(db: SqlDatabase, trailId: string): Promise<StoredUserWaypoint[]> {
  const rows = await db.getAllAsync<Row>(
    'SELECT * FROM user_waypoints WHERE trail_id = ? ORDER BY created_at, id',
    [trailId],
  );
  return rows.map(toWaypoint).filter((w): w is StoredUserWaypoint => w !== null);
}

export async function getById(db: SqlDatabase, id: string): Promise<StoredUserWaypoint | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM user_waypoints WHERE id = ?', [id]);
  return row ? toWaypoint(row) : null;
}

/** Store this device's own create or edit (`source='local'`). */
export async function saveLocal(db: SqlDatabase, waypoint: UserWaypoint): Promise<void> {
  await db.runAsync(
    `INSERT INTO user_waypoints
       (id, trail_id, name, type, lat, lon, description, visibility, mine, author_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       lat = excluded.lat,
       lon = excluded.lon,
       description = excluded.description,
       visibility = excluded.visibility,
       author_name = excluded.author_name,
       source = 'local',
       updated_at = excluded.updated_at`,
    [
      waypoint.id,
      waypoint.trailId,
      waypoint.name,
      waypoint.type,
      waypoint.lat,
      waypoint.lon,
      waypoint.description,
      waypoint.visibility,
      waypoint.mine ? 1 : 0,
      waypoint.authorName,
      waypoint.createdAt,
      waypoint.updatedAt,
    ],
  );
}

/**
 * Mirror a pulled shared waypoint. A row this device has a write queued for
 * (`source='local'`) is left alone; so is a private row that happens to share
 * the id (it cannot, short of a uuid collision, but a pull must never publish
 * or overwrite a private note). `mine` is the server's word when it gave one,
 * else whatever the row already said.
 */
export async function applyServer(db: SqlDatabase, entry: SharedWaypoint): Promise<void> {
  await db.runAsync(
    `INSERT INTO user_waypoints
       (id, trail_id, name, type, lat, lon, description, visibility, mine, author_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', ?, ?, 'server', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       lat = excluded.lat,
       lon = excluded.lon,
       description = excluded.description,
       mine = CASE WHEN ? IS NULL THEN user_waypoints.mine ELSE excluded.mine END,
       author_name = excluded.author_name,
       updated_at = excluded.updated_at
     WHERE user_waypoints.source = 'server' AND user_waypoints.visibility = 'shared'`,
    [
      entry.id,
      entry.trailId,
      entry.name,
      entry.type,
      entry.lat,
      entry.lon,
      entry.description,
      entry.mine ? 1 : 0,
      entry.displayName,
      entry.createdAt,
      entry.updatedAt,
      entry.mine === undefined ? null : 1,
    ],
  );
}

/** The server confirmed this device's write: it is the server's copy now. */
export async function confirmServer(
  db: SqlDatabase,
  id: string,
  server: { displayName: string; updatedAt: string },
): Promise<void> {
  await db.runAsync(
    `UPDATE user_waypoints SET source = 'server', author_name = ?, updated_at = ?
      WHERE id = ? AND visibility = 'shared'`,
    [server.displayName, server.updatedAt, id],
  );
}

/** Remove a waypoint outright (a delete, or a server tombstone for a shared one). */
export async function deleteById(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM user_waypoints WHERE id = ?', [id]);
}

/**
 * A server tombstone: drops someone else's shared copy, never a private row.
 * One of this account's own (hidden by reports or an admin) is kept as a
 * private waypoint instead: it may be the only record of a place the hiker
 * marked, and only everyone else should lose it.
 */
export async function applyTombstone(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync(
    "DELETE FROM user_waypoints WHERE id = ? AND visibility = 'shared' AND mine = 0",
    [id],
  );
  await keepAsPrivate(db, id);
}

/**
 * The server will not take this account's shared waypoint (an admin or reports
 * hid it): it stays on this phone as a private one.
 */
export async function keepAsPrivate(db: SqlDatabase, id: string): Promise<void> {
  await db.runAsync(
    `UPDATE user_waypoints SET visibility = 'private', author_name = NULL, source = 'local'
      WHERE id = ? AND visibility = 'shared' AND mine = 1`,
    [id],
  );
}

export async function readSyncedAt(db: SqlDatabase, trailId: string): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ waypoints_synced_at: string | null }>(
    'SELECT waypoints_synced_at FROM sync_state WHERE trail_id = ?',
    [trailId],
  );
  return row?.waypoints_synced_at ?? undefined;
}

export async function writeSyncedAt(db: SqlDatabase, trailId: string, syncedAt: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_state (trail_id, waypoints_synced_at) VALUES (?, ?)
     ON CONFLICT(trail_id) DO UPDATE SET waypoints_synced_at = excluded.waypoints_synced_at`,
    [trailId, syncedAt],
  );
}
