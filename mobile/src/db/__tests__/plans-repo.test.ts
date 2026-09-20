/**
 * Plans repo: the document round trip, the last-writer-wins rule that decides
 * whether a server copy lands, and the two cases the table itself cannot
 * express — a malformed `document_json` reads as an absent plan, and deleting
 * an imported trail takes its plan (tombstones included) with it.
 */

import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as plansRepo from '../plans-repo';
import type { PlanDocument } from '@lib/plan-types';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const TRAIL = 'larapinta';

function doc(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'plan-1',
    trailId: TRAIL,
    name: 'Larapinta',
    direction: 'NOBO',
    startDate: '2026-10-01',
    stops: [{ waypointId: 'w_abcd1234', km: 12.5, name: 'Standley Chasm', nights: 1 }],
    updatedAt: '2026-09-20T10:00:00Z',
    version: 1,
    ...overrides,
  };
}

describe('plans-repo', () => {
  it('round-trips a document through upsertLocal', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc());

    const stored = await plansRepo.getByTrail(d, TRAIL);
    expect(stored).toEqual(doc());

    const row = await plansRepo.getById(d, 'plan-1');
    expect(row?.source).toBe('local');
    expect(row?.deletedAt).toBeNull();
    expect(row?.trailId).toBe(TRAIL);
  });

  it('replaces the stored document on a second local edit', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc());
    await plansRepo.upsertLocal(d, doc({ name: 'Renamed', updatedAt: '2026-09-20T11:00:00Z' }));

    const stored = await plansRepo.getByTrail(d, TRAIL);
    expect(stored?.name).toBe('Renamed');
    const all = await d.getAllAsync<{ id: string }>('SELECT id FROM plans');
    expect(all).toHaveLength(1);
  });

  it('returns null for a trail with no plan', async () => {
    const d = await db();
    expect(await plansRepo.getByTrail(d, 'heysen')).toBeNull();
    expect(await plansRepo.getById(d, 'nope')).toBeNull();
  });

  describe('upsertServer (last-writer-wins)', () => {
    it('stores a copy when nothing is stored', async () => {
      const d = await db();
      expect(await plansRepo.upsertServer(d, doc())).toBe(true);
      const row = await plansRepo.getById(d, 'plan-1');
      expect(row?.source).toBe('server');
    });

    it('stores a strictly newer copy', async () => {
      const d = await db();
      await plansRepo.upsertLocal(d, doc());
      const applied = await plansRepo.upsertServer(
        d,
        doc({ name: 'From the server', updatedAt: '2026-09-20T12:00:00Z' }),
      );
      expect(applied).toBe(true);
      const stored = await plansRepo.getByTrail(d, TRAIL);
      expect(stored?.name).toBe('From the server');
    });

    it('leaves an equal or older copy alone', async () => {
      const d = await db();
      await plansRepo.upsertLocal(d, doc({ name: 'Mine' }));

      expect(await plansRepo.upsertServer(d, doc({ name: 'Same clock' }))).toBe(false);
      expect(
        await plansRepo.upsertServer(
          d,
          doc({ name: 'Older', updatedAt: '2026-09-19T00:00:00Z' }),
        ),
      ).toBe(false);

      const stored = await plansRepo.getByTrail(d, TRAIL);
      expect(stored?.name).toBe('Mine');
      expect((await plansRepo.getById(d, 'plan-1'))?.source).toBe('local');
    });

    it('drops the trail’s other live plan when the server sends a different id', async () => {
      const d = await db();
      await plansRepo.upsertLocal(d, doc({ id: 'local-id' }));
      await plansRepo.upsertServer(
        d,
        doc({ id: 'server-id', name: 'Adopted', updatedAt: '2026-09-20T12:00:00Z' }),
      );

      const live = await d.getAllAsync<{ id: string }>(
        'SELECT id FROM plans WHERE trail_id = ? AND deleted_at IS NULL',
        [TRAIL],
      );
      expect(live.map((r) => r.id)).toEqual(['server-id']);
      expect((await plansRepo.getByTrail(d, TRAIL))?.name).toBe('Adopted');
    });
  });

  it('treats a malformed row as an absent plan and logs it', async () => {
    const d = await db();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await d.runAsync(
        `INSERT INTO plans (id, trail_id, document_json, updated_at, source)
         VALUES ('bad-json', 'heysen', '{not json', '2026-09-20T00:00:00Z', 'local')`,
      );
      await d.runAsync(
        `INSERT INTO plans (id, trail_id, document_json, updated_at, source)
         VALUES ('bad-shape', 'bibbulmun', '{"id":"x","stops":"lots"}', '2026-09-20T00:00:00Z', 'local')`,
      );

      expect(await plansRepo.getByTrail(d, 'heysen')).toBeNull();
      expect(await plansRepo.getByTrail(d, 'bibbulmun')).toBeNull();
      expect(await plansRepo.getById(d, 'bad-shape')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('tombstones a plan: it stops reading back, and frees the trail', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc());
    await plansRepo.tombstone(d, 'plan-1', '2026-09-21T00:00:00Z');

    expect(await plansRepo.getByTrail(d, TRAIL)).toBeNull();
    const row = await plansRepo.getById(d, 'plan-1');
    expect(row?.deletedAt).toBe('2026-09-21T00:00:00Z');
    expect(row?.updatedAt).toBe('2026-09-21T00:00:00Z');

    // A fresh plan for the same trail is allowed alongside the tombstone.
    await plansRepo.upsertLocal(d, doc({ id: 'plan-2', updatedAt: '2026-09-21T01:00:00Z' }));
    expect((await plansRepo.getByTrail(d, TRAIL))?.id).toBe('plan-2');
  });

  it('deleteForTrail removes every row for that trail only', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc({ id: 'gone', trailId: 'u_import' }));
    await plansRepo.tombstone(d, 'gone');
    await plansRepo.upsertLocal(d, doc({ id: 'also-gone', trailId: 'u_import' }));
    await plansRepo.upsertLocal(d, doc({ id: 'kept' }));

    await plansRepo.deleteForTrail(d, 'u_import');

    const rows = await d.getAllAsync<{ id: string }>('SELECT id FROM plans');
    expect(rows.map((r) => r.id)).toEqual(['kept']);
  });

  it('purgeAll drops every plan', async () => {
    const d = await db();
    await plansRepo.upsertLocal(d, doc());
    await plansRepo.upsertLocal(d, doc({ id: 'other', trailId: 'heysen' }));

    await plansRepo.purgeAll(d);

    expect(await d.getAllAsync('SELECT id FROM plans')).toHaveLength(0);
  });
});
