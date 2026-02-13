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

    // Should run migrations 1 through 4
    expect(executedSql.length).toBe(4);

    // Migration 4 should add custom trail columns
    const migration4 = executedSql[3];
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

    // Should only run migration 4
    expect(executedSql.length).toBe(1);
    expect(executedSql[0]).toContain('is_custom');
  });
});
