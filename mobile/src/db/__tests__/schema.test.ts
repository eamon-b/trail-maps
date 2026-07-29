import { createMigratedTestDb, expectDbRejection } from './test-helpers';
import { migrateDatabase, SCHEMA_VERSION } from '../schema';

describe('schema v1', () => {
  it('migrates a fresh database to the current version', async () => {
    const db = await createMigratedTestDb();
    const row = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_version'
    );
    expect(row?.version).toBe(SCHEMA_VERSION);
  });

  it('creates all v1 tables', async () => {
    const db = await createMigratedTestDb();
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const tables = rows.map((r) => r.name);
    for (const table of ['guides', 'favorites', 'comments', 'outbox', 'sync_state']) {
      expect(tables).toContain(table);
    }
  });

  it('is idempotent when already at the current version', async () => {
    const db = await createMigratedTestDb();
    await migrateDatabase(db as never);
    const row = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_version'
    );
    expect(row?.version).toBe(SCHEMA_VERSION);
  });

  it('rejects comments with an invalid water_status', async () => {
    const db = await createMigratedTestDb();
    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO comments (id, trail_id, waypoint_id, body, water_status, created_at)
         VALUES ('c1', 'larapinta', 'w_abcd1234', 'hi', 'gushing', '2026-07-29T00:00:00Z')`
      )
    );
  });

  it('rejects duplicate favorites for the same waypoint', async () => {
    const db = await createMigratedTestDb();
    await db.runAsync(
      "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('larapinta', 'w_abcd1234')"
    );
    await expectDbRejection(() =>
      db.runAsync(
        "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('larapinta', 'w_abcd1234')"
      )
    );
  });
});
