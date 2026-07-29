/**
 * Comments API surface: the per-waypoint feed, the trail-wide bulk/delta sync,
 * and the authenticated write endpoints (idempotent PUT create, DELETE).
 *
 * `listTrailComments` auto-paginates: it follows `nextCursor` until exhausted
 * and returns the flattened entries plus the server's `syncedAt` from the first
 * page (the safe high-water mark to persist for the next delta — see
 * `sync/comment-sync`).
 */

import type {
  BulkSyncResponse,
  FeedComment,
  FeedResponse,
  PutCommentRequest,
  SyncEntry,
} from '@lib/comments-api-types';
import { apiRequest, type FetchLike } from './client';

export interface ApiContext {
  baseUrl: string;
  fetchImpl?: FetchLike;
  token?: string;
}

export interface ListWaypointCommentsParams {
  trailId: string;
  waypointId: string;
  limit?: number;
  cursor?: string;
}

/** GET one page of a waypoint's public feed (newest-first). */
export async function listWaypointComments(
  ctx: ApiContext,
  params: ListWaypointCommentsParams,
): Promise<FeedResponse> {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const query = qs.toString();
  const path =
    `/v1/trails/${encodeURIComponent(params.trailId)}` +
    `/waypoints/${encodeURIComponent(params.waypointId)}/comments` +
    (query ? `?${query}` : '');
  return apiRequest<FeedResponse>(path, { baseUrl: ctx.baseUrl, fetchImpl: ctx.fetchImpl });
}

export interface ListTrailCommentsParams {
  trailId: string;
  /** ISO high-water mark; when set the response includes tombstones. */
  since?: string;
  /** Per-page limit passed through to the server. */
  limit?: number;
}

export interface TrailCommentsResult {
  entries: SyncEntry[];
  /** Server clock from the FIRST page — persist as the next `since`. */
  syncedAt: string;
}

/**
 * Fetch ALL trail-wide entries (auto-paginating one request per page). In delta
 * mode (`since` set) the entries include tombstones; in snapshot mode they are
 * live rows only.
 */
export async function listTrailComments(
  ctx: ApiContext,
  params: ListTrailCommentsParams,
): Promise<TrailCommentsResult> {
  const entries: SyncEntry[] = [];
  let cursor: string | null = null;
  let syncedAt: string | null = null;

  do {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (cursor) qs.set('cursor', cursor);
    const query = qs.toString();
    const path =
      `/v1/trails/${encodeURIComponent(params.trailId)}/comments` + (query ? `?${query}` : '');

    const page: BulkSyncResponse = await apiRequest<BulkSyncResponse>(path, {
      baseUrl: ctx.baseUrl,
      fetchImpl: ctx.fetchImpl,
    });
    entries.push(...page.comments);
    // The earliest page's clock is the conservative high-water mark: anything
    // updated during pagination will be re-fetched next time (idempotent).
    if (syncedAt === null) syncedAt = page.syncedAt;
    cursor = page.nextCursor;
  } while (cursor);

  return { entries, syncedAt: syncedAt ?? new Date(0).toISOString() };
}

/**
 * Idempotently create a comment. `id` is the client-minted UUID v4 that becomes
 * the server id; replaying the same id returns the stored row (200) rather than
 * creating a duplicate.
 */
export async function putComment(
  ctx: ApiContext,
  id: string,
  payload: PutCommentRequest,
): Promise<FeedComment> {
  return apiRequest<FeedComment>(`/v1/comments/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'PUT',
    body: payload,
  });
}

/** Soft-delete a comment (owner or admin). 204 on success; idempotent. */
export async function deleteComment(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(`/v1/comments/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}
