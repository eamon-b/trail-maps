/**
 * Tests for imported-trails-repo — registry CRUD plus the MANUAL delete cascade.
 *
 * The cascade is the load-bearing part: production never enables
 * `PRAGMA foreign_keys` and none of the scoped tables declare a FK on
 * `trail_id`, so nothing but this repo's own DELETEs removes the rows.
 */

import { createMigratedTestDb, expectDbRejection } from './test-helpers';
import {
  listImportedTrails,
  getImportedTrail,
  upsertImportedTrail,
  deleteImportedTrail,
} from '../imported-trails-repo';
import type { TestDatabase } from './sqlite-test-adapter';

const TRAIL = {
  id: 'u_abc123',
  name: 'My Weekend Loop',
  shortName: 'Weekend Loop',
  lengthKm: 42.5,
};

describe('imported-trails-repo — CRUD', () => {
  it('returns an empty list on a fresh database', async () => {
    const db = await createMigratedTestDb();
    expect(await listImportedTrails(db as never)).toEqual([]);
  });

  it('inserts a row and reads it back with defaults applied', async () => {
    const db = await createMigratedTestDb();
    await upsertImportedTrail(db as never, TRAIL);

    const row = await getImportedTrail(db as never, 'u_abc123');
    expect(row).toMatchObject({
      id: 'u_abc123',
      name: 'My Weekend Loop',
      shortName: 'Weekend Loop',
      lengthKm: 42.5,
      source: 'imported',
      hasElevation: true,
      pointCount: null,
      waypointCount: null,
    });
    expect(typeof row?.createdAt).toBe('string');
  });

  it('round-trips the quality metadata', async () => {
    const db = await createMigratedTestDb();
    await upsertImportedTrail(db as never, {
      ...TRAIL,
      hasElevation: false,
      pointCount: 4821,
      waypointCount: 17,
    });

    const row = await getImportedTrail(db as never, 'u_abc123');
    expect(row?.hasElevation).toBe(false);
    expect(row?.pointCount).toBe(4821);
    expect(row?.waypointCount).toBe(17);
  });

  it('returns null for an unknown id (e.g. a bundled trail)', async () => {
    const db = await createMigratedTestDb();
    await upsertImportedTrail(db as never, TRAIL);
    expect(await getImportedTrail(db as never, 'larapinta')).toBeNull();
  });

  it('upserts on a repeat import instead of failing the primary key', async () => {
    const db = await createMigratedTestDb();
    await upsertImportedTrail(db as never, TRAIL);
    const first = await getImportedTrail(db as never, 'u_abc123');

    await upsertImportedTrail(db as never, {
      ...TRAIL,
      name: 'Renamed Loop',
      lengthKm: 43.1,
      pointCount: 99,
    });

    const rows = await listImportedTrails(db as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed Loop');
    expect(rows[0].lengthKm).toBe(43.1);
    expect(rows[0].pointCount).toBe(99);
    // created_at survives the re-import so the list position is stable.
    expect(rows[0].createdAt).toBe(first?.createdAt);
  });

  it('lists newest first, tie-broken by insertion order', async () => {
    const db = await createMigratedTestDb();
    await upsertImportedTrail(db as never, { ...TRAIL, id: 'u_one', name: 'One' });
    await upsertImportedTrail(db as never, { ...TRAIL, id: 'u_two', name: 'Two' });
    await upsertImportedTrail(db as never, { ...TRAIL, id: 'u_three', name: 'Three' });

    const ids = (await listImportedTrails(db as never)).map((t) => t.id);
    expect(ids).toEqual(['u_three', 'u_two', 'u_one']);
  });

  it('rejects a row with a NULL name', async () => {
    const db = await createMigratedTestDb();
    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO imported_trails (id, name, short_name, length_km)
         VALUES ('u_bad', NULL, 'Bad', 1)`,
      ),
    );
  });

  it('rejects a row with a NULL length_km', async () => {
    const db = await createMigratedTestDb();
    await expectDbRejection(() =>
      db.runAsync(
        `INSERT INTO imported_trails (id, name, short_name, length_km)
         VALUES ('u_bad', 'Bad', 'Bad', NULL)`,
      ),
    );
  });
});

describe('imported-trails-repo — manual delete cascade', () => {
  /** Seed one row in every table scoped by `trail_id`, for two trails. */
  async function seedScopedRows(db: TestDatabase, trailId: string): Promise<void> {
    await upsertImportedTrail(db as never, { ...TRAIL, id: trailId });
    await db.runAsync('INSERT INTO favorites (trail_id, waypoint_id) VALUES (?, ?)', [
      trailId,
      'uw_1',
    ]);
    await db.runAsync(
      `INSERT INTO routes (id, trail_id, name, total_km, ascent_m, descent_m, created_at, updated_at)
       VALUES (?, ?, 'Day 1', 12.3, 400, 200, '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')`,
      [`rt_${trailId}`, trailId],
    );
    await db.runAsync(
      `INSERT INTO route_points (route_id, seq, kind, lat, lon, km)
       VALUES (?, 0, 'snap', -23.5, 133.2, 4.5)`,
      [`rt_${trailId}`],
    );
    await db.runAsync(
      'INSERT INTO sync_state (trail_id, comments_cursor, last_synced_at) VALUES (?, ?, ?)',
      [trailId, 'cursor', '2026-08-22T00:00:00Z'],
    );
    await db.runAsync(
      `INSERT INTO comments (id, trail_id, waypoint_id, body, created_at)
       VALUES (?, ?, 'uw_1', 'flowing', '2026-08-22T00:00:00Z')`,
      [`c_${trailId}`, trailId],
    );
    await db.runAsync(
      `INSERT INTO outbox (id, kind, trail_id, waypoint_id, payload_json)
       VALUES (?, 'comment', ?, 'uw_1', '{}')`,
      [`o_${trailId}`, trailId],
    );
    await db.runAsync(
      `INSERT INTO waypoint_meta (trail_id, waypoint_id, description, updated_at)
       VALUES (?, 'uw_1', 'Tank.', '2026-08-22T00:00:00Z')`,
      [trailId],
    );
  }

  async function countFor(db: TestDatabase, trailId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of [
      'imported_trails',
      'favorites',
      'routes',
      'sync_state',
      'comments',
      'outbox',
      'waypoint_meta',
    ]) {
      const col = table === 'imported_trails' ? 'id' : 'trail_id';
      const row = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`,
        [trailId],
      );
      counts[table] = row?.n ?? 0;
    }
    const points = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM route_points WHERE route_id = ?',
      [`rt_${trailId}`],
    );
    counts.route_points = points?.n ?? 0;
    return counts;
  }

  it('clears every scoped table for the deleted trail', async () => {
    const db = await createMigratedTestDb();
    await seedScopedRows(db, 'u_gone');

    expect(await countFor(db, 'u_gone')).toEqual({
      imported_trails: 1,
      favorites: 1,
      routes: 1,
      route_points: 1,
      sync_state: 1,
      comments: 1,
      outbox: 1,
      waypoint_meta: 1,
    });

    await deleteImportedTrail(db as never, 'u_gone');

    expect(await countFor(db, 'u_gone')).toEqual({
      imported_trails: 0,
      favorites: 0,
      routes: 0,
      route_points: 0,
      sync_state: 0,
      comments: 0,
      outbox: 0,
      waypoint_meta: 0,
    });
  });

  it('leaves other trails untouched', async () => {
    const db = await createMigratedTestDb();
    await seedScopedRows(db, 'u_gone');
    await seedScopedRows(db, 'larapinta');

    await deleteImportedTrail(db as never, 'u_gone');

    expect(await countFor(db, 'larapinta')).toEqual({
      imported_trails: 1,
      favorites: 1,
      routes: 1,
      route_points: 1,
      sync_state: 1,
      comments: 1,
      outbox: 1,
      waypoint_meta: 1,
    });
  });

  it('deletes route_points explicitly, not via the FK pragma', async () => {
    // route_points has ON DELETE CASCADE against routes(id), which the test
    // adapter would honour. Prove the repo does the work itself by turning the
    // pragma off first — production runs exactly this way.
    const db = await createMigratedTestDb();
    await db.execAsync('PRAGMA foreign_keys = OFF');
    // Guard: if the pragma silently failed to apply, this test would be
    // asserting the FK cascade instead of the repo's own DELETEs.
    const pragma = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(pragma?.foreign_keys).toBe(0);

    await seedScopedRows(db, 'u_gone');

    await deleteImportedTrail(db as never, 'u_gone');

    const points = await db.getAllAsync<{ seq: number }>(
      "SELECT seq FROM route_points WHERE route_id = 'rt_u_gone'",
    );
    expect(points).toHaveLength(0);
  });

  it('is a no-op for an id that was never imported', async () => {
    const db = await createMigratedTestDb();
    await seedScopedRows(db, 'u_keep');

    await deleteImportedTrail(db as never, 'u_never');

    expect((await countFor(db, 'u_keep')).imported_trails).toBe(1);
  });
});
