import { createMigratedTestDb, expectDbRejection } from './test-helpers';
import { createTestDatabase } from './sqlite-test-adapter';
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

describe('schema v4 — imported-trail registry', () => {
  it('creates the imported_trails table on a fresh install', async () => {
    const db = await createMigratedTestDb();
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(rows.map((r) => r.name)).toContain('imported_trails');
  });

  it('has the expected columns, nullability and defaults', async () => {
    const db = await createMigratedTestDb();
    const cols = await db.getAllAsync<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>("PRAGMA table_info('imported_trails')");
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual([
      'created_at',
      'has_elevation',
      'id',
      'length_km',
      'name',
      'point_count',
      'short_name',
      'source',
      'waypoint_count',
    ]);
    expect(byName.id.pk).toBe(1);
    expect(byName.length_km.type).toBe('REAL');
    // Identity columns are NOT NULL; the optional counts are nullable.
    for (const col of ['name', 'short_name', 'length_km', 'source', 'has_elevation']) {
      expect(byName[col].notnull).toBe(1);
    }
    for (const col of ['point_count', 'waypoint_count']) {
      expect(byName[col].notnull).toBe(0);
    }
    expect(byName.source.dflt_value).toBe("'imported'");
    expect(byName.has_elevation.dflt_value).toBe('1');
  });

  it('applies the defaults on a bare insert', async () => {
    const db = await createMigratedTestDb();
    await db.runAsync(
      `INSERT INTO imported_trails (id, name, short_name, length_km)
       VALUES ('u_abc123', 'My Loop', 'Loop', 42.5)`
    );
    const row = await db.getFirstAsync<{
      source: string;
      has_elevation: number;
      point_count: number | null;
      created_at: string;
    }>("SELECT * FROM imported_trails WHERE id = 'u_abc123'");
    expect(row?.source).toBe('imported');
    expect(row?.has_elevation).toBe(1);
    expect(row?.point_count).toBeNull();
    expect(row?.created_at).toEqual(expect.any(String));
  });

  it('rejects a duplicate trail id', async () => {
    const db = await createMigratedTestDb();
    await db.runAsync(
      `INSERT INTO imported_trails (id, name, short_name, length_km)
       VALUES ('u_abc123', 'My Loop', 'Loop', 42.5)`
    );
    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO imported_trails (id, name, short_name, length_km)
         VALUES ('u_abc123', 'Other', 'Other', 1)`
      )
    );
  });

  it('upgrades a v3 database in place, preserving its rows', async () => {
    // Migrate only as far as v3, seed a row in a pre-existing table, then let
    // the v4 migration run — the new table must appear without disturbing
    // anything already stored.
    const db = createTestDatabase();
    await migrateDatabase(db as never, 3);
    await db.runAsync(
      "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('larapinta', 'w_abcd1234')"
    );

    let tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    expect(tables.map((t) => t.name)).not.toContain('imported_trails');

    await migrateDatabase(db as never);

    tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    expect(tables.map((t) => t.name)).toContain('imported_trails');

    const version = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_version'
    );
    expect(version?.version).toBe(4);

    const favorites = await db.getAllAsync<{ waypoint_id: string }>(
      "SELECT waypoint_id FROM favorites WHERE trail_id = 'larapinta'"
    );
    expect(favorites.map((f) => f.waypoint_id)).toEqual(['w_abcd1234']);
  });

  it('leaves the dead v1 guides table untouched', async () => {
    // v4 deliberately adds a fresh table rather than repurposing `guides`
    // (see the migration comment) — assert its shape has not drifted.
    const db = await createMigratedTestDb();
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('guides')");
    expect(cols.map((c) => c.name).sort()).toEqual([
      'comments_synced_at',
      'created_at',
      'data_version',
      'direction',
      'id',
      'tiles_downloaded',
      'updated_at',
    ]);
  });
});
