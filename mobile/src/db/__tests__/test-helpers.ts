import { createTestDatabase, type TestDatabase } from './sqlite-test-adapter';
import { migrateDatabase } from '../schema';

/**
 * Create a fresh in-memory SQLite DB with all migrations applied.
 * Returns a TestDatabase that matches the expo-sqlite interface.
 */
export async function createMigratedTestDb(): Promise<TestDatabase> {
  const db = createTestDatabase();
  // FK enforcement is enabled in createTestDatabase() via db.pragma().
  await migrateDatabase(db as any);
  return db;
}

/**
 * Assert that an async DB operation rejects.
 *
 * Prefer this over `await expect(op()).rejects.toThrow()` for anything that goes
 * through the better-sqlite3 test adapter. The adapter calls better-sqlite3
 * *synchronously*, so a failing write makes an `async` method return an
 * already-rejected promise. Under the full Jest suite — when a DB spec shares a
 * worker with the fake-timer specs — jest's `.rejects` matcher intermittently
 * reported such promises as "did not throw" even though SQLite had correctly
 * rejected the write (verified: at the insert, `foreign_keys=1`, not in a
 * transaction, and `stmt.run()` threw). An explicit try/catch + await observes
 * the rejection deterministically and is immune to that timing.
 */
export async function expectDbRejection(op: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await op();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}
