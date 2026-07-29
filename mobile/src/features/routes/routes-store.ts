/**
 * Custom-routes store — the saved routes for a trail plus the currently
 * activated route (the one overlaid on the map + highlighted on the profile).
 *
 * Mirrors `favorites-store`: a small zustand store the guide hydrates on open
 * and the routes screen / builder mutate. The route LIST is cached per trail
 * (with denormalized stats, so rendering never touches geometry); the ACTIVE
 * route additionally caches its ordered points so the map pane and elevation
 * pane can derive overlay + highlight geometry against their own track.
 */

import { create } from 'zustand';
import { getDatabase } from '../../db/database';
import * as routesRepo from '../../db/routes-repo';
import type { NewRoute, Route, RoutePoint } from '../../db/routes-repo';

export interface RoutesState {
  /** trailId → saved routes (newest first). */
  byTrail: Record<string, Route[]>;
  /** trailId → activated route id (null/absent = none active). */
  activeIdByTrail: Record<string, string | null>;
  /** trailId → ordered points of the active route (for overlay/highlight). */
  activePointsByTrail: Record<string, RoutePoint[] | undefined>;

  hydrate: (trailId: string) => Promise<void>;
  save: (input: NewRoute) => Promise<Route>;
  remove: (trailId: string, id: string) => Promise<void>;
  /** Activate a route (loads its points) or clear the active route (null). */
  activate: (trailId: string, id: string | null) => Promise<void>;
}

export const useRoutesStore = create<RoutesState>((set, get) => ({
  byTrail: {},
  activeIdByTrail: {},
  activePointsByTrail: {},

  hydrate: async (trailId) => {
    const db = await getDatabase();
    const routes = await routesRepo.listRoutes(db, trailId);
    set((s) => ({ byTrail: { ...s.byTrail, [trailId]: routes } }));
  },

  save: async (input) => {
    const db = await getDatabase();
    const route = await routesRepo.createRoute(db, input);
    set((s) => ({
      byTrail: {
        ...s.byTrail,
        [input.trailId]: [route, ...(s.byTrail[input.trailId] ?? [])],
      },
    }));
    return route;
  },

  remove: async (trailId, id) => {
    const db = await getDatabase();
    await routesRepo.deleteRoute(db, id);
    set((s) => {
      const wasActive = s.activeIdByTrail[trailId] === id;
      return {
        byTrail: {
          ...s.byTrail,
          [trailId]: (s.byTrail[trailId] ?? []).filter((r) => r.id !== id),
        },
        activeIdByTrail: wasActive
          ? { ...s.activeIdByTrail, [trailId]: null }
          : s.activeIdByTrail,
        activePointsByTrail: wasActive
          ? { ...s.activePointsByTrail, [trailId]: undefined }
          : s.activePointsByTrail,
      };
    });
  },

  activate: async (trailId, id) => {
    if (id == null) {
      set((s) => ({
        activeIdByTrail: { ...s.activeIdByTrail, [trailId]: null },
        activePointsByTrail: { ...s.activePointsByTrail, [trailId]: undefined },
      }));
      return;
    }
    const db = await getDatabase();
    const points = await routesRepo.getRoutePoints(db, id);
    set((s) => ({
      activeIdByTrail: { ...s.activeIdByTrail, [trailId]: id },
      activePointsByTrail: { ...s.activePointsByTrail, [trailId]: points },
    }));
  },
}));

/** Reactive selector for a trail's active route id. */
export function selectActiveRouteId(trailId: string) {
  return (s: RoutesState): string | null => s.activeIdByTrail[trailId] ?? null;
}
