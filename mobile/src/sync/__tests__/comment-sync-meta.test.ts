/**
 * Description sync rides `pullTrail` but is a separate channel: its own
 * high-water mark, and a failure there must never downgrade a successful
 * comment pull (the endpoint is public and may not even be deployed yet).
 */

import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as metaRepo from '../../db/waypoint-meta-repo';
import * as commentsRepo from '../../db/comments-repo';
import { pullTrail } from '../comment-sync';
import { onSyncChange, type SyncChange } from '../sync-events';

const BASE = 'https://api.test';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const EMPTY_COMMENTS = { comments: [], nextCursor: null, syncedAt: 'C1' };

/**
 * Fetch stub that answers by URL rather than by call order, since a pull hits
 * two endpoints. `descriptions` may be a step object to simulate a failure.
 */
function routedFetch(routes: {
  comments?: unknown;
  descriptions?: unknown;
  descriptionsStatus?: number;
  descriptionsThrows?: boolean;
}) {
  const fn = jest.fn(async (url: string) => {
    if (String(url).includes('/descriptions')) {
      if (routes.descriptionsThrows) throw new Error('offline');
      const status = routes.descriptionsStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        text: async () => JSON.stringify(routes.descriptions ?? {}),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: '',
      text: async () => JSON.stringify(routes.comments ?? EMPTY_COMMENTS),
    };
  });
  return fn as unknown as typeof fetch;
}

describe('pullTrail — waypoint descriptions', () => {
  it('mirrors descriptions and advances the meta high-water mark', async () => {
    const d = await db();
    const fetchImpl = routedFetch({
      descriptions: {
        descriptions: [
          { waypointId: 'w_1', description: 'Tank on the west side.', updatedAt: 'M1' },
          { waypointId: 'w_2', description: 'Locked hut.', updatedAt: 'M1' },
        ],
        syncedAt: 'M1',
      },
    });

    const res = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(res.outcome).toBe('pulled');
    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBe('Tank on the west side.');
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBe('M1');

    // A second pull carries the stored mark as `since`.
    await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    const descriptionUrls = (fetchImpl as unknown as jest.Mock).mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/descriptions'));
    expect(descriptionUrls[0]).not.toContain('since=');
    expect(descriptionUrls[1]).toContain('since=M1');
  });

  it('stores a cleared description so the bundled text takes over again', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'Old copy.', updatedAt: 'M0' },
    ]);
    const fetchImpl = routedFetch({
      descriptions: {
        descriptions: [{ waypointId: 'w_1', description: '', updatedAt: 'M1' }],
        syncedAt: 'M1',
      },
    });

    await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBeNull();
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM waypoint_meta');
    expect(row?.n).toBe(1); // tombstone kept
  });

  it('emits a sync change for description-only updates', async () => {
    const d = await db();
    const fetchImpl = routedFetch({
      descriptions: {
        descriptions: [{ waypointId: 'w_9', description: 'New notes.', updatedAt: 'M1' }],
        syncedAt: 'M1',
      },
    });
    const changes: SyncChange[] = [];
    const stop = onSyncChange((c) => changes.push(c));
    await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    stop();
    expect(changes).toEqual([{ trailId: 'aawt', waypointIds: ['w_9'] }]);
  });

  it.each([
    ['a transport failure', { descriptionsThrows: true }],
    ['a 500', { descriptionsStatus: 500 }],
    ['a 404 (endpoint not deployed)', { descriptionsStatus: 404 }],
  ])('keeps the comment pull successful despite %s', async (_label, over) => {
    const d = await db();
    const fetchImpl = routedFetch({
      comments: {
        comments: [
          {
            id: 'a',
            waypointId: 'w_1',
            displayName: 'Hiker',
            text: 'hi',
            waterStatus: null,
            observedAt: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
        syncedAt: 'C1',
      },
      ...over,
    });

    const res = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(res).toMatchObject({ outcome: 'pulled', applied: 1, syncedAt: 'C1' });
    expect(await commentsRepo.getById(d, 'a')).not.toBeNull();
    // The meta mark is untouched, so the next pull retries the same delta.
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBeUndefined();
  });

  it('tolerates a response with no descriptions field', async () => {
    const d = await db();
    const fetchImpl = routedFetch({ descriptions: { syncedAt: 'M1' } });
    const res = await pullTrail('aawt', { db: d, baseUrl: BASE, fetchImpl });
    expect(res.outcome).toBe('pulled');
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBe('M1');
  });
});
