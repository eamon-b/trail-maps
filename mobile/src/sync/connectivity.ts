/**
 * Connectivity-driven sync triggers.
 *
 * The offline-first client never polls; it reacts to two edges:
 *   - the network transitioning back to connected (expo-network), and
 *   - the app returning to the foreground (AppState).
 * On either edge — and once when the guide opens — it drains the outbox and
 * pulls the active trail's delta. `runSync` is exported (and injectable) so the
 * edge logic is testable without native modules.
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
import { drainOutbox, pullTrail, type DrainResult, type PullResult } from './comment-sync';

export interface RunSyncResult {
  drain: DrainResult;
  pull: PullResult | null;
}

/** Drain the outbox, then pull the active trail (if any). */
export async function runSync(trailId: string | null): Promise<RunSyncResult> {
  const drain = await drainOutbox();
  const pull = trailId ? await pullTrail(trailId) : null;
  return { drain, pull };
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
