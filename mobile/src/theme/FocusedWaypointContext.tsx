import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface PendingPan {
  latitude: number;
  longitude: number;
  waypointId: string;
}

interface FocusedWaypointContextValue {
  /** One-shot pan target from external navigation (e.g. datasheet → map) */
  pendingPan: PendingPan | null;
  /** Set a pending pan target for the map to consume */
  setPendingPan: (target: PendingPan | null) => void;
}

const FocusedWaypointContext = createContext<FocusedWaypointContextValue | null>(null);

/**
 * Provider for cross-screen waypoint navigation. Currently only carries a
 * pending pan payload so the datasheet can request the map screen to pan
 * to a waypoint after navigation. Per-screen focus state lives locally —
 * only add to this context when a second screen actually needs to read it.
 */
export function FocusedWaypointProvider({ children }: { children: React.ReactNode }) {
  const [pendingPan, setPendingPanState] = useState<PendingPan | null>(null);

  const setPendingPan = useCallback((target: PendingPan | null) => {
    setPendingPanState(target);
  }, []);

  const value = useMemo(
    () => ({ pendingPan, setPendingPan }),
    [pendingPan, setPendingPan],
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
