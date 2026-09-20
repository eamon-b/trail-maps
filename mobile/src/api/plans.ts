/**
 * Plans API surface — the day planner's private, per-user documents.
 *
 * Deliberately shaped like `api/comments.ts`: the same `ApiContext`, the same
 * auto-paginating delta read, the same "one function per route, no state" rule.
 * The differences are all consequences of a plan being private rather than
 * public:
 *
 *  - every route except {@link fetchSharedPlan} is authenticated, so `ctx.token`
 *    is required rather than optional;
 *  - the delta feed is user-scoped (`GET /v1/plans`), not trail-scoped — one
 *    pull brings every trail's plan, which is why the high-water mark lives on
 *    the `__plans__` sentinel row rather than per trail;
 *  - the write is a FULL REPLACE (`PUT /v1/plans/:id` with the whole document
 *    minus `updatedAt`, which the server stamps), so a queued write always
 *    carries the newest document and never a patch that could apply twice.
 *
 * `syncedAt` comes from the FIRST page, exactly as `listTrailComments` does: a
 * plan updated while we were paginating is then re-fetched next time instead of
 * being skipped, and re-applying a plan is idempotent.
 */

import type {
  PlanSyncEntry,
  PlanSyncEntryUnion,
  PlansSyncResponse,
  PutPlanRequest,
  SharePlanResponse,
  SharedPlanResponse,
} from '@lib/comments-api-types';
import type { PlanDocument } from '@lib/plan-types';
import { ApiError, apiRequest, type FetchLike } from './client';

/** Same context object the comments API takes (token required for plan routes). */
export interface ApiContext {
  baseUrl: string;
  fetchImpl?: FetchLike;
  token?: string;
}

export interface ListPlansParams {
  /** ISO high-water mark; when set the response includes tombstones. */
  since?: string;
  /** Per-page limit passed through to the server. */
  limit?: number;
}

export interface PlansResult {
  entries: PlanSyncEntryUnion[];
  /** Server clock from the FIRST page — persist as the next `since`. */
  syncedAt: string;
}

/**
 * Fetch ALL of this user's plans (auto-paginating one request per page). In
 * delta mode (`since` set) the entries include tombstones; in snapshot mode
 * they are live rows only.
 */
export async function listPlans(ctx: ApiContext, params: ListPlansParams = {}): Promise<PlansResult> {
  const entries: PlanSyncEntryUnion[] = [];
  let cursor: string | null = null;
  let syncedAt: string | null = null;

  do {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (cursor) qs.set('cursor', cursor);
    const query = qs.toString();
    const path = `/v1/plans${query ? `?${query}` : ''}`;

    const page: PlansSyncResponse = await apiRequest<PlansSyncResponse>(path, {
      baseUrl: ctx.baseUrl,
      fetchImpl: ctx.fetchImpl,
      token: ctx.token,
    });
    entries.push(...(page.plans ?? []));
    if (syncedAt === null) syncedAt = page.syncedAt;
    cursor = page.nextCursor;
  } while (cursor);

  return { entries, syncedAt: syncedAt ?? new Date(0).toISOString() };
}

/**
 * Store the document (create or full replace). `updatedAt` is stripped: it is
 * the SERVER's clock, and sending ours would let a phone with a skewed clock
 * win a last-writer-wins race it should have lost.
 *
 * 201 on create, 200 on replace/replay. 409 `plan_exists` means this account
 * already holds a different plan id for the trail — see {@link planExistsId}.
 */
export async function putPlan(ctx: ApiContext, doc: PlanDocument): Promise<PlanSyncEntry> {
  const { updatedAt: _updatedAt, ...body } = doc;
  const payload: PutPlanRequest = body;
  return apiRequest<PlanSyncEntry>(`/v1/plans/${encodeURIComponent(doc.id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'PUT',
    body: payload,
  });
}

/**
 * The id of the plan the server says already holds this trail, or undefined.
 *
 * The 409 body carries `existingId` alongside the usual error envelope, and
 * adopting it is the whole recovery: two devices that each minted a document
 * for the same trail converge on the server's id instead of fighting.
 */
export function planExistsId(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== 'plan_exists') return undefined;
  const body = err.body as { existingId?: unknown } | undefined;
  return typeof body?.existingId === 'string' ? body.existingId : undefined;
}

/** Soft-delete a plan (tombstone). 204 on success; idempotent, 404 when unknown. */
export async function deletePlan(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(`/v1/plans/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}

/** Mint (or replay) the public read-only share link for a plan. */
export async function sharePlan(ctx: ApiContext, id: string): Promise<SharePlanResponse> {
  return apiRequest<SharePlanResponse>(`/v1/plans/${encodeURIComponent(id)}/share`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'POST',
  });
}

/** Revoke a plan's share link. 204; idempotent when nothing was shared. */
export async function unsharePlan(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(`/v1/plans/${encodeURIComponent(id)}/share`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}

/**
 * Read a shared plan by its share id. PUBLIC: no token is sent, because the
 * share link is the whole credential and the reader is usually not the owner
 * (that is the point of sharing it).
 */
export async function fetchSharedPlan(
  ctx: ApiContext,
  shareId: string,
): Promise<SharedPlanResponse> {
  return apiRequest<SharedPlanResponse>(`/v1/shared/plans/${encodeURIComponent(shareId)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
  });
}
