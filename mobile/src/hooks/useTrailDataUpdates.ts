/**
 * Keep over-the-air trail data current: check the R2 catalog when the app
 * starts and whenever it returns to the foreground — and the community routes
 * list (`services/community-routes`) alongside it.
 *
 * `checkForTrailDataUpdates` throttles itself (once per six hours, five minutes
 * after a failure) and is single-flight, so this hook can fire on every
 * foreground without a request each time. Mounted once, in the root layout —
 * the only component alive for the whole session.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { checkForTrailDataUpdates, initTrailData } from '../services/trail-data-updates';
import { initCommunityRoutes, refreshCommunityRoutes } from '../services/community-routes';

export function useTrailDataUpdates(): void {
  useEffect(() => {
    // Synchronous and cheap: reads the small state file and registers any
    // catalog-only trail ids with the server gate before sync can ask.
    initTrailData();
    initCommunityRoutes();
    void checkForTrailDataUpdates();
    // The community list rides the same cadence (its own, shorter throttle).
    void refreshCommunityRoutes();

    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void checkForTrailDataUpdates();
        void refreshCommunityRoutes();
      }
    });
    return () => sub.remove();
  }, []);
}
