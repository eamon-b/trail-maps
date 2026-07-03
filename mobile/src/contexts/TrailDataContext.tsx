import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { TrailDataService, type Trail as DbTrail } from '../services/trail-data-service';
import { loadCachedCustomTrailClimate } from '../services/custom-climate-service';
import { trailJsonToTrail, mergeCustomWaypoints, type Trail } from '../lib/trail-utils';

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
}

const TrailDataContext = createContext<TrailDataState | null>(null);

export function TrailDataProvider({ children }: { children: React.ReactNode }) {
  const [trail, setTrail] = useState<Trail | null>(null);
  const [dbTrail, setDbTrail] = useState<DbTrail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const trailRef = useRef<Trail | null>(null);

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
        setTrail(null);
        setDbTrail(null);
        setError('Trail not found');
        setLoading(false);
        return;
      }

      let parsed = trailJsonToTrail(json);

      // Merge user-created waypoints at the load boundary so every consumer
      // (map, datasheet, water-carry, elevation, measure) sees them. Failure
      // here must never block the trail itself from loading.
      try {
        const customRows = await service.getCustomWaypoints(id);
        if (customRows.length > 0) {
          parsed = mergeCustomWaypoints(parsed, customRows);
        }
      } catch (e) {
        console.warn('Failed to load custom waypoints:', e);
      }

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
    await loadTrail(id);
  }, [loadTrail]);

  const contextValue = useMemo(
    () => ({ trail, dbTrail, loading, error, loadTrail, reloadTrail }),
    [trail, dbTrail, loading, error, loadTrail, reloadTrail],
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
