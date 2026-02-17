import { createTestDatabase, type TestDatabase } from './sqlite-test-adapter';
import { migrateDatabase } from '../schema';

/**
 * Create a fresh in-memory SQLite DB with all migrations applied.
 * Returns a TestDatabase that matches the expo-sqlite interface.
 */
export async function createMigratedTestDb(): Promise<TestDatabase> {
  const db = createTestDatabase();
  // Enable foreign keys like the production database
  await db.execAsync('PRAGMA foreign_keys = ON');
  await migrateDatabase(db as any);
  return db;
}
