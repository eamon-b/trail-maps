/**
 * Shared hiker waypoints (`@lib/user-waypoints`): the idempotent write
 * endpoints the outbox drains against, and the per-trail full/delta read the
 * pull uses. Private waypoints never reach this module.
 */

import type {
  PutSharedWaypointRequest,
  ReportSharedWaypointRequest,
  SharedWaypoint,
  SharedWaypointsResponse,
} from '@lib/comments-api-types';
import { apiRequest } from './client';
import type { ApiContext } from './comments';

/** Create a shared waypoint, or the owner's edit of one. `id` is the `hw_` id. */
export async function putSharedWaypoint(
  ctx: ApiContext,
  id: string,
  payload: PutSharedWaypointRequest,
): Promise<SharedWaypoint> {
  return apiRequest<SharedWaypoint>(`/v1/waypoints/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'PUT',
    body: payload,
  });
}

/** Soft-delete a shared waypoint (owner or admin). 204; idempotent. */
export async function deleteSharedWaypoint(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(`/v1/waypoints/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}

/** Report someone else's shared waypoint. 201 first, 200 repeat; 404/410 gone. */
export async function reportSharedWaypoint(
  ctx: ApiContext,
  id: string,
  payload: ReportSharedWaypointRequest,
): Promise<void> {
  await apiRequest<unknown>(`/v1/waypoints/${encodeURIComponent(id)}/report`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'POST',
    body: payload,
  });
}

/**
 * Every shared waypoint on a trail (or, with `since`, what changed since, with
 * tombstones). The token is optional and only marks which are the caller's own.
 */
export async function listTrailSharedWaypoints(
  ctx: ApiContext,
  params: { trailId: string; since?: string },
): Promise<SharedWaypointsResponse> {
  const query = params.since ? `?since=${encodeURIComponent(params.since)}` : '';
  return apiRequest<SharedWaypointsResponse>(
    `/v1/trails/${encodeURIComponent(params.trailId)}/waypoints${query}`,
    { baseUrl: ctx.baseUrl, fetchImpl: ctx.fetchImpl, token: ctx.token },
  );
}
