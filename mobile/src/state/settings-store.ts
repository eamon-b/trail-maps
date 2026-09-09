/**
 * App-wide user settings, persisted across launches.
 *
 * What lives here:
 *  - `units` — km vs mi, the global distance-display preference.
 *  - `perTrailDirection` — the chosen hiking direction for each guide
 *    ('default' | 'reversed'), keyed by trail id. FarOut lets you flip a
 *    guide's direction; the guide shell re-applies this via
 *    `createReversedTrail` whenever it changes.
 *  - `poiFilter` — which OpenStreetMap points of interest to draw. One global
 *    state, not per trail: it is the phone's twin of the web page's
 *    `localStorage` filter, and a walker who has turned transport POIs off
 *    means it everywhere.
 *
 * Persistence uses zustand's `persist` middleware backed by AsyncStorage.
 * Only the data fields are persisted (see `partialize`); action functions are
 * re-created on each launch.
 */

import {
  defaultPoiFilterState,
  normalisePoiFilterState,
  type PoiFilterState,
} from '@lib/poi-display';
import type { TrailPOICategory } from '@lib/trail-types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Units = 'km' | 'mi';
export type Direction = 'default' | 'reversed';

export interface SettingsState {
  units: Units;
  /** Chosen direction per trail id; absent entry means 'default'. */
  perTrailDirection: Record<string, Direction>;
  /** Master switch + per-category switches for OSM points of interest. */
  poiFilter: PoiFilterState;

  setUnits: (units: Units) => void;
  setDirection: (trailId: string, direction: Direction) => void;
  toggleDirection: (trailId: string) => void;
  setPoiEnabled: (enabled: boolean) => void;
  setPoiCategory: (category: TrailPOICategory, visible: boolean) => void;
  /** Imperative read (non-reactive). Components should select the field. */
  getDirection: (trailId: string) => Direction;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      units: 'km',
      perTrailDirection: {},
      poiFilter: defaultPoiFilterState(),

      setUnits: (units) => set({ units }),

      setDirection: (trailId, direction) =>
        set((s) => ({
          perTrailDirection: { ...s.perTrailDirection, [trailId]: direction },
        })),

      toggleDirection: (trailId) =>
        set((s) => {
          const current = s.perTrailDirection[trailId] ?? 'default';
          return {
            perTrailDirection: {
              ...s.perTrailDirection,
              [trailId]: current === 'default' ? 'reversed' : 'default',
            },
          };
        }),

      setPoiEnabled: (enabled) =>
        set((s) => ({ poiFilter: { ...s.poiFilter, enabled } })),

      setPoiCategory: (category, visible) =>
        set((s) => ({
          poiFilter: {
            ...s.poiFilter,
            categories: { ...s.poiFilter.categories, [category]: visible },
          },
        })),

      getDirection: (trailId) => get().perTrailDirection[trailId] ?? 'default',
    }),
    {
      name: 'tracknotes:settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        units: s.units,
        perTrailDirection: s.perTrailDirection,
        poiFilter: s.poiFilter,
      }),
      // A blob written by an older build knows nothing about categories added
      // since, and a corrupted one knows nothing at all; normalising on the way
      // in means neither can leave the store without a usable filter.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...saved,
          poiFilter: normalisePoiFilterState(saved.poiFilter),
        };
      },
    },
  ),
);

/** Reactive selector for the POI filter, the one state every POI surface reads. */
export function selectPoiFilter(s: SettingsState): PoiFilterState {
  return s.poiFilter;
}

/** Reactive selector helper for a single trail's direction. */
export function selectDirection(trailId: string) {
  return (s: SettingsState): Direction => s.perTrailDirection[trailId] ?? 'default';
}
