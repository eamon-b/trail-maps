/**
 * Remembers the hiker's plan *preferences* per trail: daily hours + pace.
 *
 * Deliberately does NOT persist the section start/end km. Those live in
 * direction-applied km space, which flips meaning when the guide direction is
 * reversed — persisting them would silently mis-restore a section after a flip.
 * The section is therefore local component state that defaults to the full
 * trail on every open (and recomputes correctly on a direction flip). Pace +
 * hours are direction-independent, so they persist safely.
 *
 * Same zustand + AsyncStorage idiom as the settings store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Pace } from './plan-adapters';

/** Persisted, direction-independent plan preferences. */
export interface PlanPrefs {
  dailyHours: number;
  pace: Pace;
}

export const DEFAULT_PREFS: PlanPrefs = { dailyHours: 8, pace: 'average' };

/** Daily-hours bounds for the stepper. */
export const MIN_DAILY_HOURS = 3;
export const MAX_DAILY_HOURS = 16;

export interface PlanInputsState {
  /** Per-trail preferences; absent entry means DEFAULT_PREFS. */
  byTrail: Record<string, PlanPrefs>;
  setDailyHours: (trailId: string, hours: number) => void;
  setPace: (trailId: string, pace: Pace) => void;
}

export const usePlanInputsStore = create<PlanInputsState>()(
  persist(
    (set) => ({
      byTrail: {},
      setDailyHours: (trailId, hours) =>
        set((s) => ({
          byTrail: {
            ...s.byTrail,
            [trailId]: {
              ...(s.byTrail[trailId] ?? DEFAULT_PREFS),
              dailyHours: clampHours(hours),
            },
          },
        })),
      setPace: (trailId, pace) =>
        set((s) => ({
          byTrail: {
            ...s.byTrail,
            [trailId]: { ...(s.byTrail[trailId] ?? DEFAULT_PREFS), pace },
          },
        })),
    }),
    {
      name: 'tracknotes:plan-inputs',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ byTrail: s.byTrail }),
    },
  ),
);

/** Clamp daily hours to the allowed range, rounded to whole hours. */
export function clampHours(hours: number): number {
  return Math.min(MAX_DAILY_HOURS, Math.max(MIN_DAILY_HOURS, Math.round(hours)));
}

/** Reactive selector for a trail's prefs (falls back to defaults). */
export function selectPrefs(trailId: string) {
  return (s: PlanInputsState): PlanPrefs => s.byTrail[trailId] ?? DEFAULT_PREFS;
}
