import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface PendingPan {
  latitude: number;
  longitude: number;
  waypointId: string;
}

interface FocusedWaypointContextValue {
  /** Stable id of the currently focused waypoint, null if none */
  focusedWaypointId: string | null;
  /** Set the focused waypoint — updates all views (map, list, day plan) */
  setFocusedWaypointId: (id: string | null) => void;
  /** One-shot pan target from external navigation (e.g. datasheet → map) */
  pendingPan: PendingPan | null;
  /** Set a pending pan target for the map to consume */
  setPendingPan: (target: PendingPan | null) => void;
}

const FocusedWaypointContext = createContext<FocusedWaypointContextValue | null>(null);

/**
 * Provider for cross-view waypoint focus synchronization.
 * Selecting a waypoint in any view (map, list, dashboard) updates all other views.
 */
export function FocusedWaypointProvider({ children }: { children: React.ReactNode }) {
  const [focusedWaypointId, setFocusedWaypointIdState] = useState<string | null>(null);
  const [pendingPan, setPendingPanState] = useState<PendingPan | null>(null);

  const setFocusedWaypointId = useCallback((id: string | null) => {
    setFocusedWaypointIdState(id);
  }, []);

  const setPendingPan = useCallback((target: PendingPan | null) => {
    setPendingPanState(target);
  }, []);

  const value = useMemo(
    () => ({ focusedWaypointId, setFocusedWaypointId, pendingPan, setPendingPan }),
    [focusedWaypointId, setFocusedWaypointId, pendingPan, setPendingPan],
  );

  return (
    <FocusedWaypointContext.Provider value={value}>
      {children}
    </FocusedWaypointContext.Provider>
  );
}

export function useFocusedWaypoint(): FocusedWaypointContextValue {
  const ctx = useContext(FocusedWaypointContext);
  if (!ctx) throw new Error('useFocusedWaypoint must be used within a FocusedWaypointProvider');
  return ctx;
}
