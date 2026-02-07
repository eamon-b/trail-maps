import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';

interface BottomSheetContextValue {
  /**
   * Register a dismiss callback for the currently open bottom sheet.
   * Returns an unregister function. Only one sheet at a time (no stacking).
   */
  registerSheet: (dismiss: () => void) => () => void;
  /** Dismiss the current bottom sheet if one is open. Returns true if dismissed. */
  dismissSheet: () => boolean;
}

const BottomSheetContext = createContext<BottomSheetContextValue | null>(null);

/**
 * Provides a way for bottom sheets to register themselves so the
 * Android back button can dismiss them. Used by the tab layout's
 * BackHandler to implement: dismiss sheet → navigate back → no-op.
 */
export function BottomSheetProvider({ children }: { children: React.ReactNode }) {
  const dismissRef = useRef<(() => void) | null>(null);

  const registerSheet = useCallback((dismiss: () => void) => {
    dismissRef.current = dismiss;
    return () => {
      if (dismissRef.current === dismiss) {
        dismissRef.current = null;
      }
    };
  }, []);

  const dismissSheet = useCallback(() => {
    if (dismissRef.current) {
      dismissRef.current();
      dismissRef.current = null;
      return true;
    }
    return false;
  }, []);

  const value = useMemo(
    () => ({ registerSheet, dismissSheet }),
    [registerSheet, dismissSheet],
  );

  return (
    <BottomSheetContext.Provider value={value}>
      {children}
    </BottomSheetContext.Provider>
  );
}

export function useBottomSheetDismiss(): BottomSheetContextValue {
  const ctx = useContext(BottomSheetContext);
  if (!ctx) throw new Error('useBottomSheetDismiss must be used within a BottomSheetProvider');
  return ctx;
}
