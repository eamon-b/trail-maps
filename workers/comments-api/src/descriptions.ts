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
import { appendSinceFilter } from './cursor';
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
    appendSinceFilter(conditions, binds, 'updated_at', since);
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

/**
 * PUT a curated description for one waypoint. Empty string clears it.
 *
 * Re-sending the text a waypoint already has is a no-op: `updated_at` is what
 * every phone's delta pull keys on, and `upload-descriptions` re-PUTs the whole
 * curated file each run, so bumping it unconditionally re-shipped every
 * description to every phone on every upload. The conflict update only fires
 * when the text differs; otherwise the stored row is answered as it stands.
 */
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
       WHERE excluded.description <> waypoint_descriptions.description
     RETURNING waypoint_id, description, updated_at`
  )
    .bind(trailId, waypointId, description, now)
    .first<DescriptionRow>();
  if (row) return json(toWaypointDescription(row));

  // No RETURNING row: the conflict update's WHERE held it back, i.e. the text
  // was already this. Answer with the row as stored, its original stamp intact.
  const unchanged = await env.DB.prepare(
    `SELECT waypoint_id, description, updated_at
       FROM waypoint_descriptions WHERE trail_id = ? AND waypoint_id = ?`
  )
    .bind(trailId, waypointId)
    .first<DescriptionRow>();
  if (!unchanged) {
    // Unreachable short of a concurrent hard delete (nothing deletes rows).
    return json({ waypointId, description, updatedAt: now } satisfies WaypointDescription);
  }
  return json(toWaypointDescription(unchanged));
}
