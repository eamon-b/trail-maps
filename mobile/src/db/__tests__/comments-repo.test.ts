import { createMigratedTestDb, expectDbRejection } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as commentsRepo from '../comments-repo';
import * as outboxRepo from '../outbox-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const TRAIL = 'aawt';
const WP = 'w_abcd1234';

function serverInput(overrides: Partial<commentsRepo.ServerCommentInput> = {}): commentsRepo.ServerCommentInput {
  return {
    id: 'id-server',
    trailId: TRAIL,
    waypointId: WP,
    displayName: 'Ranger',
    text: 'Creek is running well',
    waterStatus: 'flowing',
    observedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('comments-repo', () => {
  it('upserts a server comment and reads it back', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput());
    const row = await commentsRepo.getById(d, 'id-server');
    expect(row).toMatchObject({
      id: 'id-server',
      trailId: TRAIL,
      waypointId: WP,
      authorName: 'Ranger',
      body: 'Creek is running well',
      waterStatus: 'flowing',
      source: 'server',
      authorId: null,
    });
  });

  it('lists a waypoint newest-first with outbox state joined', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'new', createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    const list = await commentsRepo.listByWaypoint(d, TRAIL, WP);
    expect(list.map((c) => c.id)).toEqual(['new', 'old']);
    expect(list[0].outboxStatus).toBeNull();
  });

  it('inserts a local comment then confirms it, preserving author_id', async () => {
    const d = await db();
    await commentsRepo.insertLocalComment(d, {
      id: 'mine',
      trailId: TRAIL,
      waypointId: WP,
      authorId: 'user-1',
      authorName: 'Me',
      body: 'tap here',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    let row = await commentsRepo.getById(d, 'mine');
    expect(row?.source).toBe('local');

    await commentsRepo.confirmServer(d, 'mine', {
      displayName: 'Me (server)',
      text: 'tap here',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-03T00:00:05.000Z',
    });
    row = await commentsRepo.getById(d, 'mine');
    expect(row?.source).toBe('server');
    expect(row?.authorId).toBe('user-1'); // preserved
    expect(row?.authorName).toBe('Me (server)'); // adopted from server
  });

  it('preserves author_id when a sync round-trips our own comment', async () => {
    const d = await db();
    await commentsRepo.insertLocalComment(d, {
      id: 'shared-id',
      trailId: TRAIL,
      waypointId: WP,
      authorId: 'user-1',
      authorName: 'Me',
      body: 'hi',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    // A later trail pull returns the same comment (no user id in the feed).
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'shared-id', text: 'hi', displayName: 'Me' }));
    const row = await commentsRepo.getById(d, 'shared-id');
    expect(row?.source).toBe('server');
    expect(row?.authorId).toBe('user-1');
  });

  it('applies a tombstone by removing the row', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'doomed' }));
    await commentsRepo.applyTombstone(d, 'doomed');
    expect(await commentsRepo.getById(d, 'doomed')).toBeNull();
  });

  it('reflects a pending outbox item in the joined list', async () => {
    const d = await db();
    await commentsRepo.insertLocalComment(d, {
      id: 'pending-1',
      trailId: TRAIL,
      waypointId: WP,
      authorId: 'user-1',
      authorName: 'Me',
      body: 'draft',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-04T00:00:00.000Z',
    });
    await outboxRepo.enqueue(d, {
      id: 'pending-1',
      kind: 'comment',
      trailId: TRAIL,
      waypointId: WP,
      payload: { trailId: TRAIL, waypointId: WP, text: 'draft' },
    });
    const list = await commentsRepo.listByWaypoint(d, TRAIL, WP);
    expect(list[0].outboxStatus).toBe('pending');
    expect(list[0].outboxAttempts).toBe(0);
  });

  it('persists photo_urls_json on a server upsert and reads it back', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'p1', photoUrls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }),
    );
    const row = await commentsRepo.getById(d, 'p1');
    expect(row?.photoUrls).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg']);
  });

  it('defaults photoUrls to an empty array when absent', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'p2' }));
    expect((await commentsRepo.getById(d, 'p2'))?.photoUrls).toEqual([]);
  });

  it('keeps a local-preview photo list when a later server upsert carries none', async () => {
    const d = await db();
    await commentsRepo.insertLocalComment(d, {
      id: 'p3',
      trailId: TRAIL,
      waypointId: WP,
      authorId: 'user-1',
      authorName: 'Me',
      body: 'pic',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-01-05T00:00:00.000Z',
      photoUrls: ['file:///local.jpg'],
    });
    // A trail pull returns the confirmed comment before the photo finished
    // uploading (no photoUrls yet) — the optimistic preview must survive.
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'p3', photoUrls: undefined }));
    expect((await commentsRepo.getById(d, 'p3'))?.photoUrls).toEqual(['file:///local.jpg']);

    // Once the server has the photo, its list wins.
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'p3', photoUrls: ['https://cdn/x.jpg'] }));
    expect((await commentsRepo.getById(d, 'p3'))?.photoUrls).toEqual(['https://cdn/x.jpg']);
  });

  it('setPhotoUrls overwrites the stored list', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'p4' }));
    await commentsRepo.setPhotoUrls(d, 'p4', ['https://cdn/one.jpg']);
    expect((await commentsRepo.getById(d, 'p4'))?.photoUrls).toEqual(['https://cdn/one.jpg']);
  });

  it('folds a pending photo-upload outbox row onto the comment as photoUploadStatus', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'withphoto' }));
    await outboxRepo.enqueue(d, {
      id: 'photo-1',
      kind: 'photo',
      trailId: TRAIL,
      waypointId: WP,
      payload: { commentId: 'withphoto', localUri: 'file:///a.jpg', contentType: 'image/jpeg' },
    });
    let list = await commentsRepo.listByWaypoint(d, TRAIL, WP);
    expect(list.find((c) => c.id === 'withphoto')?.photoUploadStatus).toBe('pending');

    await outboxRepo.markFailed(d, 'photo-1', '413: too big');
    list = await commentsRepo.listByWaypoint(d, TRAIL, WP);
    expect(list.find((c) => c.id === 'withphoto')?.photoUploadStatus).toBe('failed');
  });

  it('rejects an invalid water_status via the CHECK constraint', async () => {
    const d = await db();
    await expectDbRejection(() =>
      d.runAsync(
        `INSERT INTO comments (id, trail_id, waypoint_id, body, water_status, created_at, source)
         VALUES ('bad', ?, ?, 'x', 'sparkling', '2026-01-01T00:00:00Z', 'server')`,
        [TRAIL, WP],
      ),
    );
  });
});
