/**
 * Community routes API surface (`plans/community-routes.md`, worker
 * `workers/comments-api/src/community*.ts`).
 *
 * Same shape as `api/plans.ts`: one function per route, no state, the same
 * `ApiContext`. The public list is the only route that never sends a token;
 * the detail sends one when it has it (an owner sees their own hidden route and
 * `isOwner`), and every write requires the device's primary token.
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
}

export interface ListCommunityParams {
  country?: string;
  state?: string;
  status?: 'unverified' | 'verified';
}

function routePath(id: string): string {
  return `/v1/community/routes/${encodeURIComponent(id)}`;
}

/** The public list (`unverified` + `verified`). Never sends a token. */
export async function listCommunityRoutes(
  ctx: ApiContext,
  params: ListCommunityParams = {},
): Promise<CommunityListResponse> {
  const qs = new URLSearchParams();
  if (params.country) qs.set('country', params.country);
  if (params.state) qs.set('state', params.state);
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return apiRequest<CommunityListResponse>(`/v1/community/routes${query ? `?${query}` : ''}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
  });
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

/** This user's submissions, any status, with checks and review. */
export async function listMyCommunityRoutes(ctx: ApiContext): Promise<CommunityRouteDetail[]> {
  const res = await apiRequest<{ routes?: CommunityRouteDetail[] }>('/v1/me/community/routes', {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
  });
  return res?.routes ?? [];
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
