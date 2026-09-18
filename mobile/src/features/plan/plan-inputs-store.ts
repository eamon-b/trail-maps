/**
 * Remembers the hiker's plan *preferences* per trail: daily hours, pace, and
 * the resupply stops they have chosen.
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
import { PACE_KMH, type Pace } from './plan-adapters';

/** Persisted, direction-independent plan preferences. */
export interface PlanPrefs {
  dailyHours: number;
  pace: Pace;
  /**
   * Waypoint ids of the resupply options the hiker ticked, in trail order.
   *
   * Absent means no plan has been made: the legs card falls back to every
   * option, and *nothing* is highlighted as planned. An explicit `[]` is a
   * plan with nothing in it, which is a different thing — so this field is
   * deliberately missing from DEFAULT_PREFS rather than defaulting to a list.
   */
  resupplyStops?: string[];
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
  /** Store an explicit resupply selection (see PlanPrefs.resupplyStops). */
  setResupplyStops: (trailId: string, ids: string[]) => void;
  /** Back to "no plan made" — distinct from ticking every option. */
  clearResupplyStops: (trailId: string) => void;
  /**
   * Forget a trail's prefs entirely. Called when an imported trail is deleted
   * (`services/imported-trail-store`) so the persisted blob doesn't accumulate
   * entries for trails that no longer exist. No-op for an unknown id.
   */
  clearTrail: (trailId: string) => void;
}

/** Persisted map shape (what `partialize` writes / `migrate` returns). */
type PersistedPlanInputs = Pick<PlanInputsState, 'byTrail'>;

/**
 * Migrate persisted state across schema versions. Anything absent, non-object,
 * or missing a well-formed `byTrail` collapses to an empty map — a sane default
 * that simply falls every trail back to DEFAULT_PREFS. Field-level back-fill of
 * an individual PlanPrefs (e.g. a field added in a future version) is handled in
 * `selectPrefs`, so this only has to guarantee the map's SHAPE, not per-entry
 * completeness. Exported so it can be unit-tested directly.
 */
export function migratePlanInputs(persisted: unknown, _version: number): PersistedPlanInputs {
  if (!persisted || typeof persisted !== 'object') return { byTrail: {} };
  const byTrail = (persisted as Partial<PlanInputsState>).byTrail;
  return { byTrail: byTrail && typeof byTrail === 'object' ? byTrail : {} };
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
      setResupplyStops: (trailId, ids) =>
        set((s) => ({
          byTrail: {
            ...s.byTrail,
            // A fresh array in a fresh entry, so the selectPrefs /
            // selectResupplyStopIds memos both miss and recompute.
            [trailId]: { ...(s.byTrail[trailId] ?? DEFAULT_PREFS), resupplyStops: [...ids] },
          },
        })),
      clearResupplyStops: (trailId) =>
        set((s) => {
          const stored = s.byTrail[trailId];
          if (!stored || stored.resupplyStops === undefined) return s;
          // Drop the field, keep pace/hours — this is "unplan", not "reset".
          const { resupplyStops: _dropped, ...rest } = stored;
          return { byTrail: { ...s.byTrail, [trailId]: rest } };
        }),
      clearTrail: (trailId) =>
        set((s) => {
          if (!(trailId in s.byTrail)) return s;
          // Omit the key rather than setting undefined — `partialize` writes
          // `byTrail` verbatim, and an undefined value would serialise away
          // anyway; dropping it keeps in-memory and persisted state identical.
          const next = { ...s.byTrail };
          delete next[trailId];
          return { byTrail: next };
        }),
    }),
    {
      name: 'tracknotes:plan-inputs',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ byTrail: s.byTrail }),
      version: 1,
      migrate: migratePlanInputs,
      // Accepted tradeoff: no hydration gate. On cold start the store renders
      // DEFAULT_PREFS for one frame before AsyncStorage rehydrates, so a
      // customised pace/hours can flash to defaults briefly. The plan is a live
      // recompute with no side effects, so the flash is harmless and not worth a
      // loading state.
    },
  ),
);

/** Clamp daily hours to the allowed range, rounded to whole hours. */
export function clampHours(hours: number): number {
  return Math.min(MAX_DAILY_HOURS, Math.max(MIN_DAILY_HOURS, Math.round(hours)));
}

/**
 * Merged-prefs cache keyed by the STORED entry's identity. selectPrefs must
 * return a stable reference for a given stored object: zustand compares selector
 * output with Object.is, so returning a fresh `{...DEFAULT_PREFS, ...stored}`
 * on every call would flap the reference and drive useStore into an infinite
 * re-render loop. A WeakMap keyed on the stored object gives one merged result
 * per stored identity; a `set*` action produces a new stored object (spread), so
 * updates correctly miss the cache and recompute.
 */
const mergedPrefsCache = new WeakMap<PlanPrefs, PlanPrefs>();

/**
 * Reactive selector for a trail's prefs. Merges the stored entry over
 * DEFAULT_PREFS field-by-field so a PlanPrefs field added in a future version is
 * never `undefined` for an entry persisted before it existed (migrate only
 * guarantees the map shape, not per-field completeness). Returns a stable
 * reference — see `mergedPrefsCache`.
 *
 * `resupplyStops` is the one field that needs scrubbing here rather than in
 * `migrate`: it is optional, so a hand-edited or corrupt blob would otherwise
 * reach the selection surfaces as garbage. Anything that is not an array of
 * strings collapses to `undefined` — "no plan made", the safe reading.
 */
export function selectPrefs(trailId: string) {
  return (s: PlanInputsState): PlanPrefs => {
    const stored = s.byTrail[trailId];
    if (!stored) return DEFAULT_PREFS;
    let merged = mergedPrefsCache.get(stored);
    if (!merged) {
      merged = { ...DEFAULT_PREFS, ...stored };
      if (merged.resupplyStops !== undefined && !isStringArray(merged.resupplyStops)) {
        delete merged.resupplyStops;
      }
      mergedPrefsCache.set(stored, merged);
    }
    return merged;
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Resupply-stop ids as a Set, keyed by the stored array's identity so zustand's
 * Object.is compare stays stable across renders — the same mechanism as
 * `mergedPrefsCache`.
 */
const stopIdSetCache = new WeakMap<string[], ReadonlySet<string>>();

/**
 * Reactive selector for the trail's chosen resupply stops: a Set of waypoint
 * ids, or `null` when no plan has been made.
 *
 * This is the one thing every "planned" surface reads — map, elevation profile,
 * list pane, waypoint detail and the hike distance strip — so "planned" means
 * the same on all of them. `null` means *nothing* is planned, never everything:
 * the untouched default still feeds the legs card with every option, but
 * painting every town as planned before anyone planned anything would be noise.
 */
export function selectResupplyStopIds(trailId: string) {
  return (s: PlanInputsState): ReadonlySet<string> | null => {
    const ids = selectPrefs(trailId)(s).resupplyStops;
    if (!ids) return null;
    let set = stopIdSetCache.get(ids);
    if (!set) {
      set = new Set(ids);
      stopIdSetCache.set(ids, set);
    }
    return set;
  };
}

/**
 * Reactive selector for a trail's Naismith base speed (km/h) — the pace preset
 * (Slow 3 / Average 4 / Fast 5) resolved to its walking speed. Used by the Hike
 * views' ETA readouts so planner and hike can never disagree about pace. Returns
 * a primitive number, so it is re-render-safe under zustand's Object.is compare.
 * A trail the hiker never gave a pace falls through DEFAULT_PREFS ('average') to
 * 4 km/h — identical to the pre-pace behaviour.
 */
export function selectPaceBaseKmh(trailId: string) {
  return (s: PlanInputsState): number => PACE_KMH[selectPrefs(trailId)(s).pace];
}
