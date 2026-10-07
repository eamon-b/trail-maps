/**
 * The community-routes half of the API, as the web pages use it.
 * Spec: `plans/community-routes.md` (the API table); wire types:
 * `@lib/community-types`.
 *
 * Same conventions as `plans.ts`: every authenticated call takes the session
 * explicitly (never read from storage here), the public reads send no token,
 * and failures surface as the `ApiError` / `NetworkError` pair from
 * `client.ts`. A 422 `checks_failed` keeps its body on `ApiError.body`, and
 * `checksFromError` reads the server's checks back out of it.
 *
 * `listCommunityRoutes` is the one call that tolerates a build without an API:
 * it returns null, so the landing page can simply skip the community tier.
 */

import type {
  CommunityAdminListResponse,
  CommunityCheck,
  CommunityListResponse,
  CommunityPatchRequest,
  CommunityReportReason,
  CommunityRouteDetail,
  CommunityRouteStatus,
  CommunityRouteSummary,
  CommunitySubmitRequest,
} from '@lib/community-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { ApiError, NetworkError, apiRequest, getApiBase, type FetchLike } from './client';
import type { WebSession } from './session';

export interface CommunityApiDeps {
  fetchImpl?: FetchLike;
  /** Aborts the request (the landing page's deadline). */
  signal?: AbortSignal;
}

/** Optional narrowing of the public list. */
export interface CommunityListFilter {
  country?: string;
  state?: string;
  status?: Extract<CommunityRouteStatus, 'unverified' | 'verified'>;
}

/** The public page for one community route, relative to the site root. */
export function communityRouteHref(id: string): string {
  return `community-route.html?id=${encodeURIComponent(id)}`;
}

function routePath(id: string): string {
  return `/v1/community/routes/${encodeURIComponent(id)}`;
}

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * True when a list entry has the fields the landing page reads (name, length,
 * status, region, submitter) in the right types. The list is public and
 * cached, so one malformed row is dropped rather than allowed to throw inside
 * the page's render.
 */
export function isCommunityRouteSummary(value: unknown): value is CommunityRouteSummary {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id !== '' &&
    typeof r.name === 'string' &&
    (r.status === 'verified' || r.status === 'unverified') &&
    typeof r.lengthKm === 'number' &&
    Number.isFinite(r.lengthKm) &&
    typeof r.country === 'string' &&
    (r.state === undefined || isStringOrNull(r.state)) &&
    (r.submittedBy === undefined || isStringOrNull(r.submittedBy))
  );
}

/**
 * Every live (unverified + verified) community route, or null when this build
 * has no API configured. Entries of the wrong shape are dropped.
 */
export async function listCommunityRoutes(
  filter: CommunityListFilter = {},
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteSummary[] | null> {
  if (!getApiBase()) return null;
  const query = new URLSearchParams();
  if (filter.country) query.set('country', filter.country);
  if (filter.state) query.set('state', filter.state);
  if (filter.status) query.set('status', filter.status);
  const qs = query.toString();
  const response = await apiRequest<CommunityListResponse>(
    `/v1/community/routes${qs ? `?${qs}` : ''}`,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  const routes: unknown = response?.routes;
  return Array.isArray(routes) ? routes.filter(isCommunityRouteSummary) : [];
}

/**
 * One route. With a session the owner (and an admin) also see a hidden route,
 * its review and its reports; without one the server answers as for anyone.
 */
export async function getCommunityRoute(
  id: string,
  session: WebSession | null = null,
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>(routePath(id), {
    token: session?.token,
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * Submit a route. 201 → the stored detail. A 422 throws `ApiError` with code
 * `checks_failed` (read the checks with `checksFromError`), a duplicate 409,
 * the daily cap 429.
 */
export async function submitCommunityRoute(
  session: WebSession,
  request: CommunitySubmitRequest,
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>('/v1/community/routes', {
    method: 'POST',
    token: session.token,
    body: request,
    fetchImpl: deps.fetchImpl,
  });
}

/** Edit an owned route's text or region. Returns the updated detail. */
export async function patchCommunityRoute(
  session: WebSession,
  id: string,
  patch: CommunityPatchRequest,
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteDetail> {
  return apiRequest<CommunityRouteDetail>(routePath(id), {
    method: 'PATCH',
    token: session.token,
    body: patch,
    fetchImpl: deps.fetchImpl,
  });
}

/** Remove a route (its owner, or an admin). */
export async function deleteCommunityRoute(
  session: WebSession,
  id: string,
  deps: CommunityApiDeps = {},
): Promise<void> {
  await apiRequest<unknown>(routePath(id), {
    method: 'DELETE',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/** Report a route. A repeat report from the same user is the server's to dedupe. */
export async function reportCommunityRoute(
  session: WebSession,
  id: string,
  reason: CommunityReportReason,
  note: string | null = null,
  deps: CommunityApiDeps = {},
): Promise<void> {
  const trimmed = note?.trim();
  await apiRequest<unknown>(`${routePath(id)}/report`, {
    method: 'POST',
    token: session.token,
    body: { reason, note: trimmed ? trimmed : null },
    fetchImpl: deps.fetchImpl,
  });
}

/** This user's submissions, any status, with checks and review. */
export async function listMyCommunityRoutes(
  session: WebSession,
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteDetail[]> {
  const response = await apiRequest<CommunityAdminListResponse>('/v1/me/community/routes', {
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
  return Array.isArray(response?.routes) ? response.routes : [];
}

/** The admin queue: everything not removed. 403 for a non-admin. */
export async function adminListCommunityRoutes(
  session: WebSession,
  deps: CommunityApiDeps = {},
): Promise<CommunityRouteDetail[]> {
  const response = await apiRequest<CommunityAdminListResponse>('/v1/admin/community/routes', {
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
  return Array.isArray(response?.routes) ? response.routes : [];
}

/** Verify / unverify / hide (or restore, which is `unverified`). */
export async function adminSetCommunityStatus(
  session: WebSession,
  id: string,
  status: Extract<CommunityRouteStatus, 'verified' | 'unverified' | 'hidden'>,
  note: string | null = null,
  deps: CommunityApiDeps = {},
): Promise<void> {
  const trimmed = note?.trim();
  await apiRequest<unknown>(`/v1/admin/community/routes/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    token: session.token,
    body: trimmed ? { status, note: trimmed } : { status },
    fetchImpl: deps.fetchImpl,
  });
}

/** Ask the worker to run the AI review again. */
export async function adminRerunReview(
  session: WebSession,
  id: string,
  deps: CommunityApiDeps = {},
): Promise<void> {
  await apiRequest<unknown>(`/v1/admin/community/routes/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * The server's checks from a failed submit (422 `checks_failed`), or null when
 * the error is anything else.
 */
export function checksFromError(err: unknown): CommunityCheck[] | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const body = err.body as { checks?: unknown } | undefined;
  if (!body || !Array.isArray(body.checks)) return null;
  return body.checks.filter(
    (c): c is CommunityCheck =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as CommunityCheck).id === 'string' &&
      typeof (c as CommunityCheck).message === 'string' &&
      ['pass', 'warn', 'fail'].includes((c as CommunityCheck).level),
  );
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Minimal shape check for a downloaded trail: enough that the viewer can draw
 * it without throwing. The worker ran the strict check on upload; this guards
 * against a wrong URL or a truncated response, not a hostile server.
 */
export function isUsableCommunityTrail(value: unknown): value is ProcessedTrail {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  const config = t.config as Record<string, unknown> | undefined;
  const track = t.track as Record<string, unknown> | undefined;
  if (!config || typeof config !== 'object' || !track || typeof track !== 'object') return false;
  if (!Array.isArray(track.points) || track.points.length < 2) return false;
  if (!isFiniteNumber(track.totalDistance)) return false;
  const first = track.points[0] as Record<string, unknown> | undefined;
  if (!first || !isFiniteNumber(first.lat) || !isFiniteNumber(first.lon)) return false;
  if (!Array.isArray(t.waypoints)) return false;
  return true;
}

/**
 * Download the route's processed trail from its public, immutable URL.
 * `trailUrl` lives on the public bucket domain, not the API origin, so this is
 * a plain fetch with no token.
 */
export async function fetchCommunityTrail(
  summary: Pick<CommunityRouteSummary, 'id' | 'trailUrl'>,
  deps: CommunityApiDeps = {},
): Promise<ProcessedTrail> {
  if (!summary.trailUrl) {
    // A hidden route, seen by its owner or an admin: no public copy exists.
    throw new Error('This route has no public track while it is hidden');
  }
  let url: URL;
  try {
    url = new URL(summary.trailUrl);
  } catch {
    throw new Error('This route has no valid trail address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('This route has no valid trail address');
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url.href, { headers: { Accept: 'application/json' } });
  } catch (cause) {
    throw new NetworkError('Could not download the route', cause);
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'http_error', `Could not download the route (HTTP ${response.status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new ApiError(response.status, 'invalid_response', 'The route file is not valid JSON');
  }
  if (!isUsableCommunityTrail(parsed)) {
    throw new ApiError(response.status, 'invalid_response', 'The route file is not a usable trail');
  }
  return parsed;
}
