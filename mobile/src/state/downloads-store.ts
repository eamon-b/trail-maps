/**
 * Per-trail offline-tile download state.
 *
 * This store is the UI-facing view over the filesystem-backed tile manager.
 * The *source of truth* for whether a trail is downloaded is the tiles on disk
 * (`tileManager.getTrailStatus`), not this store — so `refreshStatus` / `hydrate`
 * re-derive `state` from disk, and every mutating action refreshes afterwards.
 * The store adds only the things disk can't tell us: whether a download is
 * currently running, its progress fraction, and the last error.
 *
 * Cancellation uses a mutable `{ cancelled }` signal that `downloadTrailTiles`
 * checks between files. Signals are mutable refs, so they live in a
 * module-level map rather than in reactive state.
 */

import { create } from 'zustand';
import { tileManager } from '../services/tile-manager';
import type { TileStatusState } from '../services/tile-service';

export interface TrailDownload {
  /** On-disk readiness, mirrored from the tile manager. */
  state: TileStatusState;
  /**
   * True while a download is actively running.
   *
   * Note this is independent of `state`: during an *update* the pack on disk
   * stays 'complete' while it is overwritten. Consumers that mount the tiles
   * (the guide map) must treat `downloading` as "these files are not safe to
   * hold open" — see resolveStyleSource in features/map/map-style.
   */
  downloading: boolean;
  /** 0..1 byte-level progress of the active download (0 when idle). */
  progress: number;
  /** Last error message, if the most recent attempt failed. */
  error?: string;
  /**
   * True when the server advertises a newer tile pack than the complete one on
   * disk. Only ever set for trails whose state is 'complete' — see
   * `checkForUpdates`.
   */
  updateAvailable?: boolean;
  /** Version string of the newer remote pack, when one was found. */
  remoteVersion?: string;
}

const IDLE: TrailDownload = { state: 'absent', downloading: false, progress: 0 };

export interface DownloadsState {
  byTrail: Record<string, TrailDownload>;

  /** Reactive read with an idle default. */
  get: (trailId: string) => TrailDownload;
  /** Re-read on-disk status for one trail. */
  refreshStatus: (trailId: string) => void;
  /** Re-read on-disk status for many trails (call on app start). */
  hydrate: (trailIds: string[]) => void;
  /**
   * Ask the server whether a newer tile pack exists for each given trail.
   * Only complete packs are checked, and failures are silent (see below).
   */
  checkForUpdates: (trailIds: string[], baseUrl: string) => Promise<void>;
  /** Begin downloading a trail's tiles from `baseUrl`. */
  startDownload: (trailId: string, baseUrl: string) => Promise<void>;
  /** Request cancellation of an in-flight download. */
  cancel: (trailId: string) => void;
  /** Delete a trail's tiles and refresh status. */
  deleteTiles: (trailId: string) => void;
}

/** Mutable cancellation signals, keyed by trail id (not reactive state). */
const signals = new Map<string, { cancelled: boolean }>();

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  const patch = (trailId: string, next: Partial<TrailDownload>) =>
    set((s) => ({
      byTrail: {
        ...s.byTrail,
        [trailId]: { ...(s.byTrail[trailId] ?? IDLE), ...next },
      },
    }));

  return {
    byTrail: {},

    get: (trailId) => get().byTrail[trailId] ?? IDLE,

    refreshStatus: (trailId) => {
      const status = tileManager.getTrailStatus(trailId);
      patch(trailId, { state: status.state });
    },

    hydrate: (trailIds) => {
      const entries: Record<string, TrailDownload> = {};
      for (const id of trailIds) {
        const status = tileManager.getTrailStatus(id);
        const prev = get().byTrail[id] ?? IDLE;
        entries[id] = { ...prev, state: status.state };
      }
      set((s) => ({ byTrail: { ...s.byTrail, ...entries } }));
    },

    checkForUpdates: async (trailIds, baseUrl) => {
      if (!baseUrl) return;

      await Promise.all(
        trailIds.map(async (trailId) => {
          // Disk is the source of truth for completeness, not the store.
          const status = tileManager.getTrailStatus(trailId);
          if (status.state !== 'complete' || get().byTrail[trailId]?.downloading) {
            // checkForTileUpdate reports updateAvailable for an incomplete pack
            // (there is nothing valid to compare against), which is not what
            // "Update available" means to a user: an absent or half-downloaded
            // pack needs a *download*, and the screen already says so.
            patch(trailId, { state: status.state, updateAvailable: false });
            return;
          }

          try {
            const result = await tileManager.checkForUpdate(trailId, baseUrl);
            patch(trailId, {
              state: status.state,
              updateAvailable: result.updateAvailable,
              remoteVersion: result.updateAvailable ? result.remoteVersion : undefined,
            });
          } catch {
            // Offline, DNS failure, 500 — "is there an update?" is a background
            // question the user never asked, so a failed answer shows nothing:
            // no badge, no error banner, and no clobbering of a previous
            // successful verdict.
          }
        }),
      );
    },

    startDownload: async (trailId, baseUrl) => {
      // Ignore if already running.
      if (get().byTrail[trailId]?.downloading) return;

      const signal = { cancelled: false };
      signals.set(trailId, signal);
      // `downloading` is load-bearing beyond the progress bar: an *update*
      // re-download replaces base.mbtiles / contours.mbtiles while on-disk
      // state stays 'complete', so a mounted offline map would keep the old
      // files open in MapLibre's native tile source across the swap.
      // resolveStyleSource treats `downloading` as "go online", which remounts
      // the map off those files before the first byte lands.
      patch(trailId, { downloading: true, progress: 0, error: undefined });
      // The files are about to change; stale validation verdicts must not
      // outlive them.
      tileManager.clearValidationCache(trailId);

      try {
        await tileManager.downloadTrail(trailId, baseUrl, {
          signal,
          onProgress: ({ bytesDownloaded, bytesTotal }) => {
            const progress = bytesTotal > 0 ? bytesDownloaded / bytesTotal : 0;
            patch(trailId, { progress });
          },
        });
        // Success — re-derive final state from disk. The cache is dropped
        // *before* the patch that flips `downloading` back off, so the map
        // returning to offline re-validates the files that just landed. (A
        // same-size re-download would otherwise hit the size-keyed cache.)
        const status = tileManager.getTrailStatus(trailId);
        tileManager.clearValidationCache(trailId);
        // Whatever the pack was behind, it isn't now — the badge is re-derived
        // by the next checkForUpdates.
        patch(trailId, {
          downloading: false,
          progress: 1,
          state: status.state,
          updateAvailable: false,
          remoteVersion: undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const cancelled = signal.cancelled;
        const status = tileManager.getTrailStatus(trailId);
        tileManager.clearValidationCache(trailId);
        patch(trailId, {
          downloading: false,
          progress: 0,
          state: status.state,
          error: cancelled ? undefined : message,
        });
      } finally {
        signals.delete(trailId);
      }
    },

    cancel: (trailId) => {
      const signal = signals.get(trailId);
      if (signal) signal.cancelled = true;
    },

    deleteTiles: (trailId) => {
      tileManager.deleteTrail(trailId);
      const status = tileManager.getTrailStatus(trailId);
      patch(trailId, {
        state: status.state,
        progress: 0,
        error: undefined,
        updateAvailable: false,
        remoteVersion: undefined,
      });
    },
  };
});
