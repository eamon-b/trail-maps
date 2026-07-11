import { migrateDatabase, SCHEMA_VERSION } from '../schema';

describe('schema', () => {
  it('has SCHEMA_VERSION set to 6', () => {
    expect(SCHEMA_VERSION).toBe(6);
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
    expect(executedSql.length).toBe(6 * 3);

    // Migration 6 SQL is the 2nd call in the last group of 3 (BEGIN, SQL, COMMIT)
    const migration6 = executedSql[executedSql.length - 2];
    expect(migration6).toContain('photo_uri');

    // Migration 5 is the group before it
    const migration5 = executedSql[executedSql.length - 5];
    expect(migration5).toContain('custom_waypoints');
    expect(migration5).toContain('km_position');
    expect(migration5).toContain('off_track_m');
    expect(migration5).toContain('climate_json');
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
      getFirstAsync: jest.fn().mockResolvedValueOnce({ version: 4 }),
      execAsync: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql);
        return Promise.resolve();
      }),
    };

    await migrateDatabase(mockDb as any);

    // Should only run migrations 5 and 6: two groups of BEGIN, SQL, COMMIT
    expect(executedSql.length).toBe(6);
    expect(executedSql[1]).toContain('custom_waypoints');
    expect(executedSql[4]).toContain('photo_uri');
  });

  it('stops at an explicit target version', async () => {
    const executedSql: string[] = [];
    const mockDb = {
      getFirstAsync: jest.fn().mockRejectedValueOnce(new Error('no such table')),
      execAsync: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql);
        return Promise.resolve();
      }),
    };

    await migrateDatabase(mockDb as any, 4);

    // Migrations 1-4 only: 4 groups of BEGIN, SQL, COMMIT
    expect(executedSql.length).toBe(4 * 3);
    const migration4 = executedSql[executedSql.length - 2];
    expect(migration4).toContain('is_custom');
    expect(migration4).not.toContain('custom_waypoints');
  });
});
