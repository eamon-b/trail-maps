import type { SQLiteDatabase } from 'expo-sqlite';

const SCHEMA_VERSION = 4;

// Fresh v1 schema for Tracknotes. Waypoints and track geometry stay OUT of
// SQLite — bundled trails ship as JSON assets, and user-imported trails are
// written as JSON files on disk (`{documentDir}/trails/{id}.json`) with only a
// lightweight registry row in `imported_trails` (v4). SQLite therefore holds
// per-guide state, the imported-trail registry, the comment cache, and the
// offline outbox — never track geometry.
const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS guides (
      id TEXT PRIMARY KEY NOT NULL,
      data_version TEXT,
      direction TEXT NOT NULL DEFAULT 'default',
      tiles_downloaded INTEGER NOT NULL DEFAULT 0,
      comments_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS favorites (
      trail_id TEXT NOT NULL,
      waypoint_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (trail_id, waypoint_id)
    );

    -- Local mirror of server comments plus optimistic local rows.
    -- id is the server/client-minted UUID; rows composed offline carry
    -- source='local' until the outbox drain replaces them with the
    -- server-confirmed row.
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY NOT NULL,
      trail_id TEXT NOT NULL,
      waypoint_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      body TEXT,
      water_status TEXT CHECK (water_status IN ('flowing', 'low', 'dry')),
      observed_at TEXT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'server' CHECK (source IN ('server', 'local')),
      photo_urls_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_comments_wp
      ON comments(waypoint_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_trail ON comments(trail_id);

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      trail_id TEXT,
      waypoint_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'failed'))
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS sync_state (
      trail_id TEXT PRIMARY KEY NOT NULL,
      comments_cursor TEXT,
      last_synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    INSERT INTO schema_version (version) VALUES (1);
  `,

  // Migration 2: FarOut-style custom routes (Phase 7). A route is a name plus
  // an ordered list of tapped points over the bundled trail. Route stats
  // (total_km / ascent_m / descent_m) are DENORMALIZED onto the route row at
  // save time so listing a route never re-resolves geometry against the trail
  // JSON. `route_points` stores the ordered vertices: a 'snap' point sits on
  // the trail (carrying its trail `km`, the active-direction cumulative
  // distance at save time); a 'sketch' point is an off-trail tap (km NULL).
  // Legs derive from consecutive points — snap→snap follows the track, any leg
  // touching a sketch point is a straight line.
  //
  // Waypoints are referenced only implicitly (a snap point is just a trail
  // position), so there is no waypoint FK to break on data-version bumps —
  // routes reference stable trail geometry (km + lat/lon), not positional
  // waypoint ids. Trail *content* never lives in SQLite (bundled trails are a
  // Metro require() map; imported ones are JSON files on disk, registered in
  // `imported_trails` at v4), so `trail_id` is a plain scoping column with no
  // FK to point at, exactly like `favorites`.
  2: `
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY NOT NULL,
      trail_id TEXT NOT NULL,
      name TEXT NOT NULL,
      total_km REAL NOT NULL DEFAULT 0,
      ascent_m REAL NOT NULL DEFAULT 0,
      descent_m REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_routes_trail
      ON routes(trail_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS route_points (
      route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('snap', 'sketch')),
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      km REAL,
      PRIMARY KEY (route_id, seq)
    );

    UPDATE schema_version SET version = 2;
  `,

  // Migration 3: curated waypoint descriptions, synced from the comments API
  // (`GET /v1/trails/:trailId/descriptions?since=`). The bundled trail JSON
  // carries almost no descriptions, so the server is the authority for this
  // copy — but it must survive offline, hence a local mirror rather than a
  // fetch-on-open. An empty `description` is the server's "cleared" tombstone;
  // rows are stored verbatim and filtered on read (see `waypoint-meta-repo`).
  //
  // `sync_state.meta_synced_at` is the description high-water mark, kept
  // separate from `last_synced_at` (comments) so one channel failing never
  // rewinds or skips the other.
  3: `
    CREATE TABLE IF NOT EXISTS waypoint_meta (
      trail_id TEXT NOT NULL,
      waypoint_id TEXT NOT NULL,
      description TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (trail_id, waypoint_id)
    );

    ALTER TABLE sync_state ADD COLUMN meta_synced_at TEXT;

    UPDATE schema_version SET version = 3;
  `,

  // Migration 4: registry for user-imported GPX trails.
  //
  // Why a FRESH table rather than extending `guides`: `guides` has been dead
  // code since v1 (created, written by nothing) but it still exists in every
  // shipped database, and its columns describe per-guide *state* for a trail
  // that already exists (direction, tiles_downloaded, comments_synced_at) —
  // orthogonal to "this trail exists at all". Bolting identity columns onto it
  // would mean either NULLable name/length columns that are meaningless for
  // the bundled trails it was designed for, or a `source` discriminator that
  // makes every future read of either concern filter on it. A dedicated table
  // keeps `guides` free for its original purpose (or for eventual deletion)
  // and lets the registry carry NOT NULL identity columns.
  //
  // The table is a VIEW over the real artifact: the trail JSON on disk at
  // `{documentDir}/trails/{id}.json` (see `services/imported-trail-store.ts`).
  // Disk is truth — exactly the tiles pattern. A row without its file is a
  // torn import, not a usable trail.
  //
  // No foreign keys anywhere: production never enables `PRAGMA foreign_keys`,
  // and `favorites` / `routes` / `sync_state` / `comments` / `outbox` all treat
  // `trail_id` as a plain scoping column (bundled trail ids have no row here at
  // all). Deleting an imported trail therefore cascades MANUALLY — see
  // `imported-trails-repo.deleteImportedTrail`.
  4: `
    CREATE TABLE IF NOT EXISTS imported_trails (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      length_km REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'imported',
      has_elevation INTEGER NOT NULL DEFAULT 1,
      point_count INTEGER,
      waypoint_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    UPDATE schema_version SET version = 4;
  `,
};

export async function migrateDatabase(
  db: SQLiteDatabase,
  targetVersion: number = SCHEMA_VERSION,
): Promise<void> {
  const versionRow = await db.getFirstAsync<{ version: number }>(
    'SELECT version FROM schema_version'
  ).catch(() => null);

  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion >= targetVersion) {
    return;
  }

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration for version ${v}`);
    }
    await db.execAsync('BEGIN');
    try {
      await db.execAsync(migration);
      await db.execAsync('COMMIT');
    } catch (e) {
      await db.execAsync('ROLLBACK');
      throw e;
    }
  }
}

export { SCHEMA_VERSION };
