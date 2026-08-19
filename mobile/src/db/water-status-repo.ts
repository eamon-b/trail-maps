/**
 * Water-report reads for the aggregated water-status chip.
 *
 * Water reports are not their own table: they are the `comments` rows that
 * carry a `water_status`. The chip needs every such row for a trail (not one
 * waypoint at a time, or the list/map would issue a query per marker), so this
 * repo is a single trail-scoped, window-bounded read. Ranking lives in
 * `features/guide/water-aggregate` — nothing here interprets the rows.
 *
 * Freshness time is `COALESCE(observed_at, created_at)`: the reporter's own
 * observation time when they gave one, else when the comment was written. Both
 * are stored as UTC ISO-8601, which sorts and compares lexicographically, so the
 * window bound is a plain string comparison.
 */

import type { WaterStatus } from '@lib/comments-api-types';
import type { SqlDatabase } from './sql-database';

/** One water report, keyed to its waypoint. */
export interface WaterReportRow {
  waypointId: string;
  waterStatus: WaterStatus;
  observedAt: string | null;
  createdAt: string;
}

interface Row {
  waypoint_id: string;
  water_status: WaterStatus;
  observed_at: string | null;
  created_at: string;
}

/**
 * Every water report for a trail whose freshness time is at or after
 * `sinceIso` (the caller's window start — see `waterWindowStartIso`).
 *
 * Rows are returned newest-first per waypoint; aggregation is order-independent,
 * but a stable order keeps tests and any future "latest report" read simple.
 * Locally-composed rows (`source='local'`) are included on purpose: the hiker's
 * own just-filed report should move the chip immediately, before it syncs.
 */
export async function listWaterReportsByTrail(
  db: SqlDatabase,
  trailId: string,
  sinceIso: string,
): Promise<WaterReportRow[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT waypoint_id, water_status, observed_at, created_at
       FROM comments
      WHERE trail_id = ?
        AND water_status IS NOT NULL
        AND COALESCE(observed_at, created_at) >= ?
      ORDER BY waypoint_id ASC, COALESCE(observed_at, created_at) DESC`,
    [trailId, sinceIso],
  );
  return rows.map((row) => ({
    waypointId: row.waypoint_id,
    waterStatus: row.water_status,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  }));
}
