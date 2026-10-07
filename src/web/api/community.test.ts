/**
 * The community-routes API client: paths, auth, the no-API null, the 422
 * checks surfacing, and the trail download's shape guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CommunityRouteSummary, CommunitySubmitRequest } from '@lib/community-types';
import { ApiError } from './client';
import {
  adminListCommunityRoutes,
  adminRerunReview,
  adminSetCommunityStatus,
  checksFromError,
  communityRouteHref,
  deleteCommunityRoute,
  duplicateRouteId,
  fetchCommunityTrail,
  getCommunityRoute,
  isUsableCommunityTrail,
  listCommunityRoutes,
  listMyCommunityRoutes,
  patchCommunityRoute,
  reportCommunityRoute,
  submitCommunityRoute,
} from './community';
import type { WebSession } from './session';

const SESSION: WebSession = { userId: 'u1', token: 'tok_secret', displayName: 'Robin', expiresAt: null };

interface Scripted {
  status: number;
  body?: unknown;
}

function mockFetch(responses: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: { error: { code: 'unscripted', message: '' } } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: '',
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

const TRAIL = {
  config: { id: 'u_abc', name: 'Loop' },
  track: {
    points: [
      { lat: -37, lon: 145, elevation: 0, distance: 0 },
      { lat: -37.01, lon: 145.01, elevation: 0, distance: 1.4 },
    ],
    displayPoints: [],
    totalDistance: 1.4,
    totalAscent: 0,
    totalDescent: 0,
  },
  waypoints: [],
};

const SUMMARY = { id: 'c_abcdefghijklmnop', trailUrl: 'https://data.example.test/community/v1/c_x.json' };

const LIST_ROUTE: CommunityRouteSummary = {
  id: 'c_1',
  name: 'Loop',
  status: 'unverified',
  country: 'AU',
  state: 'VIC',
  lengthKm: 12.5,
  ascentM: 300,
  hasElevation: true,
  waypointCount: 3,
  bbox: [145, -37.01, 145.01, -37],
  start: { lat: -37, lon: 145 },
  submittedBy: 'Robin',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  verifiedAt: null,
  reviewed: false,
  trailUrl: 'https://data.example.test/community/v1/c_1.json',
  md5: '0'.repeat(32),
  bytes: 100,
};

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('communityRouteHref', () => {
  it('builds the public page link with the id encoded', () => {
    expect(communityRouteHref('c_abc')).toBe('community-route.html?id=c_abc');
    expect(communityRouteHref('a&b')).toBe('community-route.html?id=a%26b');
  });
});

describe('listCommunityRoutes', () => {
  it('returns null without an API base, and makes no request', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { impl, calls } = mockFetch([]);
    expect(await listCommunityRoutes({}, { fetchImpl: impl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('GETs the public list without a token, with filters as query params', async () => {
    const routes = [LIST_ROUTE];
    const { impl, calls } = mockFetch([{ status: 200, body: { routes } }]);
    const result = await listCommunityRoutes({ country: 'AU', state: 'VIC' }, { fetchImpl: impl });
    expect(result).toEqual(routes);
    expect(calls[0].url).toBe('https://api.example.test/v1/community/routes?country=AU&state=VIC');
    expect(authHeader(calls[0].init)).toBeUndefined();
  });

  it('drops entries of the wrong shape rather than handing them to the page', async () => {
    const { impl } = mockFetch([
      {
        status: 200,
        body: {
          routes: [
            LIST_ROUTE,
            { ...LIST_ROUTE, id: 'c_2', name: 42 },
            { ...LIST_ROUTE, id: 'c_3', lengthKm: 'far' },
            { ...LIST_ROUTE, id: 'c_4', status: 'hidden' },
            { ...LIST_ROUTE, id: 'c_5', country: null },
            { ...LIST_ROUTE, id: 'c_6', state: 7 },
            { ...LIST_ROUTE, id: 'c_7', submittedBy: {} },
            null,
            'c_8',
            { ...LIST_ROUTE, id: 'c_9', state: null, submittedBy: null, status: 'verified' },
          ],
        },
      },
    ]);
    const result = await listCommunityRoutes({}, { fetchImpl: impl });
    expect(result!.map(r => r.id)).toEqual(['c_1', 'c_9']);
  });

  it('passes the abort signal to the request', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { routes: [] } }]);
    const controller = new AbortController();
    await listCommunityRoutes({}, { fetchImpl: impl, signal: controller.signal });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  it('treats a body without routes as an empty list', async () => {
    const { impl } = mockFetch([{ status: 200, body: {} }]);
    expect(await listCommunityRoutes(undefined, { fetchImpl: impl })).toEqual([]);
  });
});

describe('authenticated calls', () => {
  it('getCommunityRoute sends the token only when given a session', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { id: 'c_1' } },
      { status: 200, body: { id: 'c_1' } },
    ]);
    await getCommunityRoute('c_1', null, { fetchImpl: impl });
    await getCommunityRoute('c_1', SESSION, { fetchImpl: impl });
    expect(authHeader(calls[0].init)).toBeUndefined();
    expect(authHeader(calls[1].init)).toBe('Bearer tok_secret');
    expect(calls[1].url).toBe('https://api.example.test/v1/community/routes/c_1');
  });

  it('submit POSTs the request body', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { id: 'c_new' } }]);
    const req: CommunitySubmitRequest = {
      name: 'Loop',
      description: 'A loop around the reservoir with water at the start.',
      country: 'AU',
      state: 'VIC',
      rightsConfirmed: true,
      trail: TRAIL,
    };
    const detail = await submitCommunityRoute(SESSION, req, { fetchImpl: impl });
    expect(detail.id).toBe('c_new');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toBe('https://api.example.test/v1/community/routes');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(req);
  });

  it('a 422 keeps the server checks on the error', async () => {
    const checks = [{ id: 'length', level: 'fail', message: 'Too short' }];
    const { impl } = mockFetch([
      { status: 422, body: { error: { code: 'checks_failed', message: 'Checks failed' }, checks } },
    ]);
    const err = await submitCommunityRoute(SESSION, {} as CommunitySubmitRequest, { fetchImpl: impl }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('checks_failed');
    expect(checksFromError(err)).toEqual(checks);
  });

  it('checksFromError ignores other errors', () => {
    expect(checksFromError(new ApiError(409, 'duplicate', 'dup', {}))).toBeNull();
    expect(checksFromError(new Error('x'))).toBeNull();
  });

  it('patch, delete and report use the right verbs and paths', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { id: 'c_1', name: 'New' } },
      { status: 204 },
      { status: 204 },
    ]);
    await patchCommunityRoute(SESSION, 'c_1', { name: 'New' }, { fetchImpl: impl });
    await deleteCommunityRoute(SESSION, 'c_1', { fetchImpl: impl });
    await reportCommunityRoute(SESSION, 'c_1', 'spam', '  ', { fetchImpl: impl });
    expect(calls.map(c => `${c.init.method} ${c.url}`)).toEqual([
      'PATCH https://api.example.test/v1/community/routes/c_1',
      'DELETE https://api.example.test/v1/community/routes/c_1',
      'POST https://api.example.test/v1/community/routes/c_1/report',
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ reason: 'spam', note: null });
    for (const c of calls) expect(authHeader(c.init)).toBe('Bearer tok_secret');
  });

  it('my routes and the admin endpoints', async () => {
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: {
          routes: [
            { id: 'c_1', name: 'Mine', status: 'hidden', lengthKm: 12, country: 'AU', state: null },
            { id: 'c_bad', name: 'No length', status: 'hidden', country: 'AU' },
            { id: 'c_gone', name: 'Removed', status: 'removed', lengthKm: 1, country: 'AU' },
          ],
        },
      },
      { status: 200, body: { routes: [{ id: 'c_2' }] } },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    expect(await listMyCommunityRoutes(SESSION, { fetchImpl: impl })).toHaveLength(1);
    expect(await adminListCommunityRoutes(SESSION, { fetchImpl: impl })).toHaveLength(1);
    await adminSetCommunityStatus(SESSION, 'c_2', 'verified', ' looks fine ', { fetchImpl: impl });
    await adminRerunReview(SESSION, 'c_2', { fetchImpl: impl });
    expect(calls.map(c => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://api.example.test/v1/me/community/routes',
      'GET https://api.example.test/v1/admin/community/routes',
      'POST https://api.example.test/v1/admin/community/routes/c_2/status',
      'POST https://api.example.test/v1/admin/community/routes/c_2/review',
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ status: 'verified', note: 'looks fine' });
  });

  it('a 403 from the admin list is an ApiError the page can branch on', async () => {
    const { impl } = mockFetch([{ status: 403, body: { error: { code: 'forbidden', message: 'Admins only' } } }]);
    const err = await adminListCommunityRoutes(SESSION, { fetchImpl: impl }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe('fetchCommunityTrail', () => {
  it('downloads and returns a usable trail, without a token', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: TRAIL }]);
    const trail = await fetchCommunityTrail(SUMMARY, { fetchImpl: impl });
    expect(trail.config.name).toBe('Loop');
    expect(calls[0].url).toBe(SUMMARY.trailUrl);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('rejects a non-http URL before fetching', async () => {
    const { impl, calls } = mockFetch([]);
    await expect(
      fetchCommunityTrail({ ...SUMMARY, trailUrl: 'javascript:alert(1)' }, { fetchImpl: impl }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects an HTTP error and a body that is not a trail', async () => {
    const bad = mockFetch([{ status: 404, body: { error: 'nope' } }, { status: 200, body: { hello: 1 } }]);
    await expect(fetchCommunityTrail(SUMMARY, { fetchImpl: bad.impl })).rejects.toBeInstanceOf(ApiError);
    await expect(fetchCommunityTrail(SUMMARY, { fetchImpl: bad.impl })).rejects.toThrow(/not a usable trail/);
  });

  it('isUsableCommunityTrail wants a config, two points and a waypoint array', () => {
    expect(isUsableCommunityTrail(TRAIL)).toBe(true);
    expect(isUsableCommunityTrail({ ...TRAIL, waypoints: undefined })).toBe(false);
    expect(isUsableCommunityTrail({ ...TRAIL, track: { ...TRAIL.track, points: [TRAIL.track.points[0]] } })).toBe(false);
    expect(isUsableCommunityTrail(null)).toBe(false);
  });
});

describe('duplicateRouteId', () => {
  it('reads the caller’s own route id from a 409 duplicate', () => {
    const body = { error: { code: 'duplicate', message: 'x' }, existingId: 'c_abcdefghijklmnop' };
    expect(duplicateRouteId(new ApiError(409, 'duplicate', 'x', body))).toBe('c_abcdefghijklmnop');
  });

  it('is null without an id, with a malformed one, or for another status', () => {
    expect(duplicateRouteId(new ApiError(409, 'duplicate', 'x', { error: {} }))).toBeNull();
    expect(duplicateRouteId(new ApiError(409, 'duplicate', 'x', { existingId: '../admin' }))).toBeNull();
    expect(duplicateRouteId(new ApiError(422, 'checks_failed', 'x', { existingId: 'c_abcdefghijklmnop' }))).toBeNull();
    expect(duplicateRouteId(new Error('x'))).toBeNull();
  });
});
