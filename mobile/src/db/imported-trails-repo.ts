/**
 * Imported-trails repository — the registry of user-imported GPX trails.
 *
 * A row here is a *view* of the real artifact: the trail JSON written to
 * `{documentDir}/trails/{id}.json` by `services/imported-trail-store.ts`. Disk
 * is truth (the tiles pattern); this table exists so the My Guides list can be
 * rendered without parsing every imported trail file, and so an imported id can
 * be recognised (and gated off the server) with one cheap query.
 *
 * Cascade: Tracknotes declares no foreign keys against `trail_id` — bundled
 * trails have no registry row at all, so `favorites`, `routes`/`route_points`,
 * `sync_state`, `comments` and `outbox` all treat `trail_id` as a plain scoping
 * column. Production also never enables `PRAGMA foreign_keys`. `deleteImportedTrail`
 * therefore clears every one of those tables by hand inside a single
 * transaction, the same way `routes-repo.deleteRoute` clears `route_points`.
 */

import type { SqlDatabase } from './sql-database';

/** A registry row for one imported trail. */
export interface ImportedTrail {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  /** Reserved for future provenance (`'imported'` today). */
  source: string;
  /** False when the source GPX carried no usable `<ele>` data. */
  hasElevation: boolean;
  /** Track point count at import time; null when unknown. */
  pointCount: number | null;
  /** Waypoint count at import time; null when unknown. */
  waypointCount: number | null;
  createdAt: string;
}

/** Everything needed to register (or re-register) an imported trail. */
export interface ImportedTrailInput {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  /** Defaults to `'imported'`. */
  source?: string;
  /** Defaults to `true`. */
  hasElevation?: boolean;
  pointCount?: number | null;
  waypointCount?: number | null;
}

interface ImportedTrailRow {
  id: string;
  name: string;
  short_name: string;
  length_km: number;
  source: string;
  has_elevation: number;
  point_count: number | null;
  waypoint_count: number | null;
  created_at: string;
}

function rowToImportedTrail(row: ImportedTrailRow): ImportedTrail {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    lengthKm: row.length_km,
    source: row.source,
    hasElevation: row.has_elevation !== 0,
    pointCount: row.point_count,
    waypointCount: row.waypoint_count,
    createdAt: row.created_at,
  };
}

/** All imported trails, newest first. */
export async function listImportedTrails(db: SqlDatabase): Promise<ImportedTrail[]> {
  // `rowid DESC` is the tiebreaker: two imports landing in the same second
  // share a `created_at`, and rowid preserves insertion order (newest last).
  const rows = await db.getAllAsync<ImportedTrailRow>(
    'SELECT * FROM imported_trails ORDER BY created_at DESC, rowid DESC',
  );
  return rows.map(rowToImportedTrail);
}

/** One imported trail by id, or null when the id is unknown (e.g. bundled). */
export async function getImportedTrail(
  db: SqlDatabase,
  id: string,
): Promise<ImportedTrail | null> {
  const row = await db.getFirstAsync<ImportedTrailRow>(
    'SELECT * FROM imported_trails WHERE id = ?',
    [id],
  );
  return row ? rowToImportedTrail(row) : null;
}

/**
 * Insert or update a registry row.
 *
 * Re-importing the same file yields the same content-hashed id, so this is an
 * upsert rather than an insert: the metadata refreshes while `created_at` (and
 * therefore the list position) is preserved.
 */
export async function upsertImportedTrail(
  db: SqlDatabase,
  row: ImportedTrailInput,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO imported_trails
       (id, name, short_name, length_km, source, has_elevation, point_count, waypoint_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       short_name = excluded.short_name,
       length_km = excluded.length_km,
       source = excluded.source,
       has_elevation = excluded.has_elevation,
       point_count = excluded.point_count,
       waypoint_count = excluded.waypoint_count`,
    [
      row.id,
      row.name,
      row.shortName,
      row.lengthKm,
      row.source ?? 'imported',
      (row.hasElevation ?? true) ? 1 : 0,
      row.pointCount ?? null,
      row.waypointCount ?? null,
    ],
  );
}

/**
 * Delete an imported trail's registry row and every local row scoped to it.
 *
 * Manual cascade (no FK pragma in production): `favorites`, `route_points` via
 * `routes`, `routes`, `sync_state`, `comments`, `outbox`, `waypoint_meta`. All
 * in one transaction so a failure mid-way cannot leave a half-deleted guide.
 * (`guides` is deliberately not swept — it is dead code that nothing writes.)
 *
 * Does NOT touch the trail JSON on disk or the plan-inputs AsyncStorage entry —
 * `services/imported-trail-store.deleteImportedTrailEverywhere` composes those.
 */
export async function deleteImportedTrail(db: SqlDatabase, id: string): Promise<void> {
  await db.execAsync('BEGIN');
  try {
    await db.runAsync(
      'DELETE FROM route_points WHERE route_id IN (SELECT id FROM routes WHERE trail_id = ?)',
      [id],
    );
    await db.runAsync('DELETE FROM routes WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM favorites WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM sync_state WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM comments WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM outbox WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM waypoint_meta WHERE trail_id = ?', [id]);
    await db.runAsync('DELETE FROM imported_trails WHERE id = ?', [id]);
    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK');
    throw e;
  }
}
