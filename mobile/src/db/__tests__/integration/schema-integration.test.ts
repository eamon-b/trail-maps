import { createTestDatabase } from '../sqlite-test-adapter';
import { createMigratedTestDb, expectDbRejection } from '../test-helpers';
import { migrateDatabase, SCHEMA_VERSION } from '../../schema';

// ---------------------------------------------------------------------------
// schema migrations
// ---------------------------------------------------------------------------

describe('schema migrations', () => {
  it('fresh migration (0 → current) creates all 6 tables', async () => {
    const db = await createMigratedTestDb();

    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('trails');
    expect(tableNames).toContain('waypoints');
    expect(tableNames).toContain('plans');
    expect(tableNames).toContain('plan_versions');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('custom_waypoints');

    await db.closeAsync();
  });

  it('schema_version contains the current version', async () => {
    const db = await createMigratedTestDb();

    const row = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_version'
    );

    expect(row).not.toBeNull();
    expect(row!.version).toBe(SCHEMA_VERSION);

    await db.closeAsync();
  });

  it('partial migration (2 → current) works', async () => {
    const db = createTestDatabase();
    await db.execAsync('PRAGMA foreign_keys = ON');

    // Apply migrations 1 and 2 manually
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS trails (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        short_name TEXT,
        region TEXT,
        length_km REAL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS waypoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'poi',
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        ele REAL,
        km_position REAL,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY NOT NULL,
        trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'NOBO',
        start_date TEXT,
        section_json TEXT,
        stops_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (version) VALUES (1);
    `);
    await db.execAsync(`
      ALTER TABLE trails ADD COLUMN data_version TEXT;
      UPDATE schema_version SET version = 2;
    `);

    // Now run migrateDatabase — it should apply migrations 3 and 4
    await migrateDatabase(db as any);

    const row = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_version'
    );
    expect(row!.version).toBe(SCHEMA_VERSION);

    // Verify v3 table exists
    const pvTable = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='plan_versions'"
    );
    expect(pvTable).not.toBeNull();

    await db.closeAsync();
  });

  it('idempotent: calling migrate twice does not error', async () => {
    const db = await createMigratedTestDb();

    // Second call should be a no-op
    await expect(migrateDatabase(db as any)).resolves.toBeUndefined();

    await db.closeAsync();
  });

  it('v4 columns exist (is_custom, source_filename, track_data_json)', async () => {
    const db = await createMigratedTestDb();

    // Insert a trail to test v4 columns
    await db.runAsync(
      `INSERT INTO trails (id, name, is_custom, source_filename, track_data_json)
       VALUES (?, ?, ?, ?, ?)`,
      ['test', 'Test Trail', 1, 'test.gpx', '{"config":{}}']
    );

    const row = await db.getFirstAsync<{
      is_custom: number;
      source_filename: string;
      track_data_json: string;
    }>('SELECT is_custom, source_filename, track_data_json FROM trails WHERE id = ?', ['test']);

    expect(row!.is_custom).toBe(1);
    expect(row!.source_filename).toBe('test.gpx');
    expect(row!.track_data_json).toBe('{"config":{}}');

    await db.closeAsync();
  });

  it('v4 → v5 preserves existing rows and adds custom_waypoints + climate_json', async () => {
    const db = createTestDatabase();

    // Build a database at v4 with data in every user-facing table
    await migrateDatabase(db as any, 4);
    await db.runAsync('INSERT INTO trails (id, name, is_custom) VALUES (?, ?, ?)', ['trail-1', 'Test Trail', 0]);
    await db.runAsync(
      'INSERT INTO waypoints (trail_id, name, type, lat, lon) VALUES (?, ?, ?, ?, ?)',
      ['trail-1', 'Camp', 'campsite', -33, 115]
    );
    await db.runAsync('INSERT INTO plans (id, trail_id, name) VALUES (?, ?, ?)', ['plan-1', 'trail-1', 'My Plan']);

    // Upgrade to v5
    await migrateDatabase(db as any);

    const version = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version');
    expect(version!.version).toBe(SCHEMA_VERSION);

    // Existing rows preserved
    expect(await db.getAllAsync('SELECT * FROM trails')).toHaveLength(1);
    expect(await db.getAllAsync('SELECT * FROM waypoints')).toHaveLength(1);
    expect(await db.getAllAsync('SELECT * FROM plans')).toHaveLength(1);

    // custom_waypoints table is usable
    await db.runAsync(
      `INSERT INTO custom_waypoints (id, trail_id, name, type, lat, lon, km_position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cw-1', 'trail-1', 'My spring', 'water', -33.5, 115.5, 42.3, '2026-07-04', '2026-07-04']
    );
    const cw = await db.getFirstAsync<{ name: string; type: string }>(
      'SELECT name, type FROM custom_waypoints WHERE id = ?', ['cw-1']
    );
    expect(cw!.name).toBe('My spring');

    // climate_json column exists (reserved for item 3)
    await db.runAsync('UPDATE trails SET climate_json = ? WHERE id = ?', ['{"locations":[]}', 'trail-1']);
    const trail = await db.getFirstAsync<{ climate_json: string }>(
      'SELECT climate_json FROM trails WHERE id = ?', ['trail-1']
    );
    expect(trail!.climate_json).toBe('{"locations":[]}');

    await db.closeAsync();
  });

  it('v5 → v6 preserves custom waypoints and adds photo_uri', async () => {
    const db = createTestDatabase();

    // Build a database at v5 with an existing custom waypoint
    await migrateDatabase(db as any, 5);
    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['trail-1', 'Test Trail']);
    await db.runAsync(
      `INSERT INTO custom_waypoints (id, trail_id, name, type, lat, lon, km_position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cw-1', 'trail-1', 'My spring', 'water', -33.5, 115.5, 42.3, '2026-07-04', '2026-07-04']
    );

    // Upgrade to v6
    await migrateDatabase(db as any);

    const version = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version');
    expect(version!.version).toBe(SCHEMA_VERSION);

    // Existing row preserved, photo_uri nullable with no backfill
    const row = await db.getFirstAsync<{ name: string; photo_uri: string | null }>(
      'SELECT name, photo_uri FROM custom_waypoints WHERE id = ?', ['cw-1']
    );
    expect(row!.name).toBe('My spring');
    expect(row!.photo_uri).toBeNull();

    // Column is writable
    await db.runAsync('UPDATE custom_waypoints SET photo_uri = ? WHERE id = ?', ['/doc/waypoint-photos/cw-1.jpg', 'cw-1']);
    const updated = await db.getFirstAsync<{ photo_uri: string }>(
      'SELECT photo_uri FROM custom_waypoints WHERE id = ?', ['cw-1']
    );
    expect(updated!.photo_uri).toBe('/doc/waypoint-photos/cw-1.jpg');

    await db.closeAsync();
  });

  it('v6 → v7 adds routes + route_legs with cascade wiring', async () => {
    const db = createTestDatabase();

    await migrateDatabase(db as any, 6);
    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['trail-1', 'Test Trail']);

    // Upgrade to v7
    await migrateDatabase(db as any);
    const version = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version');
    expect(version!.version).toBe(SCHEMA_VERSION);

    // Tables usable
    await db.runAsync(
      'INSERT INTO routes (id, trail_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['r-1', 'trail-1', 'Lookout loop', '2026-07-11', '2026-07-11']
    );
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
      ['r-1', 0, 'wp-3', 12.5]
    );
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
      ['r-1', 1, null, 18.0]
    );

    // Deleting the route cascades to its legs
    await db.runAsync('DELETE FROM routes WHERE id = ?', ['r-1']);
    expect(await db.getAllAsync('SELECT * FROM route_legs')).toHaveLength(0);

    // Deleting the trail cascades to routes (and transitively their legs)
    await db.runAsync(
      'INSERT INTO routes (id, trail_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['r-2', 'trail-1', 'Water run', '2026-07-11', '2026-07-11']
    );
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
      ['r-2', 0, 'wp-1', 5]
    );
    await db.runAsync('DELETE FROM trails WHERE id = ?', ['trail-1']);
    expect(await db.getAllAsync('SELECT * FROM routes')).toHaveLength(0);
    expect(await db.getAllAsync('SELECT * FROM route_legs')).toHaveLength(0);

    await db.closeAsync();
  });

  it('v7 → v8 preserves route legs and adds nullable lat/lon', async () => {
    const db = createTestDatabase();

    // Build a database at v7 with a route + legs (waypoint ref and km-only)
    await migrateDatabase(db as any, 7);
    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['trail-1', 'Test Trail']);
    await db.runAsync(
      'INSERT INTO routes (id, trail_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['r-1', 'trail-1', 'Water run', '2026-07-11', '2026-07-11']
    );
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
      ['r-1', 0, 'wp-3', 12.5]
    );
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
      ['r-1', 1, null, 18.0]
    );

    // Upgrade to v8
    await migrateDatabase(db as any);
    const version = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version');
    expect(version!.version).toBe(SCHEMA_VERSION);

    // Existing legs preserved; lat/lon nullable with no backfill
    const legs = await db.getAllAsync<{ seq: number; km_position: number; lat: number | null; lon: number | null }>(
      'SELECT seq, km_position, lat, lon FROM route_legs WHERE route_id = ? ORDER BY seq', ['r-1']
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ seq: 0, km_position: 12.5, lat: null, lon: null });
    expect(legs[1]).toMatchObject({ seq: 1, km_position: 18.0, lat: null, lon: null });

    // Off-track sketch leg is writable through the new columns
    await db.runAsync(
      'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position, lat, lon) VALUES (?, ?, ?, ?, ?, ?)',
      ['r-1', 2, null, 20.0, -35.135, 138.01]
    );
    const sketch = await db.getFirstAsync<{ lat: number; lon: number }>(
      'SELECT lat, lon FROM route_legs WHERE route_id = ? AND seq = 2', ['r-1']
    );
    expect(sketch!.lat).toBeCloseTo(-35.135, 5);
    expect(sketch!.lon).toBeCloseTo(138.01, 5);

    await db.closeAsync();
  });

  it('custom_waypoints defaults type to water', async () => {
    const db = await createMigratedTestDb();

    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['trail-1', 'Test Trail']);
    await db.runAsync(
      `INSERT INTO custom_waypoints (id, trail_id, name, lat, lon, km_position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cw-1', 'trail-1', 'Unnamed source', -33, 115, 10, '2026-07-04', '2026-07-04']
    );

    const row = await db.getFirstAsync<{ type: string }>(
      'SELECT type FROM custom_waypoints WHERE id = ?', ['cw-1']
    );
    expect(row!.type).toBe('water');

    await db.closeAsync();
  });
});

// ---------------------------------------------------------------------------
// constraints
// ---------------------------------------------------------------------------

describe('constraints', () => {
  it('FK: waypoint with invalid trail_id fails', async () => {
    const db = await createMigratedTestDb();

    await expectDbRejection(() =>
      db.runAsync(
        'INSERT INTO waypoints (trail_id, name, type, lat, lon) VALUES (?, ?, ?, ?, ?)',
        ['nonexistent', 'Bad WP', 'poi', -33, 115]
      )
    );

    await db.closeAsync();
  });

  it('FK: plan with invalid trail_id fails', async () => {
    const db = await createMigratedTestDb();

    await expectDbRejection(() =>
      db.runAsync(
        'INSERT INTO plans (id, trail_id, name) VALUES (?, ?, ?)',
        ['plan-1', 'nonexistent', 'Bad Plan']
      )
    );

    await db.closeAsync();
  });

  it('cascade: deleting trail removes waypoints', async () => {
    const db = await createMigratedTestDb();

    await db.runAsync(
      'INSERT INTO trails (id, name) VALUES (?, ?)',
      ['trail-1', 'Test Trail']
    );
    await db.runAsync(
      'INSERT INTO waypoints (trail_id, name, type, lat, lon) VALUES (?, ?, ?, ?, ?)',
      ['trail-1', 'WP1', 'campsite', -33, 115]
    );

    // Verify waypoint exists
    const before = await db.getAllAsync('SELECT * FROM waypoints WHERE trail_id = ?', ['trail-1']);
    expect(before).toHaveLength(1);

    // Delete trail
    await db.runAsync('DELETE FROM trails WHERE id = ?', ['trail-1']);

    // Waypoints should be cascaded
    const after = await db.getAllAsync('SELECT * FROM waypoints WHERE trail_id = ?', ['trail-1']);
    expect(after).toHaveLength(0);

    await db.closeAsync();
  });

  it('cascade: deleting trail removes plans', async () => {
    const db = await createMigratedTestDb();

    await db.runAsync(
      'INSERT INTO trails (id, name) VALUES (?, ?)',
      ['trail-1', 'Test Trail']
    );
    await db.runAsync(
      'INSERT INTO plans (id, trail_id, name) VALUES (?, ?, ?)',
      ['plan-1', 'trail-1', 'My Plan']
    );

    await db.runAsync('DELETE FROM trails WHERE id = ?', ['trail-1']);

    const after = await db.getAllAsync('SELECT * FROM plans WHERE trail_id = ?', ['trail-1']);
    expect(after).toHaveLength(0);

    await db.closeAsync();
  });

  it('cascade: deleting plan removes plan_versions', async () => {
    const db = await createMigratedTestDb();

    await db.runAsync(
      'INSERT INTO trails (id, name) VALUES (?, ?)',
      ['trail-1', 'Test Trail']
    );
    await db.runAsync(
      'INSERT INTO plans (id, trail_id, name) VALUES (?, ?, ?)',
      ['plan-1', 'trail-1', 'My Plan']
    );
    await db.runAsync(
      'INSERT INTO plan_versions (id, plan_id, name) VALUES (?, ?, ?)',
      ['v1', 'plan-1', 'Version 1']
    );

    await db.runAsync('DELETE FROM plans WHERE id = ?', ['plan-1']);

    const after = await db.getAllAsync('SELECT * FROM plan_versions WHERE plan_id = ?', ['plan-1']);
    expect(after).toHaveLength(0);

    await db.closeAsync();
  });

  it('FK: custom waypoint with invalid trail_id fails', async () => {
    const db = await createMigratedTestDb();

    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO custom_waypoints (id, trail_id, name, lat, lon, km_position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['cw-1', 'nonexistent', 'Bad WP', -33, 115, 10, '2026-07-04', '2026-07-04']
      )
    );

    await db.closeAsync();
  });

  it('cascade: deleting trail removes custom_waypoints', async () => {
    const db = await createMigratedTestDb();

    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['trail-1', 'Test Trail']);
    await db.runAsync(
      `INSERT INTO custom_waypoints (id, trail_id, name, type, lat, lon, km_position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cw-1', 'trail-1', 'My spring', 'water', -33, 115, 12.5, '2026-07-04', '2026-07-04']
    );

    const before = await db.getAllAsync('SELECT * FROM custom_waypoints WHERE trail_id = ?', ['trail-1']);
    expect(before).toHaveLength(1);

    await db.runAsync('DELETE FROM trails WHERE id = ?', ['trail-1']);

    const after = await db.getAllAsync('SELECT * FROM custom_waypoints WHERE trail_id = ?', ['trail-1']);
    expect(after).toHaveLength(0);

    await db.closeAsync();
  });
});
