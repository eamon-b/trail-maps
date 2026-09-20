/**
 * Plan sync — the outbox branches, the delta pull, and the store hook.
 *
 * The three things that decide whether a plan survives the trip between two
 * devices: a queued write goes out authenticated and comes back stamped with
 * the SERVER's clock (the only clock last-writer-wins can compare), a 409
 * `plan_exists` adopts the server's id instead of fighting it, and a burst of
 * toggles is one queued row rather than one per tap.
 */

import type { PlanDocument } from '@lib/plan-types';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as outboxRepo from '../../db/outbox-repo';
import * as plansRepo from '../../db/plans-repo';
import type { Session } from '../../api/auth';
import {
  PLANS_SYNC_KEY,
  drainOutbox,
  enqueuePlan,
  pullPlans,
  submitPlan,
  submitPlanDelete,
} from '../comment-sync';
import { handlePlanChanged, registerPlanSync, unregisterPlanSync } from '../plan-sync';
import { setPlanChangedHandler } from '../../state/plans-store';

// The store itself stays real (comment-sync reads it); only the hook setter is
// wrapped, so the test can see exactly what the app installs at start-up.
jest.mock('../../state/plans-store', () => {
  const actual = jest.requireActual('../../state/plans-store');
  return { ...actual, setPlanChangedHandler: jest.fn(actual.setPlanChangedHandler) };
});

const BASE = 'https://api.test';
const SESSION: Session = { userId: 'u1', token: 'tok', displayName: 'Me' };
const getSessionFn = async () => SESSION;
/** Never reach the real (native) database from a pull. */
const refreshPlan = jest.fn();

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

interface Step {
  status?: number;
  body?: unknown;
  throw?: boolean;
}

function scriptedFetch(steps: Step[]) {
  let i = 0;
  const fn = jest.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step.throw) throw new Error('offline');
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

function doc(over: Partial<PlanDocument> = {}): PlanDocument {
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

const entry = (d: PlanDocument, updatedAt: string) => ({
  id: d.id,
  trailId: d.trailId,
  document: { ...d, updatedAt },
  shareId: null,
  updatedAt,
});

const requests = (fetchImpl: typeof fetch) => (fetchImpl as unknown as jest.Mock).mock.calls;

async function planSince(d: SqlDatabase): Promise<string | null> {
  const row = await d.getFirstAsync<{ plans_synced_at: string | null }>(
    'SELECT plans_synced_at FROM sync_state WHERE trail_id = ?',
    [PLANS_SYNC_KEY],
  );
  return row?.plans_synced_at ?? null;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the plan outbox branch', () => {
  it('PUTs the queued document with the session token and stores the server clock', async () => {
    const d = await db();
    const local = doc();
    await plansRepo.upsertLocal(d, local);
    const fetchImpl = scriptedFetch([{ status: 200, body: entry(local, '2026-05-05T00:00:00Z') }]);

    const res = await submitPlan('heysen', local, { db: d, baseUrl: BASE, fetchImpl, getSessionFn });

    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 0 });
    expect(requests(fetchImpl)[0][0]).toBe(`${BASE}/v1/plans/p1`);
    expect(requests(fetchImpl)[0][1].method).toBe('PUT');
    expect(requests(fetchImpl)[0][1].headers.Authorization).toBe('Bearer tok');
    expect(await outboxRepo.count(d)).toBe(0);

    const stored = await plansRepo.getById(d, 'p1');
    expect(stored?.source).toBe('server');
    expect(stored?.updatedAt).toBe('2026-05-05T00:00:00Z');
  });

  it('adopts the id a 409 plan_exists names and re-PUTs it exactly once', async () => {
    const d = await db();
    const local = doc();
    await plansRepo.upsertLocal(d, local);
    const fetchImpl = scriptedFetch([
      {
        status: 409,
        body: { error: { code: 'plan_exists', message: 'already' }, existingId: 'server-id' },
      },
      { status: 200, body: entry(doc({ id: 'server-id' }), '2026-05-05T00:00:00Z') },
    ]);

    const res = await submitPlan('heysen', local, { db: d, baseUrl: BASE, fetchImpl, getSessionFn });

    expect(res).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(requests(fetchImpl)).toHaveLength(2);
    expect(requests(fetchImpl)[1][0]).toBe(`${BASE}/v1/plans/server-id`);
    // The trail now holds exactly one live plan, under the server's id.
    expect(await plansRepo.getById(d, 'p1')).toBeNull();
    expect((await plansRepo.getByTrail(d, 'heysen'))?.id).toBe('server-id');
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('keeps a second plan_exists as a failure rather than looping', async () => {
    const d = await db();
    const local = doc();
    await plansRepo.upsertLocal(d, local);
    const fetchImpl = scriptedFetch([
      {
        status: 409,
        body: { error: { code: 'plan_exists', message: 'already' }, existingId: 'server-id' },
      },
      {
        status: 409,
        body: { error: { code: 'plan_exists', message: 'still' }, existingId: 'other-id' },
      },
    ]);

    const res = await submitPlan('heysen', local, { db: d, baseUrl: BASE, fetchImpl, getSessionFn });

    expect(res).toMatchObject({ outcome: 'drained', sent: 0, failed: 1 });
    expect(requests(fetchImpl)).toHaveLength(2);
  });

  it('stops the whole drain on a network error and leaves the row pending', async () => {
    const d = await db();
    const local = doc();
    await plansRepo.upsertLocal(d, local);
    const fetchImpl = scriptedFetch([{ throw: true }]);

    const res = await submitPlan('heysen', local, { db: d, baseUrl: BASE, fetchImpl, getSessionFn });

    expect(res.outcome).toBe('offline');
    const rows = await outboxRepo.listPending(d);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    // Unconfirmed: the local copy keeps this device's clock.
    expect((await plansRepo.getById(d, 'p1'))?.source).toBe('local');
  });

  it('marks an oversized or malformed document failed and keeps it visible', async () => {
    const d = await db();
    const local = doc();
    await plansRepo.upsertLocal(d, local);
    const fetchImpl = scriptedFetch([
      { status: 413, body: { error: { code: 'plan_too_large', message: 'too big' } } },
    ]);

    const res = await submitPlan('heysen', local, { db: d, baseUrl: BASE, fetchImpl, getSessionFn });

    expect(res).toMatchObject({ outcome: 'drained', sent: 0, failed: 1 });
    const row = (await outboxRepo.listPending(d))[0];
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('plan_too_large');
  });

  it('settles a plan-delete on a 204, and equally on a 404', async () => {
    const d = await db();
    const ok = scriptedFetch([{ status: 204 }]);
    await submitPlanDelete('heysen', 'p1', { db: d, baseUrl: BASE, fetchImpl: ok, getSessionFn });
    expect(requests(ok)[0][1].method).toBe('DELETE');
    expect(await outboxRepo.count(d)).toBe(0);

    const gone = scriptedFetch([
      { status: 404, body: { error: { code: 'not_found', message: 'no' } } },
    ]);
    const res = await submitPlanDelete('heysen', 'p2', {
      db: d,
      baseUrl: BASE,
      fetchImpl: gone,
      getSessionFn,
    });
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('refuses to queue a plan for an imported trail', async () => {
    const d = await db();
    await expect(enqueuePlan('u_abc', doc({ trailId: 'u_abc' }), { db: d })).rejects.toThrow(
      /imported trails/i,
    );
    expect(await outboxRepo.count(d)).toBe(0);
  });
});

describe('coalescing', () => {
  it('keeps only the newest queued write for a plan', async () => {
    const d = await db();
    await enqueuePlan('heysen', doc({ updatedAt: 'T1' }), { db: d });
    await enqueuePlan('heysen', doc({ updatedAt: 'T2' }), { db: d });
    await enqueuePlan('heysen', doc({ updatedAt: 'T3', name: 'Renamed' }), { db: d });

    const rows = await outboxRepo.listPending(d);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payloadJson)).toMatchObject({ updatedAt: 'T3', name: 'Renamed' });
  });

  it('leaves another plan, and an in-flight row, alone', async () => {
    const d = await db();
    await enqueuePlan('heysen', doc({ id: 'p1' }), { db: d });
    await enqueuePlan('aawt', doc({ id: 'p2', trailId: 'aawt' }), { db: d });
    const inFlight = (await outboxRepo.listPending(d)).find((r) => r.waypointId === 'p1');
    await outboxRepo.markSending(d, inFlight!.id);

    await enqueuePlan('heysen', doc({ id: 'p1', updatedAt: 'T9' }), { db: d });

    // The in-flight p1 row is spared (the drain still owns its response), the
    // other trail's row is untouched, and the new p1 write joins the queue.
    const rows = await outboxRepo.listPending(d);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'sending')).toHaveLength(1);
    expect(rows.filter((r) => r.waypointId === 'p2')).toHaveLength(1);
    expect(await outboxRepo.replacePending(d, 'plan', 'nobody')).toBe(0);
  });

  it('drops a queued write when the plan is being deleted', async () => {
    const d = await db();
    await enqueuePlan('heysen', doc(), { db: d });
    const fetchImpl = scriptedFetch([{ status: 204 }]);
    await submitPlanDelete('heysen', 'p1', { db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(requests(fetchImpl)).toHaveLength(1);
    expect(await outboxRepo.count(d)).toBe(0);
  });
});

describe('pullPlans', () => {
  it('applies a snapshot, then a delta with a tombstone, advancing the mark', async () => {
    const d = await db();
    const remote = doc({ updatedAt: '2026-03-01T00:00:00Z' });
    const fetchImpl = scriptedFetch([
      { body: { plans: [entry(remote, '2026-03-01T00:00:00Z')], nextCursor: null, syncedAt: 'T1' } },
      {
        body: {
          plans: [{ id: 'p1', trailId: 'heysen', deleted: true, updatedAt: '2026-03-02T00:00:00Z' }],
          nextCursor: null,
          syncedAt: 'T2',
        },
      },
    ]);

    const first = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });
    expect(first).toMatchObject({ outcome: 'pulled', applied: 1, syncedAt: 'T1' });
    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Heysen');
    expect(await planSince(d)).toBe('T1');
    expect(refreshPlan).toHaveBeenCalledWith('heysen');

    const second = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });
    expect(second.outcome).toBe('pulled');
    expect(await plansRepo.getByTrail(d, 'heysen')).toBeNull();
    expect(await planSince(d)).toBe('T2');
    expect(String(requests(fetchImpl)[1][0])).toContain('since=T1');
  });

  it('leaves a newer local edit alone (last writer wins)', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc({ name: 'Mine', updatedAt: '2026-06-01T00:00:00Z' }));
    const fetchImpl = scriptedFetch([
      {
        body: {
          plans: [entry(doc({ name: 'Theirs' }), '2026-05-01T00:00:00Z')],
          nextCursor: null,
          syncedAt: 'T1',
        },
      },
    ]);

    await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });

    const stored = await plansRepo.getByTrail(d, 'heysen');
    expect(stored?.name).toBe('Mine');
    // Nothing changed for this trail, so no cache nudge was needed.
    expect(refreshPlan).not.toHaveBeenCalled();
    // The mark still advances — the entry WAS seen, it just lost.
    expect(await planSince(d)).toBe('T1');
  });

  it('skips a document this build cannot read rather than storing it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const d = await db();
    const fetchImpl = scriptedFetch([
      {
        body: {
          plans: [
            {
              id: 'p9',
              trailId: 'heysen',
              document: { id: 'p9', trailId: 'heysen', version: 99 },
              shareId: null,
              updatedAt: 'T1',
            },
          ],
          nextCursor: null,
          syncedAt: 'T1',
        },
      },
    ]);

    const res = await pullPlans({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, refreshPlan });
    expect(res.applied).toBe(0);
    expect(await plansRepo.getByTrail(d, 'heysen')).toBeNull();
    warn.mockRestore();
  });

  it('skips silently with no identity, and reports offline on a transport failure', async () => {
    const d = await db();
    const none = await pullPlans({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ body: {} }]),
      getSessionFn: async () => null,
    });
    expect(none.outcome).toBe('no-identity');
    expect(await planSince(d)).toBeNull();

    const off = await pullPlans({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ throw: true }]),
      getSessionFn,
      refreshPlan,
    });
    expect(off.outcome).toBe('offline');
    expect(await planSince(d)).toBeNull();

    expect((await pullPlans({ db: d, baseUrl: undefined })).outcome).toBe('unconfigured');
  });
});

describe('the store hook', () => {
  afterEach(() => unregisterPlanSync());

  it('queues an edit to a bundled trail and debounces the drain', async () => {
    jest.useFakeTimers();
    const enqueue = jest.fn(async () => {});
    const drain = jest.fn(async () => ({}));

    handlePlanChanged(doc(), { enqueue, drain, debounceMs: 100 });
    handlePlanChanged(doc({ updatedAt: 'T2' }), { enqueue, drain, debounceMs: 100 });
    // Let the enqueue promises settle (the drain is scheduled from .then).
    await Promise.resolve();
    await Promise.resolve();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(drain).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(drain).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('never queues a plan for an imported trail', async () => {
    const enqueue = jest.fn(async () => {});
    const drain = jest.fn(async () => ({}));
    handlePlanChanged(doc({ trailId: 'u_abc' }), { enqueue, drain });
    await Promise.resolve();
    expect(enqueue).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('installs a handler the store can call, and takes it away again', async () => {
    const enqueue = jest.fn(async () => {});
    const setHandler = setPlanChangedHandler as jest.Mock;

    registerPlanSync({ enqueue, drain: jest.fn(async () => ({})), debounceMs: 1 });

    const installed = setHandler.mock.calls[setHandler.mock.calls.length - 1][0] as (
      doc: PlanDocument,
    ) => void;
    expect(typeof installed).toBe('function');
    installed(doc());
    await Promise.resolve();
    expect(enqueue).toHaveBeenCalledWith('heysen', expect.objectContaining({ id: 'p1' }));

    unregisterPlanSync();
    expect(setHandler.mock.calls[setHandler.mock.calls.length - 1][0]).toBeUndefined();
  });
});

describe('drainOutbox with nothing queued', () => {
  it('is idle', async () => {
    const d = await db();
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl: scriptedFetch([]), getSessionFn });
    expect(res.outcome).toBe('idle');
  });
});

describe('queued row shape', () => {
  it('stamps an explicit ISO createdAt, so the backoff never parses it as local time', async () => {
    const d = await db();
    await enqueuePlan('heysen', doc(), { db: d });
    const row = (await outboxRepo.listPending(d))[0];
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.kind).toBe('plan');
    expect(row.trailId).toBe('heysen');
    // The entity key is the plan id, which is what coalescing matches on.
    expect(row.waypointId).toBe('p1');
  });
});
