/**
 * Minimal, dependency-free change bus for comment sync.
 *
 * A background outbox drain or trail pull can mutate comment rows (e.g. flip a
 * row from `source='local'` to `source='server'`) while a waypoint detail feed
 * is already mounted. Without a signal, that screen keeps its stale rows until
 * the next focus. `comment-sync` emits here after any drain/pull that changed
 * rows; mounted feeds subscribe and re-query.
 *
 * A module-level listener set (no EventEmitter dependency): register with
 * `onSyncChange`, tear down with the returned unsubscribe, fire with
 * `emitSyncChange`.
 */

/** What changed in a sync pass. Fields are best-effort; a subscriber may simply
 * re-query on any event (feeds are small). */
export interface SyncChange {
  /** Trail whose comment rows changed, when known. */
  trailId?: string;
  /** Waypoints whose feeds changed, when known. */
  waypointIds?: string[];
}

type SyncListener = (change: SyncChange) => void;

const listeners = new Set<SyncListener>();

/** Subscribe to sync-change events. Returns an unsubscribe function. */
export function onSyncChange(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify all subscribers that sync changed rows. */
export function emitSyncChange(change: SyncChange = {}): void {
  // Iterate a snapshot so a listener that unsubscribes during dispatch (or a
  // newly added one) can't perturb the in-flight iteration.
  for (const listener of [...listeners]) listener(change);
}
