import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface FocusedWaypointContextValue {
  /** ID of the currently focused waypoint, null if none */
  focusedWaypointId: string | number | null;
  /** Set the focused waypoint — updates all views (map, list, day plan) */
  setFocusedWaypointId: (id: string | number | null) => void;
}

const FocusedWaypointContext = createContext<FocusedWaypointContextValue | null>(null);

/**
 * Provider for cross-view waypoint focus synchronization.
 * Selecting a waypoint in any view (map, list, dashboard) updates all other views.
 */
export function FocusedWaypointProvider({ children }: { children: React.ReactNode }) {
  const [focusedWaypointId, setFocusedWaypointIdState] = useState<string | number | null>(null);

  const setFocusedWaypointId = useCallback((id: string | number | null) => {
    setFocusedWaypointIdState(id);
  }, []);

  const value = useMemo(
    () => ({ focusedWaypointId, setFocusedWaypointId }),
    [focusedWaypointId, setFocusedWaypointId],
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
