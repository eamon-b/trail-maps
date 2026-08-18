/**
 * Routes repository — FarOut-style custom routes, scoped by trail.
 *
 * A route is a name + denormalized stats (total km / ascent / descent computed
 * at save time) plus an ordered list of `route_points`. Points are stored as
 * either 'snap' (on the trail, carrying its cumulative `km`) or 'sketch' (an
 * off-trail tap, `km` NULL). Legs are DERIVED from consecutive points by the
 * caller (see route-geometry) — the repo only persists the raw sequence.
 *
 * Cascade: `route_points.route_id` declares ON DELETE CASCADE, but the app DB
 * does not enable `PRAGMA foreign_keys` in production, so `deleteRoute` also
 * clears the points itself inside the same transaction. The declared cascade
 * still backs the schema test (the better-sqlite3 test adapter enables FKs).
 */

import type { SqlDatabase } from './sql-database';

/** One persisted route vertex. */
export interface RoutePoint {
  seq: number;
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  /** Trail km for snap points; null for off-trail sketch points. */
  km: number | null;
}

/** A saved route row (stats denormalized, no points). */
export interface Route {
  id: string;
  trailId: string;
  name: string;
  totalKm: number;
  ascentM: number;
  descentM: number;
  createdAt: string;
  updatedAt: string;
}

/** Everything needed to persist a new route in one call. */
export interface NewRoute {
  trailId: string;
  name: string;
  totalKm: number;
  ascentM: number;
  descentM: number;
  points: Omit<RoutePoint, 'seq'>[];
}

interface RouteRow {
  id: string;
  trail_id: string;
  name: string;
  total_km: number;
  ascent_m: number;
  descent_m: number;
  created_at: string;
  updated_at: string;
}

interface RoutePointRow {
  seq: number;
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  km: number | null;
}

function rowToRoute(row: RouteRow): Route {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    totalKm: row.total_km,
    ascentM: row.ascent_m,
    descentM: row.descent_m,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Time-ordered, collision-resistant id (no crypto dependency). */
export function generateRouteId(): string {
  return `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist a route and its ordered points (transactional). */
export async function createRoute(db: SqlDatabase, input: NewRoute): Promise<Route> {
  const id = generateRouteId();
  const now = new Date().toISOString();

  await db.execAsync('BEGIN');
  try {
    await db.runAsync(
      `INSERT INTO routes (id, trail_id, name, total_km, ascent_m, descent_m, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.trailId, input.name, input.totalKm, input.ascentM, input.descentM, now, now],
    );
    for (let seq = 0; seq < input.points.length; seq++) {
      const p = input.points[seq];
      await db.runAsync(
        'INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES (?, ?, ?, ?, ?, ?)',
        [id, seq, p.kind, p.lat, p.lon, p.km ?? null],
      );
    }
    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK');
    throw e;
  }

  return {
    id,
    trailId: input.trailId,
    name: input.name,
    totalKm: input.totalKm,
    ascentM: input.ascentM,
    descentM: input.descentM,
    createdAt: now,
    updatedAt: now,
  };
}

/** All routes for a trail, newest first. */
export async function listRoutes(db: SqlDatabase, trailId: string): Promise<Route[]> {
  // `rowid DESC` is the tiebreaker: two routes saved in the same millisecond
  // share a `created_at`, and rowid preserves insertion order (newest last).
  const rows = await db.getAllAsync<RouteRow>(
    'SELECT * FROM routes WHERE trail_id = ? ORDER BY created_at DESC, rowid DESC',
    [trailId],
  );
  return rows.map(rowToRoute);
}

/** One route by id, or null. */
export async function getRoute(db: SqlDatabase, id: string): Promise<Route | null> {
  const row = await db.getFirstAsync<RouteRow>('SELECT * FROM routes WHERE id = ?', [id]);
  return row ? rowToRoute(row) : null;
}

/** Ordered points of a route. */
export async function getRoutePoints(db: SqlDatabase, routeId: string): Promise<RoutePoint[]> {
  const rows = await db.getAllAsync<RoutePointRow>(
    'SELECT seq, kind, lat, lon, km FROM route_points WHERE route_id = ? ORDER BY seq',
    [routeId],
  );
  return rows.map((r) => ({ seq: r.seq, kind: r.kind, lat: r.lat, lon: r.lon, km: r.km }));
}

/** Delete a route and its points (transactional; independent of FK pragma). */
export async function deleteRoute(db: SqlDatabase, id: string): Promise<void> {
  await db.execAsync('BEGIN');
  try {
    await db.runAsync('DELETE FROM route_points WHERE route_id = ?', [id]);
    await db.runAsync('DELETE FROM routes WHERE id = ?', [id]);
    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK');
    throw e;
  }
}
