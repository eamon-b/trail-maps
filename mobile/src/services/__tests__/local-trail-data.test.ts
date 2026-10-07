/**
 * `deleteLocalTrailData` — everything the phone keeps about a guide that is
 * leaving it (an imported trail deleted, a community route removed): SQLite
 * rows, the plan, the in-memory caches and the per-trail preferences. Other
 * trails' state must survive, and a bundled id is refused outright.
 */

import { newPlan } from '@lib/plan-editor';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import * as favoritesRepo from '../../db/favorites-repo';
import * as plansRepo from '../../db/plans-repo';
import * as routesRepo from '../../db/routes-repo';
import { upsertDescriptions } from '../../db/waypoint-meta-repo';
import { usePlanInputsStore } from '../../features/plan/plan-inputs-store';
import { useRoutesStore } from '../../features/routes/routes-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { usePlansStore } from '../../state/plans-store';
import { useSettingsStore } from '../../state/settings-store';
import { deleteLocalTrailData } from '../local-trail-data';

const GONE = 'c_AbCdEfGhIjKlMnOp';
const KEPT = 'u_kept';

async function seed(db: Awaited<ReturnType<typeof createMigratedTestDb>>, trailId: string) {
  await favoritesRepo.toggle(db as never, trailId, 'w1');
  await routesRepo.createRoute(db as never, {
    trailId,
    name: 'Loop',
    totalKm: 3,
    ascentM: 10,
    descentM: 10,
    points: [
      { kind: 'snap', lat: 0, lon: 0, km: 0 },
      { kind: 'snap', lat: 0, lon: 0.01, km: 1 },
    ],
  });
  await upsertDescriptions(db as never, trailId, [
    { waypointId: 'w1', description: 'Tank', updatedAt: '2026-10-01T00:00:00Z' },
  ]);
  await plansRepo.upsertLocal(db as never, newPlan(trailId, 'Plan', 'NOBO', { idFactory: () => `p-${trailId}` }));
}

async function count(db: Awaited<ReturnType<typeof createMigratedTestDb>>, table: string, trailId: string) {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE trail_id = ?`,
    [trailId],
  );
  return row?.n ?? 0;
}

beforeEach(() => {
  useSettingsStore.setState({ perTrailDirection: {}, currentTrailId: null });
  usePlanInputsStore.setState({ byTrail: {} });
  usePlansStore.setState({ byTrail: {} });
  useFavoritesStore.setState({ byTrail: {} });
  useRoutesStore.setState({ byTrail: {}, activeIdByTrail: {}, activePointsByTrail: {} });
});

describe('deleteLocalTrailData', () => {
  it('clears every row, cache and preference of the trail and nothing of the others', async () => {
    const db = await createMigratedTestDb();
    await seed(db, GONE);
    await seed(db, KEPT);
    await db.runAsync(
      "INSERT INTO sync_state (trail_id, last_synced_at) VALUES (?, '2026-10-01T00:00:00Z')",
      [GONE],
    );
    useSettingsStore.setState({
      perTrailDirection: { [GONE]: 'reversed', [KEPT]: 'reversed' },
      currentTrailId: GONE,
    });
    usePlanInputsStore.getState().setDailyHours(GONE, 6);
    usePlanInputsStore.getState().setDailyHours(KEPT, 9);
    useFavoritesStore.setState({ byTrail: { [GONE]: ['w1'], [KEPT]: ['w1'] } });
    useRoutesStore.setState({ byTrail: { [GONE]: [], [KEPT]: [] } });
    usePlansStore.setState({ byTrail: { [GONE]: undefined, [KEPT]: undefined } });

    await deleteLocalTrailData(db as never, GONE);

    for (const table of ['favorites', 'routes', 'waypoint_meta', 'plans', 'sync_state']) {
      expect([table, await count(db, table, GONE)]).toEqual([table, 0]);
    }
    const orphanPoints = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM route_points WHERE route_id NOT IN (SELECT id FROM routes)',
    );
    expect(orphanPoints?.n).toBe(0);
    for (const table of ['favorites', 'routes', 'waypoint_meta', 'plans']) {
      expect([table, await count(db, table, KEPT)]).toEqual([table, 1]);
    }

    const settings = useSettingsStore.getState();
    expect(settings.perTrailDirection).toEqual({ [KEPT]: 'reversed' });
    expect(settings.currentTrailId).toBeNull();
    expect(usePlanInputsStore.getState().byTrail[GONE]).toBeUndefined();
    expect(usePlanInputsStore.getState().byTrail[KEPT]?.dailyHours).toBe(9);
    expect(Object.keys(useFavoritesStore.getState().byTrail)).toEqual([KEPT]);
    expect(Object.keys(useRoutesStore.getState().byTrail)).toEqual([KEPT]);
    expect(Object.keys(usePlansStore.getState().byTrail)).toEqual([KEPT]);
  });

  it('leaves another trail pinned as the current hike', async () => {
    const db = await createMigratedTestDb();
    useSettingsStore.setState({ currentTrailId: KEPT });
    await deleteLocalTrailData(db as never, GONE);
    expect(useSettingsStore.getState().currentTrailId).toBe(KEPT);
  });

  it('refuses a bundled (server-known) id', async () => {
    const db = await createMigratedTestDb();
    await seed(db, 'heysen');
    useSettingsStore.setState({ currentTrailId: 'heysen' });
    await deleteLocalTrailData(db as never, 'heysen');
    expect(await count(db, 'favorites', 'heysen')).toBe(1);
    expect(await count(db, 'plans', 'heysen')).toBe(1);
    expect(useSettingsStore.getState().currentTrailId).toBe('heysen');
  });
});
