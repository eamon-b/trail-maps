/**
 * Drain and pull resilience: what happens when one item, one token or one
 * clock goes wrong.
 *
 * - One bad item (a photo whose file is gone, a payload that does not parse, a
 *   server that keeps failing it) is settled on its own and never holds back
 *   the items queued after it.
 * - A 401 is surfaced as the identity store's `authError`, and the next drain
 *   re-registers the device once.
 * - Deleting a comment takes its queued photo uploads with it.
 * - A manual retry that joins a running drain still forces the follow-up, and
 *   no caller is ever handed a drain that finished before its write was queued.
 * - A pull never overwrites a plan edit that is still queued here.
 */

import type { PlanDocument } from '@lib/plan-types';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as commentsRepo from '../../db/comments-repo';
import * as outboxRepo from '../../db/outbox-repo';
import * as plansRepo from '../../db/plans-repo';
import type { Session } from '../../api/auth';
import { ApiError, NetworkError } from '../../api/client';
import {
  deleteOwnComment,
  drainOutbox,
  enqueuePlan,
  pullPlans,
  resetSyncStateForTests,
  retryOutbox,
  type AuthHooks,
} from '../comment-sync';
import { onSyncChange } from '../sync-events';
import { selectAuthError, useIdentityStore } from '../../state/identity-store';

const BASE = 'https://api.test';
const SESSION: Session = { userId: 'u1', token: 'tok', displayName: 'Me' };
const getSessionFn = async () => SESSION;
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const now = () => NOW;
const refreshPlan = jest.fn();

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

interface Step {
  status?: number;
  body?: unknown;
  throw?: boolean;
}

function response(status: number, body?: unknown) {
  const raw = status === 204 ? '' : JSON.stringify(body ?? {});
  return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => raw };
}

/** A fetch that answers by URL pattern, recording every call. */
function routedFetch(routes: [RegExp, Step | ((init: RequestInit | undefined) => Step)][]) {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [pattern, step] of routes) {
      if (!pattern.test(String(url))) continue;
      const s = typeof step === 'function' ? step(init) : step;
      if (s.throw) throw new Error('offline');
      return response(s.status ?? 200, s.body);
    }
    throw new Error(`unrouted ${url}`);
  });
  return fn as unknown as typeof fetch;
}

const calls = (f: typeof fetch) => (f as unknown as jest.Mock).mock.calls as [string, RequestInit?][];

function feedComment(id: string) {
  return {
    id,
    waypointId: 'w_1',
    displayName: 'Me',
    text: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

async function seedLocalComment(d: SqlDatabase, id: string, createdAt: string) {
  await commentsRepo.insertLocalComment(d, {
    id,
    trailId: 'aawt',
    waypointId: 'w_1',
    authorId: 'u1',
    authorName: 'Me',
    body: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt,
  });
  await outboxRepo.enqueue(d, {
    id,
    kind: 'comment',
    trailId: 'aawt',
    waypointId: 'w_1',
    payload: { trailId: 'aawt', waypointId: 'w_1', text: 'hi' },
    createdAt,
  });
}

async function seedServerComment(d: SqlDatabase, id: string) {
  await commentsRepo.upsertServerComment(d, {
    id,
    trailId: 'aawt',
    waypointId: 'w_1',
    displayName: 'Me',
    text: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
}

async function seedPhoto(d: SqlDatabase, id: string, commentId: string, createdAt: string) {
  await outboxRepo.enqueue(d, {
    id,
    kind: 'photo',
    trailId: 'aawt',
    waypointId: 'w_1',
    payload: { commentId, localUri: `file:///${id}.jpg`, contentType: 'image/jpeg' },
    createdAt,
  });
}

/**
 * Auth hooks backed by a plain flag, so no test reaches the real identity
 * store. The token is dead unless a test says otherwise (`verify`).
 */
function fakeAuth(
  reregister: AuthHooks['reregister'] = jest.fn(async () => SESSION),
  verify: AuthHooks['verify'] = jest.fn(async () => false),
) {
  const state = { authError: false };
  const hooks: AuthHooks = {
    hasAuthError: () => state.authError,
    setAuthError: (v) => {
      state.authError = v;
    },
    verify,
    reregister,
  };
  return { state, hooks, reregister, verify };
}

afterEach(() => {
  useIdentityStore.setState({ authError: false });
  resetSyncStateForTests();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// M1 — one bad item never blocks the queue
// ---------------------------------------------------------------------------

describe('a bad outbox item', () => {
  it('marks a photo whose file is gone failed and sends what is queued after it', async () => {
    const d = await db();
    await seedServerComment(d, 'c1');
    await seedPhoto(d, 'p1', 'c1', '2026-01-01T00:00:00.000Z');
    await seedLocalComment(d, 'm2', '2026-01-02T00:00:00.000Z');
    const readBytes = jest.fn(async () => {
      // What RN's fetch of a purged cache URI does.
      throw new TypeError('Network request failed');
    });
    const fetchImpl = routedFetch([[/\/comments\/m2$/, { status: 201, body: feedComment('m2') }]]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes, now });

    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 1 });
    const photo = await outboxRepo.getById(d, 'p1');
    expect(photo?.status).toBe('failed');
    expect(photo?.attempts).toBe(1);
    expect(photo?.lastError).toBe('local_error: Network request failed');
    // The comment behind it went out.
    expect(await outboxRepo.getById(d, 'm2')).toBeNull();
    expect((await commentsRepo.getById(d, 'm2'))?.source).toBe('server');
  });

  it('marks a row whose payload does not parse failed instead of throwing out of the drain', async () => {
    const d = await db();
    await seedServerComment(d, 'c1');
    await seedPhoto(d, 'p1', 'c1', '2026-01-01T00:00:00.000Z');
    await d.runAsync("UPDATE outbox SET payload_json = '{not json' WHERE id = 'p1'");
    await seedLocalComment(d, 'm2', '2026-01-02T00:00:00.000Z');
    const fetchImpl = routedFetch([[/\/comments\/m2$/, { status: 201, body: feedComment('m2') }]]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });

    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 1 });
    const photo = await outboxRepo.getById(d, 'p1');
    expect(photo?.status).toBe('failed');
    expect(photo?.lastError).toMatch(/^local_error: /);
    expect(await outboxRepo.getById(d, 'm2')).toBeNull();
  });

  it('leaves a 5xx item pending for its backoff and carries on with the next one', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-10-06T11:59:30.000Z');
    await seedLocalComment(d, 'm2', '2026-10-06T11:59:45.000Z');
    const fetchImpl = routedFetch([
      [/\/comments\/m1$/, { status: 503, body: { error: { code: 'unavailable', message: 'busy' } } }],
      [/\/comments\/m2$/, { status: 201, body: feedComment('m2') }],
    ]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });

    // The real cause, not 'offline'.
    expect(res).toMatchObject({ outcome: 'server-error', sent: 1, failed: 0 });
    const stuck = await outboxRepo.getById(d, 'm1');
    expect(stuck).toMatchObject({ status: 'pending', attempts: 1, lastError: 'unavailable: busy' });
    expect(await outboxRepo.getById(d, 'm2')).toBeNull();

    // Its backoff (60 s after one attempt, from created_at) has not elapsed, so
    // an automatic drain leaves it alone…
    const again = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });
    expect(again.outcome).toBe('idle');
    expect(calls(fetchImpl)).toHaveLength(2);
    // …and one after the window retries it.
    await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now: () => NOW + 60_000 });
    expect(calls(fetchImpl)).toHaveLength(3);
    expect((await outboxRepo.getById(d, 'm1'))?.attempts).toBe(2);
  });

  it('still stops the whole drain on a network error', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    await seedLocalComment(d, 'm2', '2026-01-02T00:00:00.000Z');
    const fetchImpl = routedFetch([[/\/comments\//, { throw: true }]]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });

    expect(res.outcome).toBe('offline');
    expect(calls(fetchImpl)).toHaveLength(1);
    expect((await outboxRepo.getById(d, 'm1'))?.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M5 — a 401 is surfaced and recovered from once
// ---------------------------------------------------------------------------

describe('a refused token', () => {
  const UNAUTHORIZED: Step = { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } };

  it('raises authError in the identity store by default', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const fetchImpl = routedFetch([[/\/comments\//, UNAUTHORIZED]]);
    expect(selectAuthError(useIdentityStore.getState())).toBe(false);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });

    expect(res.outcome).toBe('unauthorized');
    expect(selectAuthError(useIdentityStore.getState())).toBe(true);
  });

  it('re-registers once on the next drain and sends with the new token', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const renewed: Session = { userId: 'u2', token: 'fresh', displayName: 'Me' };
    const { state, hooks, reregister } = fakeAuth(jest.fn(async () => renewed));
    const fetchImpl = routedFetch([
      [
        /\/comments\/m1$/,
        (init) =>
          (init?.headers as Record<string, string>).Authorization === 'Bearer fresh'
            ? { status: 201, body: feedComment('m1') }
            : UNAUTHORIZED,
      ],
    ]);

    const first = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    expect(first.outcome).toBe('unauthorized');
    expect(state.authError).toBe(true);
    expect(reregister).not.toHaveBeenCalled();

    const second = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    expect(reregister).toHaveBeenCalledTimes(1);
    expect(reregister).toHaveBeenCalledWith('Me');
    expect(second).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(state.authError).toBe(false);
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('tries re-registering only once per episode', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const { state, hooks, reregister } = fakeAuth(
      jest.fn(async () => {
        throw new Error('registration refused');
      }),
    );
    state.authError = true;
    const fetchImpl = routedFetch([[/\/comments\//, UNAUTHORIZED]]);

    const a = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    const b = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });

    expect(a.outcome).toBe('unauthorized');
    expect(b.outcome).toBe('unauthorized');
    expect(reregister).toHaveBeenCalledTimes(1);
    // Paused, not hammered: nothing was sent with the dead token.
    expect(calls(fetchImpl)).toHaveLength(0);
    expect(state.authError).toBe(true);

    // Once the error is cleared (the hiker re-registered by hand), a later
    // episode gets its own attempt.
    state.authError = false;
    await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    expect(reregister).toHaveBeenCalledTimes(2);
  });

  it('keeps its identity when the token still answers: the 401 was the server, not the token', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const { state, hooks, reregister, verify } = fakeAuth(undefined, jest.fn(async () => true));
    state.authError = true;
    const fetchImpl = routedFetch([[/\/comments\/m1$/, { status: 201, body: feedComment('m1') }]]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(reregister).not.toHaveBeenCalled();
    expect(res).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(state.authError).toBe(false);
    // Sent with the token it already had, not a fresh one.
    expect((calls(fetchImpl)[0][1]?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SESSION.token}`,
    );
  });

  it('spends nothing when the probe gets no answer', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const { state, hooks, reregister, verify } = fakeAuth(
      undefined,
      jest.fn(async () => {
        throw new NetworkError('offline');
      }),
    );
    state.authError = true;
    const fetchImpl = routedFetch([[/\/comments\//, UNAUTHORIZED]]);

    const a = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });
    const b = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks });

    expect(a.outcome).toBe('unauthorized');
    expect(b.outcome).toBe('unauthorized');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(reregister).not.toHaveBeenCalled();
    expect(state.authError).toBe(true);
  });

  it('asks again after a registration the server could not answer (429, 5xx)', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    let attempts = 0;
    const { state, hooks, reregister } = fakeAuth(
      jest.fn(async () => {
        attempts += 1;
        // The hut's shared wifi is over the per-IP register limit, then the
        // server is down, then it answers.
        if (attempts === 1) throw new ApiError(429, 'rate_limited', 'slow down');
        if (attempts === 2) throw new ApiError(503, 'unavailable', 'later');
        return SESSION;
      }),
    );
    state.authError = true;
    const fetchImpl = routedFetch([[/\/comments\/m1$/, { status: 201, body: feedComment('m1') }]]);
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks };

    expect((await drainOutbox(deps)).outcome).toBe('unauthorized');
    expect((await drainOutbox(deps)).outcome).toBe('unauthorized');
    expect((await drainOutbox(deps))).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(reregister).toHaveBeenCalledTimes(3);
    expect(state.authError).toBe(false);
  });

  it('a refused registration is tried again by a manual retry, never by itself', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    let attempts = 0;
    const { state, hooks, reregister } = fakeAuth(
      jest.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError(400, 'invalid', 'no');
        return SESSION;
      }),
    );
    state.authError = true;
    const fetchImpl = routedFetch([[/\/comments\/m1$/, { status: 201, body: feedComment('m1') }]]);
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks };

    expect((await drainOutbox(deps)).outcome).toBe('unauthorized');
    expect((await drainOutbox(deps)).outcome).toBe('unauthorized');
    expect(reregister).toHaveBeenCalledTimes(1);

    expect(await drainOutbox({ ...deps, force: true })).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(reregister).toHaveBeenCalledTimes(2);
    expect(state.authError).toBe(false);
  });

  it('never mints a second identity in one episode, even on a manual retry', async () => {
    const d = await db();
    await seedLocalComment(d, 'm1', '2026-01-01T00:00:00.000Z');
    const { state, hooks, reregister } = fakeAuth();
    state.authError = true;
    // The server refuses the new token too: something is wrong on its side,
    // and another identity per drain would only pile up orphans.
    const fetchImpl = routedFetch([[/\/comments\//, UNAUTHORIZED]]);
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now, auth: hooks };

    expect((await drainOutbox(deps)).outcome).toBe('unauthorized');
    expect(state.authError).toBe(true);
    expect((await drainOutbox({ ...deps, force: true })).outcome).toBe('unauthorized');
    expect(reregister).toHaveBeenCalledTimes(1);
  });

  it('raises authError from the plans pull too', async () => {
    const d = await db();
    const { state, hooks } = fakeAuth();
    const fetchImpl = routedFetch([[/\/v1\/plans/, UNAUTHORIZED]]);

    const res = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan, auth: hooks });

    expect(res.outcome).toBe('unauthorized');
    expect(state.authError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M4 + L — deleting a comment
// ---------------------------------------------------------------------------

describe('deleteOwnComment', () => {
  it('queues the delete with an ISO UTC stamp, so it is drainable at once in any zone', async () => {
    const d = await db();
    await seedServerComment(d, 'S');
    const fetchImpl = routedFetch([[/\/comments\/S$/, { throw: true }]]);

    await deleteOwnComment({ id: 'S', source: 'server' }, { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now });

    const row = await outboxRepo.getById(d, 'S');
    expect(row?.createdAt).toBe('2026-10-06T12:00:00.000Z');
  });

  it('cancelling a local comment drops its queued photo too', async () => {
    const d = await db();
    await seedLocalComment(d, 'L', '2026-01-01T00:00:00.000Z');
    await seedPhoto(d, 'pL', 'L', '2026-01-01T00:00:00.000Z');
    await seedPhoto(d, 'pOther', 'someone-else', '2026-01-01T00:00:00.000Z');

    await deleteOwnComment({ id: 'L', source: 'local' }, { db: d });

    expect(await outboxRepo.getById(d, 'L')).toBeNull();
    expect(await outboxRepo.getById(d, 'pL')).toBeNull();
    expect(await outboxRepo.getById(d, 'pOther')).not.toBeNull();
  });

  it('deleting a server comment drops its failed photo upload', async () => {
    const d = await db();
    await seedServerComment(d, 'S');
    await seedPhoto(d, 'pS', 'S', '2026-01-01T00:00:00.000Z');
    await outboxRepo.markFailed(d, 'pS', 'photo_too_large: no');
    const fetchImpl = routedFetch([[/\/comments\/S$/, { status: 204 }]]);

    const res = await deleteOwnComment(
      { id: 'S', source: 'server' },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now },
    );

    expect(res?.outcome).toBe('drained');
    expect(await outboxRepo.count(d)).toBe(0);
    // Only the DELETE went out; the photo was never retried.
    expect(calls(fetchImpl).map(([url]) => url)).toEqual([`${BASE}/v1/comments/S`]);
  });
});

// ---------------------------------------------------------------------------
// L — drain coalescing
// ---------------------------------------------------------------------------

describe('a drain joined while running', () => {
  it('forces the follow-up when a manual retry joins an automatic drain', async () => {
    const d = await db();
    // A failed item still inside its backoff: only a forced drain sends it.
    await seedLocalComment(d, 'backoff', '2026-10-06T12:00:00.000Z');
    await outboxRepo.markFailed(d, 'backoff', 'x: y');
    await seedLocalComment(d, 'slow', '2026-10-06T11:00:00.000Z');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).endsWith('/slow')) await gate;
      const id = String(url).split('/').pop()!;
      return response(201, feedComment(id));
    }) as unknown as typeof fetch;
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now };

    const automatic = drainOutbox(deps);
    const manual = retryOutbox(deps);
    release();
    await Promise.all([automatic, manual]);

    expect(await outboxRepo.getById(d, 'backoff')).toBeNull();
    expect((await commentsRepo.getById(d, 'backoff'))?.source).toBe('server');
  });

  it('never hands a caller a drain that finished before it asked', async () => {
    // One caller per scenario, arriving at a different microtask depth after the
    // running drain announces its change (just before it finishes). It queues a
    // report and asks for a drain; whatever moment it lands in, the drain it is
    // handed must have sent that report by the time it settles. A caller that
    // landed between the loop's last follow-up check and the drain being
    // cleared used to be handed the finished drain, with its report unsent.
    const stranded: number[] = [];
    for (let depth = 0; depth < 40; depth++) {
      resetSyncStateForTests();
      const d = await db();
      await seedLocalComment(d, 'first', '2026-01-01T00:00:00.000Z');
      const fetchImpl = jest.fn(async (url: string) =>
        String(url).endsWith('/reports')
          ? response(201, { reportId: 'r' })
          : response(201, feedComment(String(url).split('/').pop()!)),
      ) as unknown as typeof fetch;
      const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, now };

      let probe: Promise<void> = Promise.resolve();
      const stop = onSyncChange(() => {
        stop();
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < depth; i++) p = p.then(() => undefined);
        probe = p.then(async () => {
          // Not awaited before the drain call: the test adapter writes the row
          // synchronously, so it is queued at this exact microtask.
          void outboxRepo.enqueue(d, {
            id: 'late',
            kind: 'report',
            trailId: 'aawt',
            waypointId: 'w_1',
            payload: { commentId: 'theirs', reason: 'spam', detail: null },
            createdAt: '2026-01-02T00:00:00.000Z',
          });
          await drainOutbox(deps);
          if (await outboxRepo.getById(d, 'late')) stranded.push(depth);
        });
      });

      await drainOutbox(deps);
      await probe;
      // Let any drain the probe started finish before the next scenario.
      await drainOutbox(deps);
    }

    expect(stranded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L — an unsent plan edit is never overwritten by a pull
// ---------------------------------------------------------------------------

function plan(over: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'p1',
    trailId: 'heysen',
    name: 'Heysen',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...over,
  };
}

function plansFeed(entries: PlanDocument[], syncedAt = 'T1') {
  return {
    body: {
      plans: entries.map((p) => ({
        id: p.id,
        trailId: p.trailId,
        document: p,
        shareId: null,
        updatedAt: p.updatedAt,
      })),
      nextCursor: null,
      syncedAt,
    },
  };
}

describe('pullPlans', () => {
  it('skips a plan whose local edit is still queued, even when the server stamp is newer', async () => {
    const d = await db();
    // The phone's clock is behind: its edit is stamped before the server copy
    // it was made after.
    const mine = plan({ name: 'Mine', updatedAt: '2026-05-01T00:00:00Z' });
    await plansRepo.upsertLocal(d, mine);
    await enqueuePlan('heysen', mine, { db: d, now });
    const fetchImpl = routedFetch([
      [/\/v1\/plans/, plansFeed([plan({ name: 'Theirs', updatedAt: '2026-06-01T00:00:00Z' })])],
    ]);

    const res = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });

    expect(res.outcome).toBe('pulled');
    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Mine');
    expect(refreshPlan).not.toHaveBeenCalled();
  });

  it('skips a server copy of a plan whose delete is still queued here', async () => {
    const d = await db();
    const mine = plan({ name: 'Mine', updatedAt: '2026-05-01T00:00:00Z' });
    await plansRepo.upsertLocal(d, mine);
    // Deleted on the phone with its clock behind; the DELETE has not gone out.
    await plansRepo.tombstone(d, mine.id, '2026-05-02T00:00:00Z');
    await outboxRepo.enqueue(d, {
      id: 'del-1',
      kind: 'plan-delete',
      trailId: 'heysen',
      waypointId: mine.id,
      payload: { id: mine.id },
      createdAt: '2026-05-02T00:00:00Z',
    });
    const fetchImpl = routedFetch([
      [/\/v1\/plans/, plansFeed([plan({ name: 'Theirs', updatedAt: '2026-06-01T00:00:00Z' })])],
    ]);

    const res = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });

    expect(res.outcome).toBe('pulled');
    // Still deleted here: the pull did not resurrect what the queue is about
    // to delete (and the next edit would then have dropped that delete).
    expect(await plansRepo.getByTrail(d, 'heysen')).toBeNull();
    expect(refreshPlan).not.toHaveBeenCalled();
  });

  it('skips a server tombstone for a plan whose edit is still queued here', async () => {
    const d = await db();
    const mine = plan({ name: 'Mine', updatedAt: '2026-05-01T00:00:00Z' });
    await plansRepo.upsertLocal(d, mine);
    await enqueuePlan('heysen', mine, { db: d, now });
    const fetchImpl = routedFetch([
      [
        /\/v1\/plans/,
        {
          status: 200,
          body: {
            plans: [{ id: mine.id, trailId: 'heysen', deleted: true, updatedAt: '2026-06-01T00:00:00Z' }],
            nextCursor: null,
            syncedAt: 'T1',
          },
        },
      ],
    ]);

    const res = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });

    expect(res.outcome).toBe('pulled');
    // The queued PUT will undelete the plan server-side anyway; deleting the
    // local copy first would have lost the edit for nothing.
    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Mine');
    expect(refreshPlan).not.toHaveBeenCalled();
  });

  it('applies the server copy once nothing is queued for the plan', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, plan({ name: 'Mine', updatedAt: '2026-05-01T00:00:00Z' }));
    const fetchImpl = routedFetch([
      [/\/v1\/plans/, plansFeed([plan({ name: 'Theirs', updatedAt: '2026-06-01T00:00:00Z' })])],
    ]);

    await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });

    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Theirs');
  });

  it('is single-flight: an overlapping call joins, then one follow-up pull runs', async () => {
    const d = await db();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 0;
    const fetchImpl = jest.fn(async () => {
      n += 1;
      if (n === 1) await gate;
      return response(200, plansFeed([], `T${n}`).body);
    }) as unknown as typeof fetch;
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan };

    const a = pullPlans(deps);
    const b = pullPlans(deps);
    const c = pullPlans(deps);
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    // Three callers, two requests: the running pull plus ONE follow-up.
    expect(calls(fetchImpl)).toHaveLength(2);
    expect(ra).toEqual(rb);
    expect(rb).toEqual(rc);
    expect(ra.syncedAt).toBe('T2');
  });
});
