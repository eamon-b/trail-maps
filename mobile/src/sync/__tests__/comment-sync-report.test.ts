/**
 * Report drain semantics.
 *
 * A report is outbox work like any other write, with one twist: it owns no
 * comment row, and a 404/410 (unknown or already-deleted comment) is a
 * *settled* report rather than a failure — there is nothing left to moderate.
 * Everything else keeps the shared branching: network stops the drain, 401
 * pauses it, 429/other 4xx marks the single item failed.
 */

import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as outboxRepo from '../../db/outbox-repo';
import type { Session } from '../../api/auth';
import { drainOutbox, submitReport } from '../comment-sync';
import { onSyncChange, type SyncChange } from '../sync-events';

const BASE = 'https://api.test';
const SESSION: Session = { userId: 'u1', token: 'tok', displayName: 'Me' };
const getSessionFn = async () => SESSION;

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
    const raw = status === 204 ? '' : JSON.stringify(step.body ?? {});
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => raw };
  });
  return fn as unknown as typeof fetch;
}

async function seedReport(d: SqlDatabase, id = 'r1', payload?: unknown) {
  await outboxRepo.enqueue(d, {
    id,
    kind: 'report',
    trailId: 'aawt',
    waypointId: 'w_1',
    payload: payload ?? { commentId: 'theirs', reason: 'spam', detail: 'buy pills' },
    createdAt: '2026-01-01T00:00:00Z',
  });
}

const REPORT_OK = { status: 201, body: { reportId: 'rep_1' } };

describe('drainOutbox — reports', () => {
  it('POSTs the report and clears the outbox on 201', async () => {
    const d = await db();
    await seedReport(d);
    const fetchImpl = scriptedFetch([REPORT_OK]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 0 });
    expect(await outboxRepo.count(d)).toBe(0);

    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/comments/theirs/report`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ reason: 'spam', detail: 'buy pills' });
  });

  it('treats an idempotent 200 repeat as sent', async () => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ status: 200, body: { reportId: 'rep_1' } }]),
      getSessionFn,
    });
    expect(res).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it.each([
    [404, 'not_found'],
    [410, 'gone'],
  ])('drops the report on %s — nothing left to moderate', async (status, code) => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ status, body: { error: { code, message: 'no' } } }]),
      getSessionFn,
    });
    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 0 });
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it.each([
    [429, 'rate_limited'],
    [400, 'invalid_reason'],
    [400, 'invalid_detail'],
  ])('marks the report failed on %s and keeps it queued', async (status, code) => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ status, body: { error: { code, message: 'no' } } }]),
      getSessionFn,
    });
    expect(res).toMatchObject({ outcome: 'drained', sent: 0, failed: 1 });
    const item = await outboxRepo.getById(d, 'r1');
    expect(item?.status).toBe('failed');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toContain(code);
  });

  it('stops the drain and leaves the report pending when offline', async () => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ throw: true }]),
      getSessionFn,
    });
    expect(res.outcome).toBe('offline');
    expect((await outboxRepo.getById(d, 'r1'))?.status).toBe('pending');
  });

  it('pauses the queue on a 401', async () => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([
        { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
      ]),
      getSessionFn,
    });
    expect(res.outcome).toBe('unauthorized');
    expect((await outboxRepo.getById(d, 'r1'))?.status).toBe('pending');
  });

  it('retries a 5xx later without charging an attempt', async () => {
    const d = await db();
    await seedReport(d);
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ status: 503, body: { error: { code: 'x', message: 'y' } } }]),
      getSessionFn,
    });
    expect(res.outcome).toBe('offline');
    const item = await outboxRepo.getById(d, 'r1');
    expect(item?.status).toBe('pending');
    expect(item?.attempts).toBe(0);
  });

  it('drops an unparseable report row without hitting the network', async () => {
    const d = await db();
    await seedReport(d, 'bad', { reason: 'vibes' }); // no commentId, unknown reason
    const fetchImpl = scriptedFetch([REPORT_OK]);
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(0);
    expect(res).toMatchObject({ sent: 0, failed: 0 });
    expect(await outboxRepo.count(d)).toBe(0);
  });
});

describe('submitReport', () => {
  it('enqueues and drains a report without touching the comment cache', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([REPORT_OK]);
    const changes: SyncChange[] = [];
    const stop = onSyncChange((c) => changes.push(c));

    const { drain } = await submitReport(
      {
        commentId: 'theirs',
        trailId: 'aawt',
        waypointId: 'w_1',
        reason: 'offensive',
        detail: '  slurs  ',
        session: SESSION,
      },
      { db: d, baseUrl: BASE, fetchImpl },
    );
    stop();

    expect(drain).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(await outboxRepo.count(d)).toBe(0);
    expect(changes).toEqual([{ trailId: 'aawt', waypointIds: ['w_1'] }]);
    // Detail is trimmed by the shared validator.
    expect(JSON.parse((fetchImpl as jest.Mock).mock.calls[0][1].body)).toEqual({
      reason: 'offensive',
      detail: 'slurs',
    });
    // Nothing was mirrored into the feed.
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM comments');
    expect(row?.n).toBe(0);
  });

  it('keeps the report queued when offline', async () => {
    const d = await db();
    const { id, drain } = await submitReport(
      {
        commentId: 'theirs',
        trailId: 'aawt',
        waypointId: 'w_1',
        reason: 'spam',
        session: SESSION,
      },
      { db: d, baseUrl: BASE, fetchImpl: scriptedFetch([{ throw: true }]) },
    );
    expect(drain.outcome).toBe('offline');
    const item = await outboxRepo.getById(d, id);
    expect(item?.kind).toBe('report');
    expect(item?.status).toBe('pending');
  });

  it('rejects an invalid detail before enqueueing', async () => {
    const d = await db();
    await expect(
      submitReport(
        {
          commentId: 'theirs',
          trailId: 'aawt',
          waypointId: 'w_1',
          reason: 'other',
          detail: 'x'.repeat(501),
          session: SESSION,
        },
        { db: d, baseUrl: BASE, fetchImpl: scriptedFetch([REPORT_OK]) },
      ),
    ).rejects.toThrow(/500 characters/);
    expect(await outboxRepo.count(d)).toBe(0);
  });
});
