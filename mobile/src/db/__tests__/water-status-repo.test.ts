import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as commentsRepo from '../comments-repo';
import { listWaterReportsByTrail } from '../water-status-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const TRAIL = 'aawt';
const SINCE = '2026-04-21T00:00:00.000Z';

function serverInput(
  overrides: Partial<commentsRepo.ServerCommentInput> = {},
): commentsRepo.ServerCommentInput {
  return {
    id: 'c1',
    trailId: TRAIL,
    waypointId: 'w_creek',
    displayName: 'Ranger',
    text: null,
    waterStatus: 'flowing',
    observedAt: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('water-status-repo', () => {
  it('returns only rows that carry a water status', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'with-status' }));
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'plain', waterStatus: null, text: 'Nice spot' }),
    );

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows).toEqual([
      {
        waypointId: 'w_creek',
        waterStatus: 'flowing',
        observedAt: null,
        createdAt: '2026-08-18T00:00:00.000Z',
      },
    ]);
  });

  it('scopes to the trail', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'ours' }));
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'theirs', trailId: 'heysen', waypointId: 'w_other' }),
    );

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows.map((r) => r.waypointId)).toEqual(['w_creek']);
  });

  it('excludes rows older than the window bound and keeps the boundary row', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'stale', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'edge', waypointId: 'w_edge', createdAt: SINCE }),
    );
    await commentsRepo.upsertServerComment(d, serverInput({ id: 'fresh' }));

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows.map((r) => r.createdAt).sort()).toEqual([SINCE, '2026-08-18T00:00:00.000Z']);
  });

  it('uses observed_at as the freshness time when present', async () => {
    const d = await db();
    // Written recently, observed long ago → outside the window.
    await commentsRepo.upsertServerComment(
      d,
      serverInput({
        id: 'observed-stale',
        createdAt: '2026-08-18T00:00:00.000Z',
        observedAt: '2026-01-05T00:00:00.000Z',
      }),
    );
    // Written long ago, observed recently → inside the window.
    await commentsRepo.upsertServerComment(
      d,
      serverInput({
        id: 'observed-fresh',
        waypointId: 'w_spring',
        createdAt: '2026-01-05T00:00:00.000Z',
        observedAt: '2026-08-17T00:00:00.000Z',
      }),
    );

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows.map((r) => r.waypointId)).toEqual(['w_spring']);
    expect(rows[0].observedAt).toBe('2026-08-17T00:00:00.000Z');
  });

  it('includes not-yet-synced local rows so an own report moves the chip', async () => {
    const d = await db();
    await commentsRepo.insertLocalComment(d, {
      id: 'local-1',
      trailId: TRAIL,
      waypointId: 'w_tank',
      authorId: 'me',
      authorName: 'Me',
      body: 'Tank empty',
      waterStatus: 'dry',
      observedAt: null,
      createdAt: '2026-08-19T00:00:00.000Z',
    });

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ waypointId: 'w_tank', waterStatus: 'dry' });
  });

  it('groups a waypoint together, newest report first', async () => {
    const d = await db();
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'old', createdAt: '2026-06-01T00:00:00.000Z' }),
    );
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'new', createdAt: '2026-08-10T00:00:00.000Z', waterStatus: 'low' }),
    );
    await commentsRepo.upsertServerComment(
      d,
      serverInput({ id: 'other-wp', waypointId: 'w_aaa', createdAt: '2026-07-01T00:00:00.000Z' }),
    );

    const rows = await listWaterReportsByTrail(d, TRAIL, SINCE);
    expect(rows.map((r) => [r.waypointId, r.createdAt])).toEqual([
      ['w_aaa', '2026-07-01T00:00:00.000Z'],
      ['w_creek', '2026-08-10T00:00:00.000Z'],
      ['w_creek', '2026-06-01T00:00:00.000Z'],
    ]);
  });

  it('returns an empty list for a trail with no reports', async () => {
    const d = await db();
    expect(await listWaterReportsByTrail(d, TRAIL, SINCE)).toEqual([]);
  });
});
