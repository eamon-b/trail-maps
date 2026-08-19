/**
 * `useWaterStatus` — the aggregated water verdict for every water waypoint on a
 * trail, keyed by waypoint id.
 *
 * The list pane and the map pane each call this; the read is one small
 * trail-scoped query plus a pure ranking pass, so a per-pane subscription is
 * cheaper than threading the map through the guide shell.
 *
 * Refresh points: mount (per trail), and any comment-sync change for this trail
 * (an outbox drain or delta pull, via `onSyncChange`). A report filed while
 * offline lands in the cache immediately but only moves these chips once its
 * drain succeeds or the panes remount — the same staleness window the waypoint
 * detail feed accepts.
 *
 * A database that is missing or not yet migrated yields an empty map rather than
 * an error: the chip is an enhancement, never a blocker for the datasheet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDatabase } from '../../db/database';
import { listWaterReportsByTrail } from '../../db/water-status-repo';
import { onSyncChange } from '../../sync/sync-events';
import {
  buildWaterStatusMap,
  waterWindowStartIso,
  type WaterAggregate,
} from './water-aggregate';

const EMPTY: ReadonlyMap<string, WaterAggregate> = new Map();

/** Aggregated water status per waypoint id (empty until the first read lands). */
export function useWaterStatus(trailId: string): ReadonlyMap<string, WaterAggregate> {
  const [byWaypoint, setByWaypoint] = useState<ReadonlyMap<string, WaterAggregate>>(EMPTY);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const db = await getDatabase();
      const now = Date.now();
      const rows = await listWaterReportsByTrail(db, trailId, waterWindowStartIso(now));
      if (!aliveRef.current) return;
      setByWaypoint(buildWaterStatusMap(rows, now));
    } catch (error) {
      // Never surface a chip-sized failure to the pane; log once and stay empty.
      console.warn('Water status unavailable', error);
      if (aliveRef.current) setByWaypoint(EMPTY);
    }
  }, [trailId]);

  useEffect(() => {
    setByWaypoint(EMPTY);
    void load();
  }, [load]);

  useEffect(
    () =>
      onSyncChange((change) => {
        if (change.trailId == null || change.trailId === trailId) void load();
      }),
    [load, trailId],
  );

  return byWaypoint;
}
