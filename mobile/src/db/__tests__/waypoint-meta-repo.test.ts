import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as metaRepo from '../waypoint-meta-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

describe('waypoint-meta-repo', () => {
  it('upserts and reads descriptions per trail', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'Tank on the west side.', updatedAt: 'T1' },
      { waypointId: 'w_2', description: 'Locked hut.', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'larapinta', [
      { waypointId: 'w_1', description: 'Different trail.', updatedAt: 'T1' },
    ]);

    const map = await metaRepo.getDescriptions(d, 'aawt');
    expect(map.get('w_1')).toBe('Tank on the west side.');
    expect(map.get('w_2')).toBe('Locked hut.');
    expect(map.size).toBe(2);
    expect(await metaRepo.getDescription(d, 'larapinta', 'w_1')).toBe('Different trail.');
  });

  it('overwrites an existing row on conflict', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'old', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'new', updatedAt: 'T2' },
    ]);
    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBe('new');
    const row = await d.getFirstAsync<{ updated_at: string; n: number }>(
      "SELECT updated_at, (SELECT COUNT(*) FROM waypoint_meta) AS n FROM waypoint_meta WHERE waypoint_id = 'w_1'",
    );
    expect(row?.updated_at).toBe('T2');
    expect(row?.n).toBe(1);
  });

  it('stores a cleared row but hides it from readers', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'Tank is here.', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: '', updatedAt: 'T2' },
    ]);

    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBeNull();
    expect((await metaRepo.getDescriptions(d, 'aawt')).size).toBe(0);
    // The row itself survives, so a later re-fill upserts onto the same key.
    const row = await d.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM waypoint_meta',
    );
    expect(row?.n).toBe(1);
  });

  it('returns null for an unknown waypoint', async () => {
    const d = await db();
    expect(await metaRepo.getDescription(d, 'aawt', 'nope')).toBeNull();
  });

  it('keeps the meta high-water mark separate from the comment cursor', async () => {
    const d = await db();
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBeUndefined();

    await metaRepo.writeMetaSyncedAt(d, 'aawt', 'M1');
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBe('M1');

    // A comment cursor write must not disturb it, nor vice versa.
    await d.runAsync(
      `INSERT INTO sync_state (trail_id, last_synced_at) VALUES (?, ?)
       ON CONFLICT(trail_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
      ['aawt', 'C1'],
    );
    await metaRepo.writeMetaSyncedAt(d, 'aawt', 'M2');
    const row = await d.getFirstAsync<{ last_synced_at: string; meta_synced_at: string }>(
      'SELECT last_synced_at, meta_synced_at FROM sync_state WHERE trail_id = ?',
      ['aawt'],
    );
    expect(row).toEqual({ last_synced_at: 'C1', meta_synced_at: 'M2' });
  });
});
