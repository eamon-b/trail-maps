import { migrateDatabase, SCHEMA_VERSION } from '../schema';

describe('schema', () => {
  it('has SCHEMA_VERSION set to 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('runs all migrations on a fresh database', async () => {
    const executedSql: string[] = [];
    const mockDb = {
      getFirstAsync: jest.fn().mockRejectedValueOnce(new Error('no such table')),
      execAsync: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql);
        return Promise.resolve();
      }),
    };

    await migrateDatabase(mockDb as any);

    // Each migration runs 3 calls: BEGIN, migration SQL, COMMIT
    expect(executedSql.length).toBe(4 * 3);

    // Migration 4 SQL is the 2nd call in the last group of 3 (BEGIN, SQL, COMMIT)
    const migration4 = executedSql[executedSql.length - 2];
    expect(migration4).toContain('is_custom');
    expect(migration4).toContain('source_filename');
    expect(migration4).toContain('track_data_json');
  });

  it('skips migrations if already at current version', async () => {
    const mockDb = {
      getFirstAsync: jest.fn().mockResolvedValueOnce({ version: SCHEMA_VERSION }),
      execAsync: jest.fn(),
    };

    await migrateDatabase(mockDb as any);

    expect(mockDb.execAsync).not.toHaveBeenCalled();
  });

  it('runs only pending migrations', async () => {
    const executedSql: string[] = [];
    const mockDb = {
      getFirstAsync: jest.fn().mockResolvedValueOnce({ version: 3 }),
      execAsync: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql);
        return Promise.resolve();
      }),
    };

    await migrateDatabase(mockDb as any);

    // Should only run migration 4: BEGIN, SQL, COMMIT
    expect(executedSql.length).toBe(3);
    expect(executedSql[1]).toContain('is_custom');
  });
});
