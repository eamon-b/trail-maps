/**
 * Keep over-the-air trail data current: check the R2 catalog when the app
 * starts and whenever it returns to the foreground.
 *
 * `checkForTrailDataUpdates` throttles itself (once per six hours, five minutes
 * after a failure) and is single-flight, so this hook can fire on every
 * foreground without a request each time. Mounted once, in the root layout —
 * the only component alive for the whole session.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { checkForTrailDataUpdates, initTrailData } from '../services/trail-data-updates';

export function useTrailDataUpdates(): void {
  useEffect(() => {
    // Synchronous and cheap: reads the small state file and registers any
    // catalog-only trail ids with the server gate before sync can ask.
    initTrailData();
    void checkForTrailDataUpdates();

    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') void checkForTrailDataUpdates();
    });
    return () => sub.remove();
  }, []);
}
