/**
 * Local purge after account deletion.
 *
 * The blast radius is the point of these tests: the user's own comments and the
 * whole outbox go, and everything else — other hikers' cached comments,
 * favourites, saved routes — has to survive, because the Settings copy promises
 * exactly that.
 */

import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import type { TestDatabase } from '../../../db/__tests__/sqlite-test-adapter';
import type { SqlDatabase } from '../../../db/sql-database';
import { purgeLocalAccountData } from '../account-deletion';

const ME = 'user-me';
const OTHER = 'user-other';

let db: TestDatabase;

async function insertComment(id: string, authorId: string | null, source = 'server') {
  await db.runAsync(
    `INSERT INTO comments (id, trail_id, waypoint_id, author_id, author_name, body, created_at, source)
     VALUES (?, 'larapinta', 'wp-1', ?, 'Someone', 'hi', '2026-08-19T00:00:00Z', ?)`,
    [id, authorId, source],
  );
}

async function insertOutboxItem(id: string, kind = 'comment') {
  await db.runAsync(
    `INSERT INTO outbox (id, kind, trail_id, waypoint_id, payload_json)
     VALUES (?, ?, 'larapinta', 'wp-1', '{}')`,
    [id, kind],
  );
}

async function ids(table: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`);
  return rows.map((r) => r.id);
}

beforeEach(async () => {
  db = await createMigratedTestDb();
});

afterEach(async () => {
  await db.closeAsync();
});

describe('purgeLocalAccountData', () => {
  it('deletes the user’s own comments, server-mirrored and optimistic alike', async () => {
    await insertComment('c-mine-server', ME);
    await insertComment('c-mine-local', ME, 'local');

    await purgeLocalAccountData(db as unknown as SqlDatabase, ME);

    expect(await ids('comments')).toEqual([]);
  });

  it('keeps other users’ cached comments — public content, unrelated identity', async () => {
    await insertComment('c-mine', ME);
    await insertComment('c-theirs', OTHER);
    // A synced row whose author is unknown to us (the public feed carries only a
    // display name) must not be swept up by a NULL author_id.
    await insertComment('c-anon', null);

    await purgeLocalAccountData(db as unknown as SqlDatabase, ME);

    expect(await ids('comments')).toEqual(['c-anon', 'c-theirs']);
  });

  it('empties the outbox — every row was queued under the now-dead token', async () => {
    await insertOutboxItem('o-1');
    await insertOutboxItem('o-2', 'photo');
    await insertOutboxItem('o-3', 'comment-delete');

    await purgeLocalAccountData(db as unknown as SqlDatabase, ME);

    expect(await ids('outbox')).toEqual([]);
  });

  it('leaves device-local content that was never on the server', async () => {
    await db.runAsync(
      `INSERT INTO favorites (trail_id, waypoint_id) VALUES ('larapinta', 'wp-1')`,
    );
    await db.runAsync(
      `INSERT INTO routes (id, trail_id, name) VALUES ('r-1', 'larapinta', 'Day 1 loop')`,
    );

    await purgeLocalAccountData(db as unknown as SqlDatabase, ME);

    expect(await db.getAllAsync('SELECT * FROM favorites')).toHaveLength(1);
    expect(await ids('routes')).toEqual(['r-1']);
  });

  it('is a no-op on a device with nothing cached', async () => {
    await purgeLocalAccountData(db as unknown as SqlDatabase, ME);
    expect(await ids('comments')).toEqual([]);
    expect(await ids('outbox')).toEqual([]);
  });
});
