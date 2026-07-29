/**
 * Shares ONE `useGuidePosition` session across the guide's panes and the
 * distance strip.
 *
 * Without this, the map, elevation, list, and strip would each call
 * `useGuidePosition` and spin up an independent snap/derivation off the same
 * underlying OS watch. Hoisting it to a context means a single hook instance
 * drives the puck, the current-km marker, the per-row distances, and the strip
 * in lockstep — one `start()`, one status, one truth.
 */

import React, { createContext, useContext } from 'react';
import { useGuidePosition, type GuidePosition } from '../../hooks/useGuidePosition';

const GuidePositionContext = createContext<GuidePosition | null>(null);

export function GuidePositionProvider({ children }: { children: React.ReactNode }) {
  const value = useGuidePosition();
  return (
    <GuidePositionContext.Provider value={value}>{children}</GuidePositionContext.Provider>
  );
}

export function useGuidePositionContext(): GuidePosition {
  const ctx = useContext(GuidePositionContext);
  if (!ctx) {
    throw new Error('useGuidePositionContext must be used within a GuidePositionProvider');
  }
  return ctx;
}
