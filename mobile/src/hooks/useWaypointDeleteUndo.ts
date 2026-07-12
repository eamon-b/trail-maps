/**
 * Delete-with-undo lifecycle for a custom waypoint, shared by the trail map
 * viewer and the "My data" screen (both delete the DB row immediately and hold
 * it in memory for a 5 s undo window).
 *
 * The waypoint's photo file is NOT deleted when the row is deleted — undo must
 * be able to bring it back. Instead the file deletion is deferred until the
 * undo window truly closes. This hook centralises the fiddly parts that were
 * previously duplicated (and buggy) in both screens:
 *
 *  - Displacement: a second delete while a toast is still pending replaces the
 *    held row. The displaced row will never be undone, so its photo file is
 *    cleaned up right then (previously it leaked).
 *  - Unmount: navigating away with a pending toast clears the toast's timer, so
 *    its expiry callback never fires. The cleanup path deletes the held photo
 *    on unmount so it can't orphan.
 *  - Undo-vs-expiry race: the toast's 5 s timer can fire in the gap between the
 *    Undo tap and its (async) handler. A shared, synchronously-grabbed token
 *    makes the two mutually exclusive — whichever runs first wins; the loser is
 *    a no-op. So the photo is never deleted out from under a successful undo,
 *    and a late undo can't restore a row whose photo file is already gone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteWaypointPhoto } from '../services/waypoint-photo-service';

/** The held row only needs a photo URI; callers pass their own richer shape. */
type WithPhoto = { photoUri?: string | null };

export interface WaypointDeleteUndo<T extends WithPhoto> {
  /** The row currently held for undo (null = no toast). */
  deleted: T | null;
  /**
   * Register a just-deleted row for undo. Displaces (and cleans up the photo
   * of) any row still pending from a prior delete.
   */
  registerDeleted: (row: T) => void;
  /** Undo handler: restores the held row. Mutually exclusive with expiry. */
  undo: () => Promise<void>;
  /** Expiry/dismiss handler: deletes the held photo. Mutually exclusive with undo. */
  expire: () => void;
}

export function useWaypointDeleteUndo<T extends WithPhoto>(
  onRestore: (row: T) => Promise<void> | void,
): WaypointDeleteUndo<T> {
  const [deleted, setDeleted] = useState<T | null>(null);
  // The pending row, mirrored in a ref so the unmount cleanup and the
  // synchronous race guard can read it without stale closures.
  const pendingRef = useRef<T | null>(null);
  // Grabbed synchronously by whichever of undo/expiry fires first for the
  // current pending row; the other becomes a no-op.
  const settledRef = useRef(false);

  const registerDeleted = useCallback((row: T) => {
    const prev = pendingRef.current;
    // A prior row that never settled will never be undone now — clean up its
    // photo so a rapid second delete can't orphan the first's file.
    if (prev && !settledRef.current) {
      deleteWaypointPhoto(prev.photoUri);
    }
    settledRef.current = false;
    pendingRef.current = row;
    setDeleted(row);
  }, []);

  const undo = useCallback(async () => {
    if (settledRef.current) return; // expiry already won the race — no-op
    settledRef.current = true;
    const row = pendingRef.current;
    pendingRef.current = null;
    setDeleted(null);
    if (!row) return;
    await onRestore(row); // photo file was never deleted, so it comes back too
  }, [onRestore]);

  const expire = useCallback(() => {
    if (settledRef.current) return; // undo already won the race — no-op
    settledRef.current = true;
    const row = pendingRef.current;
    pendingRef.current = null;
    setDeleted(null);
    deleteWaypointPhoto(row?.photoUri);
  }, []);

  // Unmount: the toast's timer is cleared on unmount, so `expire` won't fire.
  // Delete the still-pending photo here so it doesn't orphan.
  useEffect(() => {
    return () => {
      if (!settledRef.current && pendingRef.current) {
        deleteWaypointPhoto(pendingRef.current.photoUri);
      }
    };
  }, []);

  return { deleted, registerDeleted, undo, expire };
}
