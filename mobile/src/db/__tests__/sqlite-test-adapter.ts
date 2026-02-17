/**
 * Test adapter that wraps better-sqlite3 in-memory DB to match
 * the expo-sqlite SQLiteDatabase interface used by our services.
 */
import Database from 'better-sqlite3';

export interface TestDatabase {
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execAsync(sql: string): Promise<void>;
  closeAsync(): Promise<void>;
}

export function createTestDatabase(): TestDatabase {
  const db = new Database(':memory:');

  return {
    async runAsync(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      const result = stmt.run(...params);
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },

    async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...params);
      return (row as T) ?? null;
    },

    async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as T[];
    },

    async execAsync(sql: string) {
      db.exec(sql);
    },

    async closeAsync() {
      db.close();
    },
  };
}
