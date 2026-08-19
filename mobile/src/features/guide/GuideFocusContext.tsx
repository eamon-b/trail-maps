/**
 * Which guide pane is showing, and the focus window they hand each other.
 *
 * The three panes stay mounted, so keeping them in *continuous* sync would mean
 * three views writing each other's viewports on every gesture — a render loop
 * waiting to happen. Instead the exchange happens once per switch, in one
 * direction only:
 *
 *   1. the pane you LEAVE is asked to `capture()` what it was looking at,
 *   2. that focus window is stored,
 *   3. the pane you ENTER is asked to `apply()` it.
 *
 * A pane that reports nothing (a map that has not settled, a list that has not
 * scrolled) simply leaves the previous focus standing, and a pane that is
 * already looking at the right stretch skips its own apply — see `isSameFocus`.
 *
 * Handlers are registered through refs and the apply is deferred one frame, so
 * nothing here re-renders a pane: `apply` is an imperative nudge (a camera fit,
 * a `setWindow`, a `scrollToIndex`) delivered after the entering pane has been
 * laid out — a pane hidden with `display: 'none'` has no layout to scroll.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { isValidFocus, type FocusWindow } from './guide-focus';

export type GuidePaneKey = 'map' | 'elevation' | 'list';

export interface PaneFocusHandlers {
  /** What this pane is looking at right now, or null if it cannot say. */
  capture?: () => FocusWindow | null;
  /** Bring this pane to the given section. */
  apply?: (focus: FocusWindow) => void;
}

/** Runs `fn` after the pane switch has been laid out. */
export type FocusScheduler = (fn: () => void) => void;

export interface GuideFocusValue {
  /** The pane currently showing. */
  pane: GuidePaneKey;
  /** Switch panes, carrying the focus window across. */
  switchPane: (next: GuidePaneKey) => void;
  /** Register a pane's capture/apply handlers; returns an unregister function. */
  registerPane: (pane: GuidePaneKey, handlers: PaneFocusHandlers) => () => void;
  /** The last captured focus window (null until a pane reports one). */
  getFocus: () => FocusWindow | null;
}

const GuideFocusContext = createContext<GuideFocusValue | null>(null);

const defaultScheduler: FocusScheduler = (fn) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 0);
};

export function GuideFocusProvider({
  children,
  initialPane = 'map',
  /** Injectable so tests can run the apply step synchronously. */
  scheduler = defaultScheduler,
}: {
  children: React.ReactNode;
  initialPane?: GuidePaneKey;
  scheduler?: FocusScheduler;
}) {
  const [pane, setPane] = useState<GuidePaneKey>(initialPane);
  // Mirrors `pane` so switchPane can stay referentially stable (it is a
  // dependency of every pane's registration effect).
  const paneRef = useRef(pane);
  const handlersRef = useRef(new Map<GuidePaneKey, PaneFocusHandlers>());
  const focusRef = useRef<FocusWindow | null>(null);

  const registerPane = useCallback((key: GuidePaneKey, handlers: PaneFocusHandlers) => {
    handlersRef.current.set(key, handlers);
    return () => {
      if (handlersRef.current.get(key) === handlers) handlersRef.current.delete(key);
    };
  }, []);

  const getFocus = useCallback(() => focusRef.current, []);

  const switchPane = useCallback(
    (next: GuidePaneKey) => {
      const from = paneRef.current;
      if (from === next) return;

      const captured = handlersRef.current.get(from)?.capture?.();
      if (isValidFocus(captured)) focusRef.current = captured;

      paneRef.current = next;
      setPane(next);

      const focus = focusRef.current;
      const apply = handlersRef.current.get(next)?.apply;
      if (focus && apply) scheduler(() => apply(focus));
    },
    [scheduler],
  );

  const value = useMemo<GuideFocusValue>(
    () => ({ pane, switchPane, registerPane, getFocus }),
    [pane, switchPane, registerPane, getFocus],
  );

  return <GuideFocusContext.Provider value={value}>{children}</GuideFocusContext.Provider>;
}

export function useGuideFocus(): GuideFocusValue {
  const ctx = useContext(GuideFocusContext);
  if (!ctx) throw new Error('useGuideFocus must be used within a GuideFocusProvider');
  return ctx;
}

/**
 * Register a pane's focus handlers.
 *
 * The handlers are read through a ref at call time, so a pane can pass fresh
 * closures on every render (they always close over current state) without
 * re-running the registration effect.
 *
 * Outside a provider this is a no-op: a pane rendered on its own (a test, or a
 * future screen that shows just the map) simply has nobody to trade focus with.
 */
export function useGuidePaneFocus(pane: GuidePaneKey, handlers: PaneFocusHandlers): void {
  const ctx = useContext(GuideFocusContext);
  const registerPane = ctx?.registerPane;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    if (!registerPane) return;
    return registerPane(pane, {
      capture: () => handlersRef.current.capture?.() ?? null,
      apply: (focus) => handlersRef.current.apply?.(focus),
    });
  }, [pane, registerPane]);
}
