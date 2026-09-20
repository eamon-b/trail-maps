/**
 * Plans API — the wire contract the sync engine leans on.
 *
 * The three things worth pinning: the delta read paginates and keeps the FIRST
 * page's clock (a plan touched mid-pagination must be re-fetched, never
 * skipped), the write strips `updatedAt` (the server's clock wins), and a 409
 * `plan_exists` still hands back the id to adopt.
 */

import type { PlansSyncResponse } from '@lib/comments-api-types';
import type { PlanDocument } from '@lib/plan-types';
import {
  deletePlan,
  fetchSharedPlan,
  listPlans,
  planExistsId,
  putPlan,
  sharePlan,
  unsharePlan,
} from '../plans';
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
const CTX = (fetchImpl: typeof fetch) => ({ baseUrl: BASE, fetchImpl, token: 'tok' });

const DOC: PlanDocument = {
  id: 'p1',
  trailId: 'heysen',
  name: 'Heysen',
  direction: 'NOBO',
  startDate: null,
  stops: [{ waypointId: 'w_1', km: 10, name: 'Hut', nights: 1 }],
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
};

const calls = (fetchImpl: typeof fetch) => (fetchImpl as unknown as jest.Mock).mock.calls;

describe('listPlans', () => {
  it('auto-paginates and keeps the first page syncedAt', async () => {
    const page1: PlansSyncResponse = {
      plans: [{ id: 'p1', trailId: 'heysen', document: DOC, shareId: null, updatedAt: 'T1' }],
      nextCursor: 'CUR1',
      syncedAt: '2026-02-01T00:00:00Z',
    };
    const page2: PlansSyncResponse = {
      plans: [{ id: 'p2', trailId: 'aawt', deleted: true, updatedAt: 'T2' }],
      nextCursor: null,
      syncedAt: '2026-02-01T00:00:09Z',
    };
    const fetchImpl = scriptedFetch([{ body: page1 }, { body: page2 }]);

    const result = await listPlans(CTX(fetchImpl), { since: '2026-01-01T00:00:00Z' });

    expect(calls(fetchImpl)).toHaveLength(2);
    expect(calls(fetchImpl)[0][0]).toContain('/v1/plans?since=');
    expect(calls(fetchImpl)[1][0]).toContain('cursor=CUR1');
    expect(result.entries.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(result.syncedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('sends the bearer token — plans are private, unlike comments', async () => {
    const fetchImpl = scriptedFetch([{ body: { plans: [], nextCursor: null, syncedAt: 'T' } }]);
    await listPlans(CTX(fetchImpl));
    expect(calls(fetchImpl)[0][1].headers.Authorization).toBe('Bearer tok');
    // No `since`: a snapshot read carries no query string at all.
    expect(calls(fetchImpl)[0][0]).toBe(`${BASE}/v1/plans`);
  });
});

describe('putPlan', () => {
  it('PUTs the document to its id endpoint without updatedAt', async () => {
    const fetchImpl = scriptedFetch([
      { status: 201, body: { id: 'p1', trailId: 'heysen', document: DOC, shareId: null, updatedAt: 'S1' } },
    ]);

    const entry = await putPlan(CTX(fetchImpl), DOC);

    expect(calls(fetchImpl)[0][0]).toBe(`${BASE}/v1/plans/p1`);
    expect(calls(fetchImpl)[0][1].method).toBe('PUT');
    const body = JSON.parse(calls(fetchImpl)[0][1].body as string);
    expect(body.updatedAt).toBeUndefined();
    expect(body).toMatchObject({ id: 'p1', trailId: 'heysen', version: 1 });
    expect(entry.updatedAt).toBe('S1');
  });

  it('surfaces a 409 plan_exists with the id to adopt', async () => {
    const fetchImpl = scriptedFetch([
      {
        status: 409,
        body: { error: { code: 'plan_exists', message: 'already' }, existingId: 'server-id' },
      },
    ]);

    const err = await putPlan(CTX(fetchImpl), DOC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(planExistsId(err)).toBe('server-id');
  });

  it('reports no adoptable id for any other failure', async () => {
    const fetchImpl = scriptedFetch([
      { status: 409, body: { error: { code: 'id_conflict', message: 'not yours' } } },
    ]);
    const err = await putPlan(CTX(fetchImpl), DOC).catch((e: unknown) => e);
    expect(planExistsId(err)).toBeUndefined();
    expect(planExistsId(new Error('boom'))).toBeUndefined();
  });
});

describe('the rest of the surface', () => {
  it('deletes, shares and unshares by id', async () => {
    const del = scriptedFetch([{ status: 204 }]);
    await deletePlan(CTX(del), 'p1');
    expect(calls(del)[0][1].method).toBe('DELETE');
    expect(calls(del)[0][0]).toBe(`${BASE}/v1/plans/p1`);

    const share = scriptedFetch([{ body: { shareId: 'abc', url: 'https://site/shared-plan.html?s=abc' } }]);
    const res = await sharePlan(CTX(share), 'p1');
    expect(res.shareId).toBe('abc');
    expect(calls(share)[0][0]).toBe(`${BASE}/v1/plans/p1/share`);
    expect(calls(share)[0][1].method).toBe('POST');

    const unshare = scriptedFetch([{ status: 204 }]);
    await unsharePlan(CTX(unshare), 'p1');
    expect(calls(unshare)[0][1].method).toBe('DELETE');
    expect(calls(unshare)[0][0]).toBe(`${BASE}/v1/plans/p1/share`);
  });

  it('reads a shared plan WITHOUT a token — the link is the whole credential', async () => {
    const fetchImpl = scriptedFetch([
      { body: { document: DOC, trailId: 'heysen', ownerDisplayName: 'Trail Ghost' } },
    ]);

    const res = await fetchSharedPlan({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'abc');

    expect(res.ownerDisplayName).toBe('Trail Ghost');
    expect(calls(fetchImpl)[0][0]).toBe(`${BASE}/v1/shared/plans/abc`);
    expect(calls(fetchImpl)[0][1].headers.Authorization).toBeUndefined();
  });
});
