/**
 * Connectivity-driven sync triggers.
 *
 * The offline-first client never polls; it reacts to two edges:
 *   - the network transitioning back to connected (expo-network), and
 *   - the app returning to the foreground (AppState).
 * On either edge — and once when the guide opens — it drains the outbox and
 * pulls the active trail's delta plus this user's day plans. `runSync` is
 * exported (and injectable) so the edge logic is testable without native
 * modules.
 *
 * A user-imported guide has no server side at all (see `services/server-trails`),
 * so {@link useCommentSync} wires nothing for one: no initial catch-up, no
 * network/foreground listeners, no request. Draining the outbox is skipped along
 * with the rest — its rows can only belong to bundled trails, and they drain on
 * the next bundled guide open / reconnect / foreground edge.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { isServerKnown } from '../services/server-trails';
import { drainOutbox, pullPlans, pullTrail, type DrainResult, type PullResult } from './comment-sync';

export interface RunSyncResult {
  drain: DrainResult;
  pull: PullResult | null;
  /** Null when the plan pull threw before producing an outcome. */
  plans: PullResult | null;
}

/** The sync steps, injectable so the single-flight rule is testable without a network. */
export interface RunSyncDeps {
  drain?: () => Promise<DrainResult>;
  pullTrail?: (trailId: string) => Promise<PullResult>;
  pullPlans?: () => Promise<PullResult>;
}

/** The sync in flight, and which trail it is for. */
let activeSync: { trailId: string | null; promise: Promise<RunSyncResult> } | null = null;

/**
 * Drain the outbox, pull the active trail (if any), then pull this user's day
 * plans.
 *
 * Plans ride the same trigger but are a SEPARATE channel — user-scoped, not
 * trail-scoped — so a failure there must not turn a successful comment pull
 * into an error. Same reasoning (and same swallowed try/catch) as the curated
 * descriptions inside `pullTrail`.
 *
 * Single-flight. Foregrounding a phone that was offline fires the AppState edge
 * and the reconnect edge together, and two overlapping syncs raced each other's
 * SQLite writes. A call for the trail already syncing joins that run; a call
 * for another trail (the guide changed) waits for it and then runs.
 */
export function runSync(trailId: string | null, deps: RunSyncDeps = {}): Promise<RunSyncResult> {
  if (activeSync && activeSync.trailId === trailId) return activeSync.promise;
  const previous = activeSync?.promise.catch(() => undefined) ?? Promise.resolve();
  const promise: Promise<RunSyncResult> = previous
    .then(() => runSyncNow(trailId, deps))
    .finally(() => {
      if (activeSync?.promise === promise) activeSync = null;
    });
  activeSync = { trailId, promise };
  return promise;
}

async function runSyncNow(trailId: string | null, deps: RunSyncDeps): Promise<RunSyncResult> {
  const drain = await (deps.drain ?? drainOutbox)();
  const pull = trailId ? await (deps.pullTrail ?? pullTrail)(trailId) : null;
  let plans: PullResult | null = null;
  try {
    plans = await (deps.pullPlans ?? pullPlans)();
  } catch {
    // Keep the comment sync's outcome; the plans mark is unchanged and the
    // next trigger retries.
  }
  return { drain, pull, plans };
}

/** Whether a network-state change represents a regain (disconnected → up). */
export function isReconnect(
  prev: { isConnected?: boolean | null },
  next: { isConnected?: boolean | null },
): boolean {
  return !prev.isConnected && !!next.isConnected;
}

/**
 * Wire connectivity + foreground sync for the lifetime of a mounted guide.
 * Runs an initial sync on mount and on every reconnect / foreground edge.
 *
 * Called unconditionally by every guide (rules of hooks); the server-boundary
 * gate is an early return *inside* the effect, so an imported guide subscribes
 * to nothing and issues no request.
 */
export function useCommentSync(trailId: string | null): void {
  useEffect(() => {
    // An imported guide exists only on this device — nothing to sync with.
    if (trailId !== null && !isServerKnown(trailId)) return;

    let lastConnected = true;
    let cancelled = false;

    const trigger = () => {
      if (!cancelled) void runSync(trailId);
    };

    // Initial catch-up when the guide opens.
    trigger();

    const netSub = Network.addNetworkStateListener((state) => {
      const connected = !!state.isConnected;
      if (isReconnect({ isConnected: lastConnected }, { isConnected: connected })) {
        trigger();
      }
      lastConnected = connected;
    });

    const appSub = AppState.addEventListener('change', (status) => {
      if (status === 'active') trigger();
    });

    return () => {
      cancelled = true;
      netSub.remove();
      appSub.remove();
    };
  }, [trailId]);
}
