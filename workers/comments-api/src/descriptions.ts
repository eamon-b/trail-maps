/**
 * Curated waypoint descriptions.
 *
 * Editorial content (not UGC): admins write it, everyone reads it, and clients
 * pull it with the same `since` high-water-mark semantics as the comment bulk
 * endpoint. An empty description is a cleared tombstone rather than a deleted
 * row, so a client that has cached prose learns it was withdrawn.
 */

import { json, readJson } from './http';
import type { Env } from './http';
import { requireAdmin } from './auth';
import { validateDescription, validateTrailId, validateWaypointId } from './validation';
import type {
  TrailDescriptionsResponse,
  WaypointDescription,
} from '../../../src/lib/comments-api-types';

interface DescriptionRow {
  waypoint_id: string;
  description: string;
  updated_at: string;
}

function toWaypointDescription(row: DescriptionRow): WaypointDescription {
  return {
    waypointId: row.waypoint_id,
    description: row.description,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/descriptions — public read (full or delta)
// ---------------------------------------------------------------------------

/** GET /v1/trails/:trailId/descriptions?since=<iso> — unauthenticated. */
export async function getTrailDescriptions(
  request: Request,
  env: Env,
  trailIdRaw: string
): Promise<Response> {
  const trailId = validateTrailId(trailIdRaw);
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const syncedAt = new Date().toISOString();

  const conditions = ['trail_id = ?'];
  const binds: unknown[] = [trailId];
  if (since) {
    conditions.push('updated_at > ?');
    binds.push(since);
  }

  const { results } = await env.DB.prepare(
    `SELECT waypoint_id, description, updated_at
       FROM waypoint_descriptions
      WHERE ${conditions.join(' AND ')}
      ORDER BY waypoint_id ASC`
  )
    .bind(...binds)
    .all<DescriptionRow>();

  const payload: TrailDescriptionsResponse = {
    descriptions: results.map(toWaypointDescription),
    syncedAt,
  };
  return json(payload);
}

// ---------------------------------------------------------------------------
// PUT /v1/admin/trails/:trailId/descriptions/:waypointId — admin upsert
// ---------------------------------------------------------------------------

/** PUT a curated description for one waypoint. Empty string clears it. */
export async function upsertTrailDescription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trailIdRaw: string,
  waypointIdRaw: string
): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const trailId = validateTrailId(trailIdRaw);
  const waypointId = validateWaypointId(waypointIdRaw);

  const body = await readJson(request);
  const description = validateDescription(body.description);
  const now = new Date().toISOString();

  const row = await env.DB.prepare(
    `INSERT INTO waypoint_descriptions (trail_id, waypoint_id, description, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(trail_id, waypoint_id) DO UPDATE
       SET description = excluded.description, updated_at = excluded.updated_at
     RETURNING waypoint_id, description, updated_at`
  )
    .bind(trailId, waypointId, description, now)
    .first<DescriptionRow>();

  if (!row) {
    // RETURNING always yields a row for an upsert; belt-and-braces for typing.
    return json({ waypointId, description, updatedAt: now } satisfies WaypointDescription);
  }
  return json(toWaypointDescription(row));
}
