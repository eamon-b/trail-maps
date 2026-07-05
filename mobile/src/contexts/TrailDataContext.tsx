import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { TrailDataService, type Trail as DbTrail } from '../services/trail-data-service';
import { loadCachedCustomTrailClimate } from '../services/custom-climate-service';
import { trailJsonToTrail, type Trail } from '../lib/trail-utils';

interface TrailDataState {
  /** The parsed trail object, ready for display */
  trail: Trail | null;
  /** The DB row (for metadata like isCustom, dataVersion) */
  dbTrail: DbTrail | null;
  /** Whether trail data is currently loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Load trail data for the given ID. No-op if already loaded for this ID. */
  loadTrail: (id: string) => Promise<void>;
  /** Force reload trail data (e.g. after editing custom trail name) */
  reloadTrail: () => Promise<void>;
  /**
   * Re-merge custom waypoints into the already-loaded trail (after add/edit/
   * delete). Unlike reloadTrail this never touches `loading`, so consumers
   * (e.g. the map) are not unmounted and the camera keeps its position.
   */
  refreshCustomWaypoints: () => Promise<void>;
}

const TrailDataContext = createContext<TrailDataState | null>(null);

export function TrailDataProvider({ children }: { children: React.ReactNode }) {
  const [trail, setTrail] = useState<Trail | null>(null);
  const [dbTrail, setDbTrail] = useState<DbTrail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const trailRef = useRef<Trail | null>(null);
  // Parsed trail BEFORE custom waypoints were merged in, so
  // refreshCustomWaypoints can re-merge against a clean base.
  const baseTrailRef = useRef<Trail | null>(null);

  const loadTrail = useCallback(async (id: string) => {
    // Already loaded for this ID
    if (loadedIdRef.current === id && trailRef.current) return;

    loadedIdRef.current = id;
    setLoading(true);
    setError(null);

    try {
      const service = await TrailDataService.create();
      const json = await service.getTrailTrackData(id);
      if (!json) {
        trailRef.current = null;
        baseTrailRef.current = null;
        setTrail(null);
        setDbTrail(null);
        setError('Trail not found');
        setLoading(false);
        return;
      }

      // Keep the pre-merge base so refreshCustomWaypoints can re-merge
      // without re-parsing the trail. The merge itself lives in the service
      // (getMergedTrail / mergeTrailCustomWaypoints) so every consumer —
      // map, datasheet, water-carry, elevation, measure — shares one path.
      const base = trailJsonToTrail(json);
      baseTrailRef.current = base;
      const parsed = await service.mergeTrailCustomWaypoints(id, base);

      trailRef.current = parsed;
      setTrail(parsed);

      const dbRow = await service.getTrail(id);
      setDbTrail(dbRow);

      // Custom trails: register any previously fetched climate data from the
      // SQLite cache (no network). Bundled trails register theirs at startup.
      if (dbRow?.isCustom) {
        try {
          await loadCachedCustomTrailClimate(id);
        } catch (e) {
          console.warn('Failed to load cached climate data:', e);
        }
      }

      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trail');
      setLoading(false);
    }
  }, []);

  const reloadTrail = useCallback(async () => {
    const id = loadedIdRef.current;
    if (!id) return;

    // Force reload by clearing cached state
    loadedIdRef.current = null;
    trailRef.current = null;
    baseTrailRef.current = null;
    await loadTrail(id);
  }, [loadTrail]);

  const refreshCustomWaypoints = useCallback(async () => {
    const id = loadedIdRef.current;
    const base = baseTrailRef.current;
    if (!id || !base) return;

    try {
      const service = await TrailDataService.create();
      const merged = await service.mergeTrailCustomWaypoints(id, base);
      trailRef.current = merged;
      setTrail(merged);
    } catch (e) {
      console.warn('Failed to refresh custom waypoints:', e);
    }
  }, []);

  const contextValue = useMemo(
    () => ({ trail, dbTrail, loading, error, loadTrail, reloadTrail, refreshCustomWaypoints }),
    [trail, dbTrail, loading, error, loadTrail, reloadTrail, refreshCustomWaypoints],
  );

  return (
    <TrailDataContext.Provider value={contextValue}>
      {children}
    </TrailDataContext.Provider>
  );
}

export function useTrailData(): TrailDataState {
  const ctx = useContext(TrailDataContext);
  if (!ctx) {
    throw new Error('useTrailData must be used within a TrailDataProvider');
  }
  return ctx;
}
