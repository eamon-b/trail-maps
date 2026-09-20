/**
 * The hiker's plan for each trail, backed by the local `plans` table.
 *
 * Deliberately NOT an AsyncStorage-persisted zustand store like
 * `plan-inputs-store`: SQLite is the store. A plan is a synced document with a
 * tombstone, a source column and a last-writer-wins rule — state the outbox
 * drain reads and writes behind the UI's back — so a second persisted copy
 * would be a second truth to reconcile. This store is a live cache over the
 * repo, in the `favorites-store` idiom: hydrate on open, edit through `apply`,
 * every screen reads the same object.
 *
 * `apply` is the single write path. It takes an *editor* from
 * `@lib/plan-editor` rather than a new document, which buys three things:
 *
 * 1. Every platform edits the document through the same shared functions, so
 *    the phone cannot drift from the web on what a stop is or what the limits
 *    are.
 * 2. The editors return the SAME object when an edit changes nothing, which is
 *    exactly the "don't write" signal — no SQLite round trip and no re-render
 *    for a tap that toggled a stop on and straight back off.
 * 3. The plan is created lazily. There is no "new plan" button: the first edit
 *    on a trail with no plan mints one (`newPlan`), so an untouched guide never
 *    accumulates an empty document to sync.
 *
 * `apply` never rejects. It is called from `onPress` handlers as
 * `void applyEdit(...)`, and the editors throw for real (a 500-stop plan, a
 * document over 64 KB) — a rejected floating promise there is an unhandled
 * rejection that takes the screen down instead of the edit. Failures are
 * logged and leave the stored plan untouched.
 */

import { create } from 'zustand';
import {
  assertPlanDocumentWithinLimits,
  isStopSelected,
  newPlan,
  type StopKey,
} from '@lib/plan-editor';
import type { PlanDirection } from '@lib/plan-direction';
import type { PlanDocument } from '@lib/plan-types';
import { uuidv4 } from '../api/uuid';
import { getDatabase } from '../db/database';
import * as plansRepo from '../db/plans-repo';

/** What a lazily-minted plan is created with, when `apply` has to mint one. */
export interface PlanDefaults {
  /** Plan name, e.g. the trail's name. Trimmed and capped by the editor. */
  name?: string;
  /** The direction the hiker is viewing the guide in. Default 'NOBO'. */
  direction?: PlanDirection;
}

/**
 * Called after every successful local write, with the document that was stored.
 *
 * `sync/plan-sync` installs the real handler at app start: it queues a `plan`
 * outbox row for `PUT /v1/plans/:id` and debounces the drain, gated on
 * `services/server-trails.isServerKnown` so an imported trail's plan stays
 * local exactly as its comments do. Left unset here on purpose — the store must
 * work with no sync at all (that is what an imported guide, and any build
 * without an API base URL, gets).
 */
let onPlanChanged: ((doc: PlanDocument) => void) | undefined;

/** Install (or clear, with `undefined`) the post-write hook described above. */
export function setPlanChangedHandler(handler?: (doc: PlanDocument) => void): void {
  onPlanChanged = handler;
}

export interface PlansState {
  /** trailId → the trail's plan; absent until hydrated, undefined when there is none. */
  byTrail: Record<string, PlanDocument | undefined>;
  /** Read the trail's plan out of SQLite into the cache. */
  hydrate: (trailId: string) => Promise<void>;
  /**
   * Edit the trail's plan through a `@lib/plan-editor` function, persisting the
   * result. Mints a plan first when the trail has none.
   *
   * @returns the resulting document, or null when nothing was written
   *   (a no-op edit, or a failure — both leave the stored plan untouched).
   */
  apply: (
    trailId: string,
    edit: (plan: PlanDocument) => PlanDocument,
    defaults?: PlanDefaults,
  ) => Promise<PlanDocument | null>;
  /** Forget a trail's cached plan (it stays in SQLite unless the repo dropped it). */
  clear: (trailId: string) => void;
  /**
   * Forget every cached plan. Account deletion only: the rows are gone from
   * SQLite by then, so a cache left standing would show a deleted account's
   * plans until the app restarted.
   */
  clearAll: () => void;
}

export const usePlansStore = create<PlansState>((set, get) => ({
  byTrail: {},

  hydrate: async (trailId: string) => {
    const db = await getDatabase();
    const plan = await plansRepo.getByTrail(db, trailId);
    set((s) => ({ byTrail: { ...s.byTrail, [trailId]: plan ?? undefined } }));
  },

  apply: async (trailId, edit, defaults) => {
    try {
      const db = await getDatabase();
      // The cache may not have been hydrated yet (a waypoint detail screen can
      // be the first thing to touch a plan), and minting a second document for
      // a trail that already has one is the one mistake with a lasting cost —
      // the server would answer `plan_exists`. Read through on a miss.
      const cached = get().byTrail[trailId];
      const current = cached ?? (await plansRepo.getByTrail(db, trailId)) ?? undefined;
      const base =
        current ??
        newPlan(trailId, defaults?.name ?? '', defaults?.direction ?? 'NOBO', {
          idFactory: uuidv4,
        });

      const next = edit(base);
      // Unchanged: either a genuine no-op on a stored plan, or an edit that did
      // nothing to a plan we just minted — in which case there is nothing worth
      // persisting either. A read-through that found a plan the cache did not
      // have still lands in the cache.
      if (next === base) {
        if (current !== cached) {
          set((s) => ({ byTrail: { ...s.byTrail, [trailId]: current } }));
        }
        return current ?? null;
      }

      assertPlanDocumentWithinLimits(next);
      await plansRepo.upsertLocal(db, next);
      set((s) => ({ byTrail: { ...s.byTrail, [trailId]: next } }));
      onPlanChanged?.(next);
      return next;
    } catch (e) {
      console.warn(`plans-store: edit to ${trailId} was not applied`, e);
      return null;
    }
  },

  clear: (trailId: string) =>
    set((s) => {
      if (!(trailId in s.byTrail)) return s;
      const next = { ...s.byTrail };
      delete next[trailId];
      return { byTrail: next };
    }),

  clearAll: () => set((s) => (Object.keys(s.byTrail).length === 0 ? s : { byTrail: {} })),
}));

/** Reactive selector for a trail's plan (undefined when it has none). */
export function selectPlan(trailId: string) {
  return (s: PlansState): PlanDocument | undefined => s.byTrail[trailId];
}

/**
 * Reactive selector for "is this place a stop of the trail's plan?". Returns a
 * primitive, so it is re-render-safe under zustand's `Object.is` compare.
 *
 * @param key NOBO-absolute km plus the waypoint id when there is one — convert
 *   an active-direction km with `toNoboKm` first.
 */
export function selectIsStop(trailId: string, key: StopKey) {
  return (s: PlansState): boolean => {
    const plan = s.byTrail[trailId];
    return plan ? isStopSelected(plan, key) : false;
  };
}
