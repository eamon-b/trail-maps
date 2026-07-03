import { createTestDatabase } from '../sqlite-test-adapter';
import { createMigratedTestDb } from '../test-helpers';
import { migrateDatabase, SCHEMA_VERSION } from '../../schema';

// ---------------------------------------------------------------------------
// schema migrations
// ---------------------------------------------------------------------------

describe('schema migrations', () => {
  it('fresh migration (0 → current) creates all 5 tables', async () => {
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
});

// ---------------------------------------------------------------------------
// constraints
// ---------------------------------------------------------------------------

describe('constraints', () => {
  it('FK: waypoint with invalid trail_id fails', async () => {
    const db = await createMigratedTestDb();

    await expect(
      db.runAsync(
        'INSERT INTO waypoints (trail_id, name, type, lat, lon) VALUES (?, ?, ?, ?, ?)',
        ['nonexistent', 'Bad WP', 'poi', -33, 115]
      )
    ).rejects.toThrow();

    await db.closeAsync();
  });

  it('FK: plan with invalid trail_id fails', async () => {
    const db = await createMigratedTestDb();

    await expect(
      db.runAsync(
        'INSERT INTO plans (id, trail_id, name) VALUES (?, ?, ?)',
        ['plan-1', 'nonexistent', 'Bad Plan']
      )
    ).rejects.toThrow();

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
});
