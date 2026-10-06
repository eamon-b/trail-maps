/**
 * UI-facing status of over-the-air trail data (`services/trail-data-updates`).
 *
 * The truth is on disk — the downloaded files and their state file — and the
 * service owns it. This store only tells React that something changed:
 * `revision` bumps whenever the catalog or a downloaded copy changes, so the
 * guide list re-reads names, lengths and catalog-only trails, and `checking` /
 * `downloading` drive spinners.
 */

import { create } from 'zustand';

export interface TrailDataStatus {
  /** Bumped on every change to the catalog or the downloaded copies. */
  revision: number;
  /** A catalog check is in flight. */
  checking: boolean;
  /** Trail ids with a download in flight. */
  downloading: Record<string, boolean>;
  bump: () => void;
  setChecking: (checking: boolean) => void;
  setDownloading: (trailId: string, downloading: boolean) => void;
}

export const useTrailDataStore = create<TrailDataStatus>((set) => ({
  revision: 0,
  checking: false,
  downloading: {},
  bump: () => set((s) => ({ revision: s.revision + 1 })),
  setChecking: (checking) => set({ checking }),
  setDownloading: (trailId, downloading) =>
    set((s) => {
      const next = { ...s.downloading };
      if (downloading) next[trailId] = true;
      else delete next[trailId];
      return { downloading: next };
    }),
}));
