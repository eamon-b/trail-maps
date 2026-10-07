/**
 * Community routes API surface (`plans/community-routes.md`, worker
 * `workers/comments-api/src/community*.ts`).
 *
 * Same shape as `api/plans.ts`: one function per route, no state, the same
 * `ApiContext`. The public list is the only route that never sends a token;
 * the detail sends one when it has it (an owner sees their own hidden route and
 * `isOwner`), and every write requires a user token — the phone's primary one
 * or a browser's linked one, which the worker accepts alike.
 */

import type {
  CommunityCheck,
  CommunityListResponse,
  CommunityPatchRequest,
  CommunityReportReason,
  CommunityRouteDetail,
  CommunitySubmitRequest,
} from '@lib/community-types';
import { ApiError, apiRequest, type FetchLike } from './client';

export interface ApiContext {
  baseUrl: string;
  fetchImpl?: FetchLike;
  token?: string;
  /** Fetch cache mode for reads (`'no-store'` when the answer decides a deletion). */
  cache?: RequestCache;
}

export interface ListCommunityParams {
  country?: string;
  state?: string;
  status?: 'unverified' | 'verified';
}

function routePath(id: string): string {
  return `/v1/community/routes/${encodeURIComponent(id)}`;
}

/**
 * Most pages one list fetch follows. Past this the result is marked
 * incomplete rather than fetched on: a runaway cursor must not keep a launch
 * refresh going.
 */
export const MAX_COMMUNITY_LIST_PAGES = 20;

interface ListPage<T> {
  routes?: T[];
  nextCursor?: string | null;
}

/**
 * Follow a keyset-paged list (`?cursor=` in, `nextCursor` out) to its end.
 * A server that sends no `nextCursor` is one page. `complete` is false when
 * the walk stopped early — the page cap, a cursor seen before, or a later page
 * not in the list format — so the caller must not read absence as removal.
 * Null `routes` when the first page itself is not a list.
 */
async function followListPages<T>(
  fetchPage: (cursor: string | null) => Promise<ListPage<T> | null | undefined>,
): Promise<{ routes: T[] | null; complete: boolean }> {
  const routes: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_COMMUNITY_LIST_PAGES; page++) {
    const res = await fetchPage(cursor);
    if (!Array.isArray(res?.routes)) {
      return page === 0 ? { routes: null, complete: false } : { routes, complete: false };
    }
    routes.push(...res.routes);
    const next = res.nextCursor;
    if (typeof next !== 'string' || next === '') return { routes, complete: true };
    if (seen.has(next)) return { routes, complete: false };
    seen.add(next);
    cursor = next;
  }
  return { routes, complete: false };
}

/** The whole public list, every page of it, and whether every page was read. */
export interface CommunityListResult {
  routes: CommunityListResponse['routes'];
  /**
   * False when the walk stopped before the last page
   * ({@link MAX_COMMUNITY_LIST_PAGES}, a repeated cursor, a bad page): a route
   * missing from `routes` may simply not have been fetched.
   */
  complete: boolean;
}

/**
 * The public list (`unverified` + `verified`), every page (`nextCursor`). Never
 * sends a token, and is always fetched `no-store`: the worker sends
 * `max-age=60`, and a stale list is what marks downloaded routes as taken down.
 * Throws when the first page is not a list.
 */
export async function listCommunityRoutes(
  ctx: ApiContext,
  params: ListCommunityParams = {},
): Promise<CommunityListResult> {
  const { routes, complete } = await followListPages<CommunityListResponse['routes'][number]>(
    (cursor) => {
      const qs = new URLSearchParams();
      if (params.country) qs.set('country', params.country);
      if (params.state) qs.set('state', params.state);
      if (params.status) qs.set('status', params.status);
      if (cursor) qs.set('cursor', cursor);
      const query = qs.toString();
      return apiRequest<CommunityListResponse>(`/v1/community/routes${query ? `?${query}` : ''}`, {
        baseUrl: ctx.baseUrl,
        fetchImpl: ctx.fetchImpl,
        cache: ctx.cache ?? 'no-store',
      });
    },
  );
  if (!routes) throw new Error('The community list is not in a format this app reads');
  return { routes, complete };
}

/** One route. The token is optional: with it, an owner also sees `isOwner` and the review. */
export async function getCommunityRoute(
  ctx: ApiContext,
  id: string,
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>(routePath(id), {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    ...(ctx.cache ? { cache: ctx.cache } : {}),
  });
}

/**
 * Submit a route. 201 with the new route; 422 `checks_failed` (see
 * {@link failedChecks}); 409 duplicate; 429 over the daily limit.
 */
export async function submitCommunityRoute(
  ctx: ApiContext,
  body: CommunitySubmitRequest,
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>('/v1/community/routes', {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'POST',
    body,
  });
}

/** Edit an owned route's metadata. */
export async function patchCommunityRoute(
  ctx: ApiContext,
  id: string,
  body: CommunityPatchRequest,
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>(routePath(id), {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'PATCH',
    body,
  });
}

/** Remove an owned route (owner or admin). */
export async function deleteCommunityRoute(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(routePath(id), {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}

/** Report a route. */
export async function reportCommunityRoute(
  ctx: ApiContext,
  id: string,
  report: { reason: CommunityReportReason; note?: string | null },
): Promise<void> {
  await apiRequest<unknown>(`${routePath(id)}/report`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'POST',
    body: { reason: report.reason, note: report.note ?? null },
  });
}

/**
 * This user's submissions, any status, with checks and review — every page
 * (`nextCursor`), up to {@link MAX_COMMUNITY_LIST_PAGES}.
 */
export async function listMyCommunityRoutes(ctx: ApiContext): Promise<CommunityRouteDetail[]> {
  const { routes } = await followListPages<CommunityRouteDetail>((cursor) =>
    apiRequest<ListPage<CommunityRouteDetail>>(
      `/v1/me/community/routes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      {
        baseUrl: ctx.baseUrl,
        fetchImpl: ctx.fetchImpl,
        token: ctx.token,
      },
    ),
  );
  return routes ?? [];
}

/** The server's check results from a 422 `checks_failed`, or undefined for any other error. */
export function failedChecks(err: unknown): CommunityCheck[] | undefined {
  if (!(err instanceof ApiError) || err.status !== 422) return undefined;
  const checks = (err.body as { checks?: unknown } | undefined)?.checks;
  if (!Array.isArray(checks)) return undefined;
  return checks.filter(
    (c): c is CommunityCheck =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as CommunityCheck).id === 'string' &&
      typeof (c as CommunityCheck).message === 'string' &&
      ['pass', 'warn', 'fail'].includes((c as CommunityCheck).level),
  );
}
