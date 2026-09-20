/**
 * The bridge from "the hiker edited their plan" to "the plan is on the server".
 *
 * `state/plans-store` deliberately knows nothing about the network: it writes
 * SQLite and calls one hook. This module is that hook, installed once at app
 * start (`app/_layout.tsx`), and it makes two decisions the store must not:
 *
 * 1. **Whether the plan has a server side at all.** An imported guide (`u_…`)
 *    exists on this device and nowhere else, exactly as its comments do, so its
 *    plan is written to SQLite and never queued. The gate is checked here
 *    rather than inside `submitPlan`, which throws for one — an import reaching
 *    the queue is a bug worth a stack trace, while an import reaching *this*
 *    function is simply the normal case for that guide.
 *
 * 2. **How often to hit the network.** Every tap on a stop is an edit, and a
 *    hiker building a plan taps a lot. The outbox row is written IMMEDIATELY
 *    (durability: an app killed mid-planning still sends the plan on the next
 *    launch) and supersedes the previous queued row for that plan, while the
 *    drain is debounced — so a burst of twenty toggles is twenty SQLite writes
 *    and one PUT, which is what keeps a plan inside the server's daily write
 *    budget.
 */

import { isServerKnown } from '../services/server-trails';
import { setPlanChangedHandler } from '../state/plans-store';
import type { PlanDocument } from '@lib/plan-types';
import { drainOutbox, enqueuePlan } from './comment-sync';

/**
 * How long the drain waits for the next edit before going out.
 *
 * Long enough to swallow a run of taps, short enough that a hiker who edits and
 * immediately locks the phone still sees the write leave (the app keeps running
 * for the moment it takes).
 */
export const PLAN_DRAIN_DEBOUNCE_MS = 1500;

/** Seams for the tests; production uses the real outbox and a real timer. */
export interface PlanSyncDeps {
  enqueue?: (trailId: string, doc: PlanDocument) => Promise<void>;
  drain?: () => Promise<unknown>;
  isServerTrail?: (trailId: string) => boolean;
  debounceMs?: number;
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDrain(deps: PlanSyncDeps): void {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void (deps.drain ?? drainOutbox)().catch(() => {
      // The row stays queued; the next edge (reconnect, foreground, guide open)
      // drains it. Nothing here is worth interrupting the hiker for.
    });
  }, deps.debounceMs ?? PLAN_DRAIN_DEBOUNCE_MS);
}

/**
 * Handle one stored plan document: queue it, then schedule a drain.
 *
 * Never rejects — it is called from the store's write path, which is itself
 * called from `onPress` handlers as a floating promise.
 */
export function handlePlanChanged(doc: PlanDocument, deps: PlanSyncDeps = {}): void {
  const known = deps.isServerTrail ?? isServerKnown;
  if (!known(doc.trailId)) return;

  void (deps.enqueue ?? enqueuePlan)(doc.trailId, doc)
    .then(() => scheduleDrain(deps))
    .catch((err: unknown) => {
      console.warn(`plan-sync: could not queue the plan for ${doc.trailId}`, err);
    });
}

/** Install the handler. Idempotent: a second call simply replaces the first. */
export function registerPlanSync(deps: PlanSyncDeps = {}): void {
  setPlanChangedHandler((doc) => handlePlanChanged(doc, deps));
}

/** Remove the handler and cancel any pending drain (tests, and app teardown). */
export function unregisterPlanSync(): void {
  setPlanChangedHandler(undefined);
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}
