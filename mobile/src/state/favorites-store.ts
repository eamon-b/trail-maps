/**
 * Favorite (starred) waypoints, backed by the local `favorites` table.
 *
 * Hydrated per-trail when the guide opens; the detail-screen heart and the
 * list-row badge read from here so a toggle reflects everywhere instantly.
 * Ids are held as plain arrays (not Sets) so selectors get stable, cheap
 * equality and zustand re-renders correctly on immutable updates.
 */

import { create } from 'zustand';
import { getDatabase } from '../db/database';
import * as favoritesRepo from '../db/favorites-repo';

export interface FavoritesState {
  /** trailId → starred waypoint ids. */
  byTrail: Record<string, string[]>;
  hydrate: (trailId: string) => Promise<void>;
  toggle: (trailId: string, waypointId: string) => Promise<boolean>;
  isFavorite: (trailId: string, waypointId: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  byTrail: {},

  hydrate: async (trailId: string) => {
    const db = await getDatabase();
    const ids = await favoritesRepo.list(db, trailId);
    set((s) => ({ byTrail: { ...s.byTrail, [trailId]: ids } }));
  },

  toggle: async (trailId: string, waypointId: string) => {
    const db = await getDatabase();
    const nowFavorite = await favoritesRepo.toggle(db, trailId, waypointId);
    set((s) => {
      const current = s.byTrail[trailId] ?? [];
      const next = nowFavorite
        ? [waypointId, ...current.filter((id) => id !== waypointId)]
        : current.filter((id) => id !== waypointId);
      return { byTrail: { ...s.byTrail, [trailId]: next } };
    });
    return nowFavorite;
  },

  isFavorite: (trailId: string, waypointId: string) =>
    (get().byTrail[trailId] ?? []).includes(waypointId),
}));

/** Reactive selector for a single waypoint's favorite state. */
export function selectIsFavorite(trailId: string, waypointId: string) {
  return (s: FavoritesState): boolean => (s.byTrail[trailId] ?? []).includes(waypointId);
}
