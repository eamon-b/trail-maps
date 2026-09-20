/**
 * The plans half of the API, as the web planner uses it.
 *
 * One plan per trail per user, so the reads here are narrower than the mobile
 * client's: the planner only ever wants "my plan for this trail", and gets it
 * by walking the same delta-sync feed the phone drains (`GET /v1/plans`) and
 * picking the live entry for the trail in hand.
 *
 * Every call takes the session explicitly rather than reading storage, so a
 * caller cannot accidentally issue an authenticated request with whatever
 * token happens to be lying in `localStorage`.
 */

import type { PlanDocument } from '@lib/plan-types';
import type {
  PlanSyncEntry,
  PlansSyncResponse,
  PutPlanRequest,
  SharePlanResponse,
  SharedPlanResponse,
} from '@lib/comments-api-types';
import { isPlanTombstone } from '@lib/comments-api-types';
import { apiRequest, type FetchLike } from './client';
import type { WebSession } from './session';

export interface PlanApiDeps {
  fetchImpl?: FetchLike;
}

/** Pages this client asks for at a time. One page covers any realistic account. */
const PAGE_LIMIT = 200;

/** Pages walked before giving up — a guard against a cursor that never ends. */
const MAX_PAGES = 20;

/** What the server holds for one trail: the live plan, or nothing. */
export interface MyPlanResult {
  entry: PlanSyncEntry | null;
  /** Server clock at query time. */
  syncedAt: string;
}

/**
 * This user's live plan for `trailId`, or null.
 *
 * Walks every page of the feed (the cursor is keyset, ascending by
 * `updated_at`) because the wanted plan may be on any of them, and takes the
 * last live entry for the trail — later pages are more recently updated, and a
 * tombstone for the same trail means it was deleted after that.
 */
export async function fetchMyPlan(
  session: WebSession,
  trailId: string,
  deps: PlanApiDeps = {},
): Promise<MyPlanResult> {
  let cursor: string | null = null;
  let entry: PlanSyncEntry | null = null;
  let syncedAt = new Date().toISOString();

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const response: PlansSyncResponse = await apiRequest<PlansSyncResponse>(
      `/v1/plans?${query.toString()}`,
      { token: session.token, fetchImpl: deps.fetchImpl },
    );
    syncedAt = response.syncedAt;

    for (const row of response.plans) {
      if (row.trailId !== trailId) continue;
      // A tombstone for this trail clears whatever an earlier page offered:
      // the feed is in update order, so the last word wins.
      entry = isPlanTombstone(row) ? null : row;
    }

    cursor = response.nextCursor;
    if (!cursor) break;
  }

  return { entry, syncedAt };
}

/**
 * Store the document, creating or replacing this user's plan under its id.
 *
 * `updatedAt` is stripped: it is the server's clock, and sending ours back
 * would invite a client with a fast clock to win every conflict. The response
 * carries the stored document with the server's stamp on it.
 */
export async function putPlan(
  session: WebSession,
  document: PlanDocument,
  deps: PlanApiDeps = {},
): Promise<PlanSyncEntry> {
  // Field by field rather than a rest-spread: this is the wire shape, and
  // anything a future field adds to the document should be a deliberate
  // addition here rather than something that leaks out on its own.
  const body: PutPlanRequest = {
    id: document.id,
    trailId: document.trailId,
    name: document.name,
    direction: document.direction,
    startDate: document.startDate,
    stops: document.stops,
    version: document.version,
    ...(document.resupplyStops === undefined ? {} : { resupplyStops: document.resupplyStops }),
  };
  return apiRequest<PlanSyncEntry>(`/v1/plans/${encodeURIComponent(document.id)}`, {
    method: 'PUT',
    token: session.token,
    body,
    fetchImpl: deps.fetchImpl,
  });
}

/** Mint (or replay) the public read-only link for a plan. */
export async function sharePlan(
  session: WebSession,
  planId: string,
  deps: PlanApiDeps = {},
): Promise<SharePlanResponse> {
  return apiRequest<SharePlanResponse>(`/v1/plans/${encodeURIComponent(planId)}/share`, {
    method: 'POST',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/** Revoke the public link. Idempotent: an unshared plan is a 204 too. */
export async function unsharePlan(
  session: WebSession,
  planId: string,
  deps: PlanApiDeps = {},
): Promise<void> {
  await apiRequest<void>(`/v1/plans/${encodeURIComponent(planId)}/share`, {
    method: 'DELETE',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * Read a shared plan. Public: no token, and none may be sent — the share id is
 * the whole credential, and it belongs to someone who is not necessarily this
 * browser's user.
 */
export async function fetchSharedPlan(
  shareId: string,
  deps: PlanApiDeps = {},
): Promise<SharedPlanResponse> {
  return apiRequest<SharedPlanResponse>(`/v1/shared/plans/${encodeURIComponent(shareId)}`, {
    fetchImpl: deps.fetchImpl,
  });
}
