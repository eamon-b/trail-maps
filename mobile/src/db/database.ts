import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './schema';

const DB_NAME = 'trail-companion.db';

let dbInstance: SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLiteDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  const db = await openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL');
  await db.execAsync('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  dbInstance = db;
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.closeAsync();
    dbInstance = null;
  }
}
