/**
 * The plans half of the API client.
 *
 * Two things here are worth pinning down. `fetchMyPlan` has to walk the whole
 * delta feed — the plan for the trail in hand can be on any page, and a later
 * page can tombstone what an earlier one offered. And `putPlan` must never
 * send `updatedAt`: that stamp is the server's, and a client that sent its own
 * would win every last-writer-wins conflict by having a fast clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlanDocument } from '@lib/plan-types';
import { fetchMyPlan, fetchSharedPlan, putPlan, sharePlan, unsharePlan } from './plans';
import type { WebSession } from './session';

const SESSION: WebSession = {
  userId: 'u1',
  token: 'tok_secret',
  displayName: 'Robin',
  expiresAt: null,
};

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

const doc = (over: Partial<PlanDocument> = {}): PlanDocument => ({
  id: 'plan-1',
  trailId: 'heysen',
  name: 'My Heysen plan',
  direction: 'NOBO',
  startDate: '2026-04-01',
  stops: [{ waypointId: 'w_town', km: 30, name: 'Salida', nights: 1 }],
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  ...over,
});

const entry = (document: PlanDocument, updatedAt = document.updatedAt) => ({
  id: document.id,
  trailId: document.trailId,
  document,
  shareId: null,
  updatedAt,
});

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fetchMyPlan', () => {
  it('walks every page of the feed to find this trail', async () => {
    const wanted = doc();
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: {
          plans: [entry(doc({ id: 'other', trailId: 'larapinta' }))],
          nextCursor: 'cur-2',
          syncedAt: '2026-02-01T00:00:00.000Z',
        },
      },
      {
        status: 200,
        body: { plans: [entry(wanted)], nextCursor: null, syncedAt: '2026-02-01T00:00:01.000Z' },
      },
    ]);

    const result = await fetchMyPlan(SESSION, 'heysen', { fetchImpl: impl });

    expect(result.entry?.document).toEqual(wanted);
    expect(result.syncedAt).toBe('2026-02-01T00:00:01.000Z');
    expect(calls).toHaveLength(2);
    // The trailing slash of the configured base is not doubled into the path.
    expect(calls[0].url).toBe('https://api.example.test/v1/plans?limit=200');
    expect(calls[1].url).toContain('cursor=cur-2');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok_secret');
  });

  it('returns nothing when the trail has no plan', async () => {
    const { impl } = mockFetch([
      { status: 200, body: { plans: [], nextCursor: null, syncedAt: 'now' } },
    ]);
    await expect(fetchMyPlan(SESSION, 'heysen', { fetchImpl: impl })).resolves.toMatchObject({
      entry: null,
    });
  });

  it('lets a later tombstone undo an earlier page', async () => {
    const { impl } = mockFetch([
      {
        status: 200,
        body: {
          plans: [
            entry(doc()),
            { id: 'plan-1', trailId: 'heysen', deleted: true, updatedAt: '2026-03-01T00:00:00.000Z' },
          ],
          nextCursor: null,
          syncedAt: 'now',
        },
      },
    ]);
    await expect(fetchMyPlan(SESSION, 'heysen', { fetchImpl: impl })).resolves.toMatchObject({
      entry: null,
    });
  });
});

describe('putPlan', () => {
  it('sends the document without its updatedAt, under its own id', async () => {
    const stored = doc({ updatedAt: '2026-05-05T05:05:05.000Z' });
    const { impl, calls } = mockFetch([{ status: 200, body: entry(stored) }]);

    const result = await putPlan(SESSION, doc(), { fetchImpl: impl });

    expect(calls[0].url).toBe('https://api.example.test/v1/plans/plan-1');
    expect(calls[0].init.method).toBe('PUT');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).not.toHaveProperty('updatedAt');
    expect(sent.stops).toHaveLength(1);
    expect(result.updatedAt).toBe('2026-05-05T05:05:05.000Z');
  });

  it('raises the 409 with the id the server already holds', async () => {
    const { impl } = mockFetch([
      {
        status: 409,
        body: {
          error: { code: 'plan_exists', message: 'This trail already has a plan' },
          existingId: 'plan-server',
        },
      },
    ]);

    await expect(putPlan(SESSION, doc(), { fetchImpl: impl })).rejects.toMatchObject({
      status: 409,
      code: 'plan_exists',
      body: { existingId: 'plan-server' },
    });
  });
});

describe('sharing', () => {
  it('mints and revokes the public link', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { shareId: 'abc123', url: 'https://site.test/shared-plan.html?s=abc123' } },
      { status: 204 },
    ]);

    await expect(sharePlan(SESSION, 'plan-1', { fetchImpl: impl })).resolves.toMatchObject({
      shareId: 'abc123',
    });
    await expect(unsharePlan(SESSION, 'plan-1', { fetchImpl: impl })).resolves.toBeUndefined();

    expect(calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.example.test/v1/plans/plan-1/share',
      'DELETE https://api.example.test/v1/plans/plan-1/share',
    ]);
  });

  it('reads a shared plan without sending a token', async () => {
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: { document: doc(), trailId: 'heysen', ownerDisplayName: 'Robin' },
      },
    ]);

    await expect(fetchSharedPlan('abc123', { fetchImpl: impl })).resolves.toMatchObject({
      ownerDisplayName: 'Robin',
    });
    expect(calls[0].url).toBe('https://api.example.test/v1/shared/plans/abc123');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
