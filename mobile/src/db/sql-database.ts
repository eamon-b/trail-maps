/**
 * Database handle shared by the repositories.
 *
 * Repos are written against expo-sqlite's `SQLiteDatabase` (the production
 * type). The better-sqlite3 test adapter is structurally compatible but not
 * nominally so, so tests pass it with a cast — exactly the pattern the existing
 * `__tests__/test-helpers` uses for `migrateDatabase`.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export type SqlDatabase = SQLiteDatabase;
