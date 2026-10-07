/**
 * Everything the phone keeps about one guide, apart from the guide itself —
 * cleared when the guide leaves the phone, so a trail id that comes back later
 * (a re-import of the same file, a community route downloaded again) starts
 * clean, and nothing lingers that no screen can reach any more:
 *
 * - SQLite: custom routes and their points, favourites, sync marks, comments,
 *   outbox rows, waypoint metadata (`db/trail-data-repo`) and the plan
 *   (`plans-repo`), in one transaction;
 * - the in-memory caches over those (`plans-store`, `favorites-store`,
 *   `routes-store`);
 * - the device-local preferences: pace and daily hours (`plan-inputs-store`),
 *   the hiking direction, and the "Hiking now" pin (`settings-store`).
 *
 * The plan is HARD-deleted, not tombstoned: only local-only guides (`u_`
 * imports, `c_` community routes) are ever removed, and their plans were never
 * sent to the server (`isServerKnown`), so there is no one to tell.
 *
 * Callers: `imported-trail-store.deleteImportedTrailEverywhere` and the
 * community route removals in `community-routes`. A bundled or catalog id is
 * refused (a no-op): those guides never leave the phone, and their plans sync.
 */

import * as plansRepo from '../db/plans-repo';
import type { SqlDatabase } from '../db/sql-database';
import { deleteTrailScopedRows } from '../db/trail-data-repo';
import { withTransaction } from '../db/transaction';
import { usePlanInputsStore } from '../features/plan/plan-inputs-store';
import { useRoutesStore } from '../features/routes/routes-store';
import { useFavoritesStore } from '../state/favorites-store';
import { usePlansStore } from '../state/plans-store';
import { useSettingsStore } from '../state/settings-store';
import { isLocalOnlyTrailId } from './server-trails';

export async function deleteLocalTrailData(db: SqlDatabase, trailId: string): Promise<void> {
  if (!isLocalOnlyTrailId(trailId)) return;
  await withTransaction(db, async () => {
    await deleteTrailScopedRows(db, trailId);
    await plansRepo.deleteForTrail(db, trailId);
  });

  usePlansStore.getState().clear(trailId);
  useFavoritesStore.getState().forgetTrail(trailId);
  useRoutesStore.getState().forgetTrail(trailId);
  usePlanInputsStore.getState().clearTrail(trailId);
  const settings = useSettingsStore.getState();
  settings.clearDirection(trailId);
  settings.clearCurrentTrailIf(trailId);
}
