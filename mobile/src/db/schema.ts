import type { SQLiteDatabase } from 'expo-sqlite';

const SCHEMA_VERSION = 4;

const MIGRATIONS: Record<number, string> = {
  1: `
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

    CREATE INDEX IF NOT EXISTS idx_waypoints_trail_id ON waypoints(trail_id);
    CREATE INDEX IF NOT EXISTS idx_waypoints_type ON waypoints(type);

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

    CREATE INDEX IF NOT EXISTS idx_plans_trail_id ON plans(trail_id);

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    INSERT INTO schema_version (version) VALUES (1);
  `,
  2: `
    ALTER TABLE trails ADD COLUMN data_version TEXT;
    UPDATE schema_version SET version = 2;
  `,
  3: `
    CREATE TABLE IF NOT EXISTS plan_versions (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      name TEXT,
      stops_json TEXT,
      section_json TEXT,
      direction TEXT,
      start_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_id ON plan_versions(plan_id);
    UPDATE schema_version SET version = 3;
  `,
  4: `
    ALTER TABLE trails ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trails ADD COLUMN source_filename TEXT;
    ALTER TABLE trails ADD COLUMN track_data_json TEXT;
    UPDATE schema_version SET version = 4;
  `,
};

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ version: number }>(
    'SELECT version FROM schema_version'
  ).catch(() => null);

  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration for version ${v}`);
    }
    await db.execAsync(migration);
  }
}

export { SCHEMA_VERSION };
