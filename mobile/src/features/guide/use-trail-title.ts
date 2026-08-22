/**
 * The header title for a guide screen, for either trail source.
 *
 * A bundled trail's name is in the bundled index and resolves synchronously —
 * the header must not flash a placeholder for the six shipped trails. An
 * imported trail's name lives in the `imported_trails` registry, which is a
 * SQLite read, so it arrives a tick later and the fallback shows until then.
 *
 * Shared by the guide navigator's header and the offline-maps screen so the two
 * can never disagree about what a guide is called.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  getTrailIndexEntry,
  getTrailIndexEntryAsync,
  type TrailIndexEntry,
} from '../../services/trail-loader';

/**
 * @param trailId route param — bundled or imported.
 * @param fallback shown while an imported name resolves, and for unknown ids.
 */
export function useTrailTitle(trailId: string, fallback = 'Guide'): string {
  const bundled = useMemo(() => getTrailIndexEntry(trailId), [trailId]);
  // Tagged with the id it belongs to, so a lookup still in flight when the
  // route param changes can't paint the previous guide's name.
  const [resolved, setResolved] = useState<{ id: string; entry: TrailIndexEntry | null } | null>(
    null,
  );

  useEffect(() => {
    if (bundled) return;
    let cancelled = false;
    getTrailIndexEntryAsync(trailId)
      .then((entry) => {
        if (!cancelled) setResolved({ id: trailId, entry });
      })
      .catch(() => {
        if (!cancelled) setResolved({ id: trailId, entry: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bundled, trailId]);

  const entry = bundled ?? (resolved?.id === trailId ? resolved.entry : null);
  return entry?.shortName || entry?.name || fallback;
}
