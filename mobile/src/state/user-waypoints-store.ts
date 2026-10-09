/**
 * Hiker-added waypoints per trail (`db/user-waypoints-repo`), held in memory
 * for the open guide.
 *
 * Hydrated when a guide opens and re-read on every sync change that says a
 * trail's hiker waypoints moved (a save, a delete, a pull, a drain), so the
 * map, list and detail screen all follow one copy. Writes go through
 * `sync/waypoint-sync`, never here: this store only mirrors SQLite.
 */

import { create } from 'zustand';
import type { UserWaypoint } from '@lib/user-waypoints';
import { getDatabase } from '../db/database';
import * as userWaypointsRepo from '../db/user-waypoints-repo';
import { onSyncChange } from '../sync/sync-events';

export interface UserWaypointsState {
  /** trailId → its hiker waypoints. Absent until hydrated. */
  byTrail: Record<string, UserWaypoint[]>;
  hydrate: (trailId: string) => Promise<void>;
  /** Drop a trail's cached waypoints (its rows were deleted with the guide). */
  forgetTrail: (trailId: string) => void;
}

const EMPTY: UserWaypoint[] = [];

export const useUserWaypointsStore = create<UserWaypointsState>((set) => ({
  byTrail: {},

  hydrate: async (trailId: string) => {
    const db = await getDatabase();
    const rows = await userWaypointsRepo.listForTrail(db, trailId);
    const list: UserWaypoint[] = rows.map(({ source: _source, ...waypoint }) => waypoint);
    set((s) => ({ byTrail: { ...s.byTrail, [trailId]: list } }));
  },

  forgetTrail: (trailId: string) =>
    set((s) => {
      if (!(trailId in s.byTrail)) return s;
      const byTrail = { ...s.byTrail };
      delete byTrail[trailId];
      return { byTrail };
    }),
}));

/** A trail's hiker waypoints (a stable empty array until hydrated). */
export function selectUserWaypoints(trailId: string) {
  return (s: UserWaypointsState): UserWaypoint[] => s.byTrail[trailId] ?? EMPTY;
}

/** One hiker waypoint by id, or null. */
export function selectUserWaypoint(trailId: string, id: string | undefined) {
  return (s: UserWaypointsState): UserWaypoint | null =>
    (id && (s.byTrail[trailId] ?? EMPTY).find((w) => w.id === id)) || null;
}

// Every hydrated trail follows the sync bus. Module scope, like the bus itself:
// a store has no lifecycle to subscribe in, and a re-read is one indexed query.
onSyncChange((change) => {
  if (!change.userWaypoints || !change.trailId) return;
  const { byTrail, hydrate } = useUserWaypointsStore.getState();
  if (change.trailId in byTrail) void hydrate(change.trailId).catch(() => {});
});
