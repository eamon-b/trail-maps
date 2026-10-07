/**
 * Community routes API — the wire contract: which routes send a token, the
 * paths and bodies, and how a 422 hands back the server's checks.
 */

import {
  deleteCommunityRoute,
  failedChecks,
  getCommunityRoute,
  listCommunityRoutes,
  listMyCommunityRoutes,
  patchCommunityRoute,
  reportCommunityRoute,
  submitCommunityRoute,
} from '../community';
import { ApiError } from '../client';

interface Step {
  status?: number;
  body?: unknown;
}

function scriptedFetch(steps: Step[]) {
  let i = 0;
  const fn = jest.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => (status === 204 ? '' : JSON.stringify(step.body ?? {})),
    };
  });
  return fn as unknown as typeof fetch;
}

const BASE = 'https://api.test';
const ID = 'c_AbCdEfGhIjKlMnOp';

function call(fetchImpl: typeof fetch, n = 0): [string, RequestInit] {
  return (fetchImpl as unknown as jest.Mock).mock.calls[n] as [string, RequestInit];
}

function headers(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('listCommunityRoutes', () => {
  it('is public: no token, even when the context has one', async () => {
    const fetchImpl = scriptedFetch([{ body: { routes: [] } }]);
    await listCommunityRoutes({ baseUrl: BASE, fetchImpl, token: 'tok' });
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`${BASE}/v1/community/routes`);
    expect(headers(init).Authorization).toBeUndefined();
  });

  it('passes the filters as a query string', async () => {
    const fetchImpl = scriptedFetch([{ body: { routes: [] } }]);
    await listCommunityRoutes({ baseUrl: BASE, fetchImpl }, { country: 'AU', state: 'VIC' });
    expect(call(fetchImpl)[0]).toBe(`${BASE}/v1/community/routes?country=AU&state=VIC`);
  });
});

describe('authenticated routes', () => {
  it('getCommunityRoute sends the token when it has one', async () => {
    const fetchImpl = scriptedFetch([{ body: { id: ID } }]);
    await getCommunityRoute({ baseUrl: BASE, fetchImpl, token: 'tok' }, ID);
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`${BASE}/v1/community/routes/${ID}`);
    expect(headers(init).Authorization).toBe('Bearer tok');
  });

  it('submitCommunityRoute POSTs the request body', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { id: ID } }]);
    const body = {
      name: 'Loop',
      description: 'A lovely loop around the lake and back.',
      country: 'AU',
      state: 'VIC',
      rightsConfirmed: true as const,
      trail: { config: {} },
    };
    const res = await submitCommunityRoute({ baseUrl: BASE, fetchImpl, token: 'tok' }, body);
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`${BASE}/v1/community/routes`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(res.id).toBe(ID);
  });

  it('patch, delete and report hit the route’s own paths', async () => {
    const fetchImpl = scriptedFetch([{ body: { id: ID } }, { status: 204 }, { status: 204 }]);
    const ctx = { baseUrl: BASE, fetchImpl, token: 'tok' };
    await patchCommunityRoute(ctx, ID, { name: 'New name' });
    await deleteCommunityRoute(ctx, ID);
    await reportCommunityRoute(ctx, ID, { reason: 'spam' });
    expect(call(fetchImpl, 0)[1].method).toBe('PATCH');
    expect(call(fetchImpl, 1)[1].method).toBe('DELETE');
    expect(call(fetchImpl, 2)[0]).toBe(`${BASE}/v1/community/routes/${ID}/report`);
    expect(JSON.parse(call(fetchImpl, 2)[1].body as string)).toEqual({ reason: 'spam', note: null });
  });

  it('listMyCommunityRoutes reads the user-scoped list', async () => {
    const fetchImpl = scriptedFetch([{ body: { routes: [{ id: ID }] } }]);
    const routes = await listMyCommunityRoutes({ baseUrl: BASE, fetchImpl, token: 'tok' });
    expect(call(fetchImpl)[0]).toBe(`${BASE}/v1/me/community/routes`);
    expect(routes.map((r) => r.id)).toEqual([ID]);
  });
});

describe('failedChecks', () => {
  it('hands back the checks of a 422 checks_failed', async () => {
    const checks = [
      { id: 'length', level: 'fail', message: 'Too short' },
      { id: 'points', level: 'pass', message: 'ok' },
      { id: 'bogus', level: 'nope', message: 'dropped' },
    ];
    const fetchImpl = scriptedFetch([
      { status: 422, body: { error: { code: 'checks_failed', message: 'no' }, checks } },
    ]);
    let caught: unknown;
    try {
      await submitCommunityRoute({ baseUrl: BASE, fetchImpl, token: 't' }, {} as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(failedChecks(caught)?.map((c) => c.id)).toEqual(['length', 'points']);
  });

  it('is undefined for any other error', () => {
    expect(failedChecks(new ApiError(409, 'duplicate', 'dup'))).toBeUndefined();
    expect(failedChecks(new Error('x'))).toBeUndefined();
  });
});
