/**
 * SQLite open helper.
 *
 * Opens the single app database and runs pending migrations. Returns a cached
 * promise so concurrent callers share one connection. Keep this minimal — the
 * schema itself lives in `schema.ts`.
 *
 * NOTE (Phase 1): the `guides` table exists for later use, but offline-tile
 * status is derived from the filesystem via the tile manager (see
 * `downloads-store`), which is the source of truth. Nothing in Phase 1 writes
 * to `guides` yet.
 */

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './schema';

const DB_NAME = 'tracknotes.db';

let dbPromise: Promise<SQLiteDatabase> | null = null;

/** Open (once) and migrate the app database. */
export function getDatabase(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openDatabaseAsync(DB_NAME);
      await migrateDatabase(db);
      return db;
    })();
  }
  return dbPromise;
}

/** Test seam: drop the cached connection so the next call re-opens. */
export function resetDatabaseForTests(): void {
  dbPromise = null;
}
