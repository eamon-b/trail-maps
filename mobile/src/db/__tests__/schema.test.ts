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

describe('schema v2 — routes', () => {
  async function seedRoute(db: Awaited<ReturnType<typeof createMigratedTestDb>>) {
    await db.runAsync(
      `INSERT INTO routes (id, trail_id, name, total_km, ascent_m, descent_m, created_at, updated_at)
       VALUES ('rt1', 'larapinta', 'Day 1', 12.3, 400, 200, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z')`
    );
  }

  it('creates the routes + route_points tables', async () => {
    const db = await createMigratedTestDb();
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const tables = rows.map((r) => r.name);
    expect(tables).toContain('routes');
    expect(tables).toContain('route_points');
  });

  it('rejects a route_point with an invalid kind', async () => {
    const db = await createMigratedTestDb();
    await seedRoute(db);
    await expectDbRejection(() =>
      db.runAsync(
        "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 0, 'wander', -23, 133, 0)"
      )
    );
  });

  it('accepts snap (with km) and sketch (km NULL) points', async () => {
    const db = await createMigratedTestDb();
    await seedRoute(db);
    await db.runAsync(
      "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 0, 'snap', -23.5, 133.2, 4.5)"
    );
    await db.runAsync(
      "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 1, 'sketch', -23.6, 133.3, NULL)"
    );
    const rows = await db.getAllAsync<{ seq: number }>(
      "SELECT seq FROM route_points WHERE route_id = 'rt1' ORDER BY seq"
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
  });

  it('rejects duplicate (route_id, seq)', async () => {
    const db = await createMigratedTestDb();
    await seedRoute(db);
    await db.runAsync(
      "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 0, 'snap', -23.5, 133.2, 4.5)"
    );
    await expectDbRejection(() =>
      db.runAsync(
        "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 0, 'snap', -23.5, 133.2, 4.5)"
      )
    );
  });

  it('cascades route_points when a route is deleted (FK on)', async () => {
    const db = await createMigratedTestDb();
    await seedRoute(db);
    await db.runAsync(
      "INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES ('rt1', 0, 'snap', -23.5, 133.2, 4.5)"
    );
    await db.runAsync("DELETE FROM routes WHERE id = 'rt1'");
    const rows = await db.getAllAsync<{ seq: number }>(
      "SELECT seq FROM route_points WHERE route_id = 'rt1'"
    );
    expect(rows).toHaveLength(0);
  });
});

describe('schema v3 — synced waypoint descriptions', () => {
  it('creates the waypoint_meta table', async () => {
    const db = await createMigratedTestDb();
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(rows.map((r) => r.name)).toContain('waypoint_meta');
  });

  it('rejects duplicate (trail_id, waypoint_id) rows', async () => {
    const db = await createMigratedTestDb();
    await db.runAsync(
      `INSERT INTO waypoint_meta (trail_id, waypoint_id, description, updated_at)
       VALUES ('larapinta', 'w_abcd1234', 'Tank.', '2026-08-01T00:00:00Z')`
    );
    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO waypoint_meta (trail_id, waypoint_id, description, updated_at)
         VALUES ('larapinta', 'w_abcd1234', 'Tank again.', '2026-08-02T00:00:00Z')`
      )
    );
  });

  it('adds sync_state.meta_synced_at alongside the comment cursor', async () => {
    const db = await createMigratedTestDb();
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('sync_state')");
    const names = cols.map((c) => c.name);
    expect(names).toContain('meta_synced_at');
    expect(names).toContain('last_synced_at');
  });
});
