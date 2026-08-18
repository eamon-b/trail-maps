/**
 * Feed paging over the local cache: `listByWaypoint`'s optional `limit` is the
 * detail screen's window, so it must return the NEWEST rows (same order as the
 * unlimited read) and leave the default behaviour untouched.
 */

import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as commentsRepo from '../comments-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

/** Seed `count` server comments, oldest first (c0 = oldest). */
async function seed(d: SqlDatabase, count: number, waypointId = 'w_1') {
  for (let i = 0; i < count; i++) {
    await commentsRepo.upsertServerComment(d, {
      id: `c${i}`,
      trailId: 'aawt',
      waypointId,
      displayName: 'Hiker',
      text: `note ${i}`,
      waterStatus: null,
      observedAt: null,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    });
  }
}

describe('listByWaypoint paging', () => {
  it('returns the whole feed when no limit is passed', async () => {
    const d = await db();
    await seed(d, 25);
    const rows = await commentsRepo.listByWaypoint(d, 'aawt', 'w_1');
    expect(rows).toHaveLength(25);
    expect(rows[0].id).toBe('c24'); // newest first
  });

  it('returns the newest page under a limit, in the same order', async () => {
    const d = await db();
    await seed(d, 25);
    const page = await commentsRepo.listByWaypoint(d, 'aawt', 'w_1', { limit: 20 });
    const all = await commentsRepo.listByWaypoint(d, 'aawt', 'w_1');
    expect(page).toHaveLength(20);
    expect(page.map((r) => r.id)).toEqual(all.slice(0, 20).map((r) => r.id));
    expect(page[0].id).toBe('c24');
    expect(page[19].id).toBe('c5');
  });

  it('widens deterministically as the window grows', async () => {
    const d = await db();
    await seed(d, 25);
    const wider = await commentsRepo.listByWaypoint(d, 'aawt', 'w_1', { limit: 40 });
    expect(wider).toHaveLength(25); // clamped by what exists
    expect(await commentsRepo.countByWaypoint(d, 'aawt', 'w_1')).toBe(25);
  });

  it('still folds outbox state onto a limited page', async () => {
    const d = await db();
    await seed(d, 3);
    await commentsRepo.insertLocalComment(d, {
      id: 'local',
      trailId: 'aawt',
      waypointId: 'w_1',
      authorId: 'u1',
      authorName: 'Me',
      body: 'queued',
      waterStatus: null,
      observedAt: null,
      createdAt: '2026-02-01T00:00:00Z',
    });
    await d.runAsync(
      `INSERT INTO outbox (id, kind, trail_id, waypoint_id, payload_json, created_at, attempts, status)
       VALUES ('local', 'comment', 'aawt', 'w_1', '{}', '2026-02-01T00:00:00Z', 0, 'pending')`,
    );

    const page = await commentsRepo.listByWaypoint(d, 'aawt', 'w_1', { limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].id).toBe('local');
    expect(page[0].outboxStatus).toBe('pending');
  });

  it('scopes the page to the requested waypoint', async () => {
    const d = await db();
    await seed(d, 3, 'w_1');
    await seed(d, 2, 'w_2'); // ids collide, so this rewrites c0/c1 onto w_2
    const page = await commentsRepo.listByWaypoint(d, 'aawt', 'w_2', { limit: 10 });
    expect(page.map((r) => r.waypointId)).toEqual(['w_2', 'w_2']);
  });
});
