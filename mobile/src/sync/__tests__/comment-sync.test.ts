import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as commentsRepo from '../../db/comments-repo';
import * as outboxRepo from '../../db/outbox-repo';
import type { Session } from '../../api/auth';
import {
  backoffMs,
  deleteOwnComment,
  drainOutbox,
  isDrainable,
  pullTrail,
  submitComment,
} from '../comment-sync';
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
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => raw,
    };
  });
  return fn as unknown as typeof fetch;
}

function feedComment(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    waypointId: 'w_1',
    displayName: 'Me',
    text: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function readSince(d: SqlDatabase, trailId: string): Promise<string | null> {
  const row = await d.getFirstAsync<{ last_synced_at: string | null }>(
    'SELECT last_synced_at FROM sync_state WHERE trail_id = ?',
    [trailId],
  );
  return row?.last_synced_at ?? null;
}

describe('backoff', () => {
  it('is 0 for a never-attempted item and grows exponentially, capped at 1h', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(100)).toBe(60 * 60 * 1000);
  });

  it('gates drainability on the elapsed window', () => {
    const created = Date.parse('2026-01-01T00:00:00Z');
    expect(isDrainable({ createdAt: '2026-01-01T00:00:00Z', attempts: 0 }, created)).toBe(true);
    expect(isDrainable({ createdAt: '2026-01-01T00:00:00Z', attempts: 1 }, created + 59_000)).toBe(
      false,
    );
    expect(isDrainable({ createdAt: '2026-01-01T00:00:00Z', attempts: 1 }, created + 60_000)).toBe(
      true,
    );
  });
});

describe('pullTrail', () => {
  it('applies a snapshot, then a delta with a tombstone, advancing the cursor', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([
      // snapshot (no since)
      { body: { comments: [feedComment('a', { updatedAt: '2026-01-01T00:00:00Z' })], nextCursor: null, syncedAt: 'T1' } },
      // delta (since=T1): tombstone a, add c
      {
        body: {
          comments: [
            { id: 'a', waypointId: 'w_1', deleted: true, updatedAt: '2026-01-02T00:00:00Z' },
            feedComment('c', { text: 'new', updatedAt: '2026-01-02T00:00:01Z' }),
          ],
          nextCursor: null,
          syncedAt: 'T2',
        },
      },
    ]);

    const first = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(first.outcome).toBe('pulled');
    expect(await commentsRepo.getById(d, 'a')).not.toBeNull();
    expect(await readSince(d, 'aawt')).toBe('T1');

    const second = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(second.outcome).toBe('pulled');
    expect(await commentsRepo.getById(d, 'a')).toBeNull(); // tombstoned
    expect((await commentsRepo.getById(d, 'c'))?.body).toBe('new');
    expect(await readSince(d, 'aawt')).toBe('T2');
    // Second request carried since=T1.
    expect((fetchImpl as jest.Mock).mock.calls[1][0]).toContain('since=T1');
  });

  it('no-ops when the API is unconfigured', async () => {
    const d = await db();
    const res = await pullTrail('aawt', { db: d, baseUrl: undefined });
    expect(res.outcome).toBe('unconfigured');
  });

  it('reports offline on a transport failure without advancing the cursor', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([{ throw: true }]);
    const res = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(res.outcome).toBe('offline');
    expect(await readSince(d, 'aawt')).toBeNull();
  });
});

async function seedLocal(d: SqlDatabase, id: string) {
  await commentsRepo.insertLocalComment(d, {
    id,
    trailId: 'aawt',
    waypointId: 'w_1',
    authorId: 'u1',
    authorName: 'Me',
    body: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  await outboxRepo.enqueue(d, {
    id,
    kind: 'comment',
    trailId: 'aawt',
    waypointId: 'w_1',
    payload: { trailId: 'aawt', waypointId: 'w_1', text: 'hi' },
    createdAt: '2026-01-01T00:00:00Z',
  });
}

describe('drainOutbox', () => {
  it('confirms a successful PUT: flips source and clears the outbox', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const fetchImpl = scriptedFetch([{ status: 201, body: feedComment('m1') }]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res).toMatchObject({ outcome: 'drained', sent: 1, failed: 0 });
    expect(await outboxRepo.count(d)).toBe(0);
    expect((await commentsRepo.getById(d, 'm1'))?.source).toBe('server');
  });

  it('stops on a network error and leaves the item pending', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const fetchImpl = scriptedFetch([{ throw: true }]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res.outcome).toBe('offline');
    expect((await outboxRepo.getById(d, 'm1'))?.status).toBe('pending');
    expect((await commentsRepo.getById(d, 'm1'))?.source).toBe('local');
  });

  it('pauses the queue on a 401', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const fetchImpl = scriptedFetch([
      { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
    ]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res.outcome).toBe('unauthorized');
    expect((await outboxRepo.getById(d, 'm1'))?.status).toBe('pending');
  });

  it('marks a 4xx validation failure but keeps the comment visible', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const fetchImpl = scriptedFetch([
      { status: 400, body: { error: { code: 'invalid_text', message: 'too long' } } },
    ]);

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res).toMatchObject({ outcome: 'drained', sent: 0, failed: 1 });
    const item = await outboxRepo.getById(d, 'm1');
    expect(item?.status).toBe('failed');
    expect(item?.attempts).toBe(1);
    expect(await commentsRepo.getById(d, 'm1')).not.toBeNull();
  });

  it('is idempotent: re-draining a crashed (sending) item replays the PUT', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    // Simulate a crash mid-send: the row is stuck in "sending".
    await outboxRepo.markSending(d, 'm1');
    const fetchImpl = scriptedFetch([{ status: 200, body: feedComment('m1') }]); // replay → 200

    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(res).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(await outboxRepo.count(d)).toBe(0);
    expect((await commentsRepo.getById(d, 'm1'))?.source).toBe('server');
  });

  it('reports no-identity when there is no session', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const res = await drainOutbox({
      db: d,
      baseUrl: BASE,
      fetchImpl: scriptedFetch([{ status: 201, body: feedComment('m1') }]),
      getSessionFn: async () => null,
    });
    expect(res.outcome).toBe('no-identity');
  });
});

describe('submitComment', () => {
  it('inserts an optimistic row, enqueues, and drains', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([{ status: 201, body: feedComment('any', { text: 'note' }) }]);

    const { id, drain } = await submitComment(
      { trailId: 'aawt', waypointId: 'w_1', text: 'note', session: SESSION },
      { db: d, baseUrl: BASE, fetchImpl },
    );
    expect(drain.outcome).toBe('drained');
    expect((await commentsRepo.getById(d, id))?.source).toBe('server');
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('keeps the row local and queued when offline', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([{ throw: true }]);
    const { id, drain } = await submitComment(
      { trailId: 'aawt', waypointId: 'w_1', text: 'note', session: SESSION },
      { db: d, baseUrl: BASE, fetchImpl },
    );
    expect(drain.outcome).toBe('offline');
    expect((await commentsRepo.getById(d, id))?.source).toBe('local');
    expect(await outboxRepo.count(d)).toBe(1);
  });
});

describe('deleteOwnComment', () => {
  it('cancels a never-synced local comment', async () => {
    const d = await db();
    await seedLocal(d, 'L');
    const res = await deleteOwnComment({ id: 'L', source: 'local' }, { db: d });
    expect(res).toBeUndefined();
    expect(await commentsRepo.getById(d, 'L')).toBeNull();
    expect(await outboxRepo.getById(d, 'L')).toBeNull();
  });

  it('enqueues + drains a delete for a server comment', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, {
      id: 'S',
      trailId: 'aawt',
      waypointId: 'w_1',
      displayName: 'Me',
      text: 'hi',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const fetchImpl = scriptedFetch([{ status: 204 }]);
    const res = await deleteOwnComment(
      { id: 'S', source: 'server' },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn },
    );
    expect(res?.outcome).toBe('drained');
    expect(await commentsRepo.getById(d, 'S')).toBeNull();
    expect(await outboxRepo.count(d)).toBe(0);
  });
});

async function seedServerCommentWithPhoto(
  d: SqlDatabase,
  commentId: string,
  photoId: string,
  createdAt = '2026-01-01T00:00:00Z',
) {
  await commentsRepo.upsertServerComment(d, {
    id: commentId,
    trailId: 'aawt',
    waypointId: 'w_1',
    displayName: 'Me',
    text: 'hi',
    waterStatus: null,
    observedAt: null,
    createdAt,
  });
  await outboxRepo.enqueue(d, {
    id: photoId,
    kind: 'photo',
    trailId: 'aawt',
    waypointId: 'w_1',
    payload: { commentId, localUri: 'file:///a.jpg', contentType: 'image/jpeg' },
    createdAt,
  });
}

const PHOTO_OK = {
  status: 201,
  body: { photoUrl: 'https://cdn/a.jpg', photoUrls: ['https://cdn/a.jpg'] },
};
const readBytes = jest.fn(async () => new Uint8Array([1, 2, 3]));

describe('pullTrail photo persistence', () => {
  it('persists photoUrls from a synced comment', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([
      {
        body: {
          comments: [feedComment('ph', { photoUrls: ['https://cdn/x.jpg'] })],
          nextCursor: null,
          syncedAt: 'T1',
        },
      },
    ]);
    await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect((await commentsRepo.getById(d, 'ph'))?.photoUrls).toEqual(['https://cdn/x.jpg']);
  });
});

describe('drainOutbox photo uploads', () => {
  beforeEach(() => readBytes.mockClear());

  it('does NOT send a photo while its comment is still local, then sends once confirmed', async () => {
    const d = await db();
    // Local (unconfirmed) comment + a photo row pointing at it. No comment outbox
    // row, so the photo is the only pending item.
    await commentsRepo.insertLocalComment(d, {
      id: 'c1',
      trailId: 'aawt',
      waypointId: 'w_1',
      authorId: 'u1',
      authorName: 'Me',
      body: 'hi',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      photoUrls: ['file:///a.jpg'],
    });
    await outboxRepo.enqueue(d, {
      id: 'p1',
      kind: 'photo',
      trailId: 'aawt',
      waypointId: 'w_1',
      payload: { commentId: 'c1', localUri: 'file:///a.jpg', contentType: 'image/jpeg' },
      createdAt: '2026-01-01T00:00:00Z',
    });

    const fetchImpl = scriptedFetch([PHOTO_OK]);
    const res1 = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    // Gated: no upload attempted, no bytes read, row stays pending.
    expect(res1.sent).toBe(0);
    expect(readBytes).not.toHaveBeenCalled();
    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(0);
    expect((await outboxRepo.getById(d, 'p1'))?.status).toBe('pending');
    expect((await commentsRepo.getById(d, 'c1'))?.photoUrls).toEqual(['file:///a.jpg']);

    // Confirm the comment server-side; now the photo is sendable.
    await commentsRepo.confirmServer(d, 'c1', {
      displayName: 'Me',
      text: 'hi',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const res2 = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    expect(res2).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(readBytes).toHaveBeenCalledWith('file:///a.jpg');
    expect(await outboxRepo.count(d)).toBe(0);
    expect((await commentsRepo.getById(d, 'c1'))?.photoUrls).toEqual(['https://cdn/a.jpg']);
  });

  it('merges returned photoUrls and emits a sync change on 201', async () => {
    const d = await db();
    await seedServerCommentWithPhoto(d, 'c2', 'p2');
    const fetchImpl = scriptedFetch([PHOTO_OK]);
    const changes: SyncChange[] = [];
    const stop = onSyncChange((c) => changes.push(c));
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    stop();
    expect(res).toMatchObject({ outcome: 'drained', sent: 1 });
    expect((await commentsRepo.getById(d, 'c2'))?.photoUrls).toEqual(['https://cdn/a.jpg']);
    expect(changes).toEqual([{ trailId: 'aawt', waypointIds: ['w_1'] }]);
  });

  it.each([
    [413, 'photo_too_large'],
    [409, 'too_many_photos'],
    [415, 'unsupported_media_type'],
  ])('marks a photo failed on %s and keeps it visible', async (status, code) => {
    const d = await db();
    await seedServerCommentWithPhoto(d, 'c3', 'p3');
    const fetchImpl = scriptedFetch([{ status, body: { error: { code, message: 'no' } } }]);
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    expect(res).toMatchObject({ outcome: 'drained', sent: 0, failed: 1 });
    const item = await outboxRepo.getById(d, 'p3');
    expect(item?.status).toBe('failed');
    expect(item?.attempts).toBe(1);
  });

  it('stops the drain and leaves the photo pending on a network error', async () => {
    const d = await db();
    await seedServerCommentWithPhoto(d, 'c4', 'p4');
    const fetchImpl = scriptedFetch([{ throw: true }]);
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    expect(res.outcome).toBe('offline');
    expect((await outboxRepo.getById(d, 'p4'))?.status).toBe('pending');
  });

  it('pauses the queue on a 401 during photo upload', async () => {
    const d = await db();
    await seedServerCommentWithPhoto(d, 'c5', 'p5');
    const fetchImpl = scriptedFetch([
      { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
    ]);
    const res = await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn, readBytes });
    expect(res.outcome).toBe('unauthorized');
    expect((await outboxRepo.getById(d, 'p5'))?.status).toBe('pending');
  });
});

describe('submitComment with a photo', () => {
  beforeEach(() => readBytes.mockClear());

  it('shows an optimistic preview, then confirms the comment and uploads the photo', async () => {
    const d = await db();
    // Comment PUT (201) then photo POST (201).
    const fetchImpl = scriptedFetch([{ status: 201, body: feedComment('any', { text: 'note' }) }, PHOTO_OK]);
    const { id, drain } = await submitComment(
      {
        trailId: 'aawt',
        waypointId: 'w_1',
        text: 'note',
        session: SESSION,
        photo: { uri: 'file:///pic.jpg', contentType: 'image/jpeg' },
      },
      { db: d, baseUrl: BASE, fetchImpl, readBytes },
    );
    expect(drain.outcome).toBe('drained');
    expect(drain.sent).toBe(2); // comment + photo
    const row = await commentsRepo.getById(d, id);
    expect(row?.source).toBe('server');
    expect(row?.photoUrls).toEqual(['https://cdn/a.jpg']);
    expect(await outboxRepo.count(d)).toBe(0);
    expect(readBytes).toHaveBeenCalledWith('file:///pic.jpg');
  });

  it('keeps the local preview and queues the photo when offline', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([{ throw: true }]);
    const { id, drain } = await submitComment(
      {
        trailId: 'aawt',
        waypointId: 'w_1',
        text: 'note',
        session: SESSION,
        photo: { uri: 'file:///pic.jpg', contentType: 'image/jpeg' },
      },
      { db: d, baseUrl: BASE, fetchImpl, readBytes },
    );
    expect(drain.outcome).toBe('offline');
    const row = await commentsRepo.getById(d, id);
    expect(row?.source).toBe('local');
    expect(row?.photoUrls).toEqual(['file:///pic.jpg']); // optimistic preview
    // Comment + photo both queued; the photo never read bytes (comment blocked).
    expect(await outboxRepo.count(d)).toBe(2);
    expect(readBytes).not.toHaveBeenCalled();
  });
});

describe('sync-change emission', () => {
  function collect(): { changes: SyncChange[]; stop: () => void } {
    const changes: SyncChange[] = [];
    const stop = onSyncChange((c) => changes.push(c));
    return { changes, stop };
  }

  it('emits after a drain that flips rows to server', async () => {
    const d = await db();
    await seedLocal(d, 'm1');
    const fetchImpl = scriptedFetch([{ status: 201, body: feedComment('m1') }]);
    const { changes, stop } = collect();
    await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    stop();
    expect(changes).toEqual([{ trailId: 'aawt', waypointIds: ['w_1'] }]);
  });

  it('emits after a pull that applied rows', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([
      { body: { comments: [feedComment('a')], nextCursor: null, syncedAt: 'T1' } },
    ]);
    const { changes, stop } = collect();
    await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    stop();
    expect(changes).toEqual([{ trailId: 'aawt', waypointIds: ['w_1'] }]);
  });

  it('does not emit when a drain sends nothing', async () => {
    const d = await db();
    const fetchImpl = scriptedFetch([]);
    const { changes, stop } = collect();
    await drainOutbox({ db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    stop();
    expect(changes).toEqual([]);
  });
});

describe('drain concurrency', () => {
  it('coalesces overlapping drains so a photo uploads exactly once', async () => {
    const d = await db();
    await seedServerCommentWithPhoto(d, 'conc', 'ph-conc');

    // Photo POST blocks until we release it, holding drain #1 open while
    // drain #2 is invoked. Without the mutex, #2 would also pick up the
    // in-flight 'sending' photo row and double-upload it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = jest.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 201,
        statusText: '',
        text: async () =>
          JSON.stringify({ photoUrl: 'https://cdn/a.jpg', photoUrls: ['https://cdn/a.jpg'] }),
      };
    }) as unknown as typeof fetch;

    const deps = { db: d, baseUrl: BASE, fetchImpl, readBytes, getSessionFn };
    const first = drainOutbox(deps);
    const second = drainOutbox(deps); // overlaps; must coalesce, not re-list
    release();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toEqual(r2);
    // Exactly one photo POST despite two drain calls (the coalesced follow-up
    // drain finds an empty outbox and sends nothing).
    expect((fetchImpl as unknown as jest.Mock).mock.calls.length).toBe(1);
    const row = await commentsRepo.getById(d, 'conc');
    expect(row?.photoUrls).toEqual(['https://cdn/a.jpg']);
    expect(await outboxRepo.count(d)).toBe(0);
  });
});
