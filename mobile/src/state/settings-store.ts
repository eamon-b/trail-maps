/**
 * App-wide user settings, persisted across launches.
 *
 * Two things live here in Phase 1:
 *  - `units` — km vs mi, the global distance-display preference.
 *  - `perTrailDirection` — the chosen hiking direction for each guide
 *    ('default' | 'reversed'), keyed by trail id. FarOut lets you flip a
 *    guide's direction; the guide shell re-applies this via
 *    `createReversedTrail` whenever it changes.
 *
 * Persistence uses zustand's `persist` middleware backed by AsyncStorage.
 * Only the two data fields are persisted (see `partialize`); action functions
 * are re-created on each launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Units = 'km' | 'mi';
export type Direction = 'default' | 'reversed';

export interface SettingsState {
  units: Units;
  /** Chosen direction per trail id; absent entry means 'default'. */
  perTrailDirection: Record<string, Direction>;

  setUnits: (units: Units) => void;
  setDirection: (trailId: string, direction: Direction) => void;
  toggleDirection: (trailId: string) => void;
  /** Imperative read (non-reactive). Components should select the field. */
  getDirection: (trailId: string) => Direction;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      units: 'km',
      perTrailDirection: {},

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

      getDirection: (trailId) => get().perTrailDirection[trailId] ?? 'default',
    }),
    {
      name: 'tracknotes:settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ units: s.units, perTrailDirection: s.perTrailDirection }),
    },
  ),
);

/** Reactive selector helper for a single trail's direction. */
export function selectDirection(trailId: string) {
  return (s: SettingsState): Direction => s.perTrailDirection[trailId] ?? 'default';
}
