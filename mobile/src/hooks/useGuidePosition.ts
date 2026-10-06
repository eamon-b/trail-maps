/**
 * GPS position for the active guide.
 *
 * Combines `useLocation` (foreground watch + snap) with the active guide's
 * track to produce a compact, UI-ready position for the guide panes. Fixes are
 * snapped against `track.points` — the copy whose `dist` ladder every other km
 * on the phone is measured along. On a bundled trail that array is itself
 * thinned (to ~5,000 points; the CDT's are ~900 m apart), which is why the snap
 * measures to the nearest segment and interpolates the km along it rather than
 * reading it off the nearest vertex. The windowed snap keeps the per-fix cost
 * low regardless of track length.
 *
 * GPS is opt-in. Nothing is requested until a consumer calls `start()`
 * (wired to "Show my location"), and that tap is also the hiker's choice to
 * have it on: it sets the settings store's `gpsOnGuideOpen`, so later guides
 * start the foreground watch on their own (when the OS permission is still
 * granted) and the list's distances read from where the hiker stands. `stop()`
 * turns it off and clears that choice. Tracking is foreground-only and stops
 * when the guide closes.
 *
 * The four-state machine:
 *   no-permission — not started, permission denied, or the start failed
 *                   (`error` says why) → show the pill, whose tap retries
 *   acquiring     — started, permission ok, waiting for the first fix
 *   fix           — a fix snapped on-trail
 *   off-trail     — a fix, but beyond the off-trail threshold from the track
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGuide } from '../features/guide/GuideContext';
import { routeBreakStarts } from '@lib/route-breaks';
import { useLocation } from './useLocation';
import { isOffTrail } from '../services/position-on-trail';
import { useSettingsStore } from '../state/settings-store';

export type GuidePositionStatus = 'no-permission' | 'acquiring' | 'fix' | 'off-trail';

export interface GuidePosition {
  /** Raw GPS coordinate for the map puck, or null before the first fix. */
  position: { lat: number; lon: number } | null;
  /** Snapped km along the trail, or null before the first fix. */
  currentKm: number | null;
  /** Distance from the trail in metres, or null before the first fix. */
  offTrailMeters: number | null;
  /** GPS accuracy in metres (for the puck's accuracy circle). */
  accuracy: number | null;
  /** State machine value driving what the distance strip / puck render. */
  status: GuidePositionStatus;
  /** Whether a tracking session is live. */
  isTracking: boolean;
  /** Why the last start failed (location services off, …), or null. */
  error: string | null;
  /** Lazily request permission and begin tracking; the hiker's opt-in. */
  start: () => Promise<void>;
  /** Stop tracking and stop starting it when a guide opens. */
  stop: () => void;
}

export function useGuidePosition(): GuidePosition {
  const { trail } = useGuide();
  const points = trail.track.points;
  const breaks = trail.track.breaks;
  // Memoised on the breaks array: a new set every render would reset the
  // snap's hint index in `useLocation` on every fix.
  const breakStarts = useMemo(() => routeBreakStarts(breaks, 'points'), [breaks]);

  const {
    location,
    accuracy,
    error,
    permissionStatus,
    isTracking,
    startTracking,
    stopTracking,
  } = useLocation(points, breakStarts);

  // Whether the user has opted in this session. Kept separate from `isTracking`
  // so the "acquiring" state shows the instant `start()` is pressed, before the
  // async permission request resolves.
  const [hasStarted, setHasStarted] = useState(false);
  const gpsOnGuideOpen = useSettingsStore((s) => s.gpsOnGuideOpen);
  const setGpsOnGuideOpen = useSettingsStore((s) => s.setGpsOnGuideOpen);

  const start = useCallback(async () => {
    setHasStarted(true);
    setGpsOnGuideOpen(true);
    await startTracking();
  }, [startTracking, setGpsOnGuideOpen]);

  const stop = useCallback(() => {
    setHasStarted(false);
    setGpsOnGuideOpen(false);
    stopTracking();
  }, [stopTracking, setGpsOnGuideOpen]);

  // The hiker turned location on before and the OS still allows it: start
  // without waiting for a tap. Undetermined or denied stays manual, so this
  // never raises a permission prompt by itself. It runs once per change; a
  // failed start shows the pill (below), whose tap is the retry.
  const autoStart = gpsOnGuideOpen && permissionStatus === 'granted';
  useEffect(() => {
    if (autoStart) void startTracking();
  }, [autoStart, startTracking]);

  const offTrailMeters = location?.offTrailMeters ?? null;

  const status = useMemo<GuidePositionStatus>(() => {
    if (location) {
      return isOffTrail(offTrailMeters) ? 'off-trail' : 'fix';
    }
    const wanted = hasStarted || autoStart;
    if (wanted && permissionStatus !== 'denied' && error == null) return 'acquiring';
    return 'no-permission';
  }, [location, offTrailMeters, hasStarted, autoStart, permissionStatus, error]);

  const position = useMemo(
    () =>
      location ? { lat: location.raw.latitude, lon: location.raw.longitude } : null,
    [location],
  );

  return {
    position,
    currentKm: location?.trailKm ?? null,
    offTrailMeters,
    accuracy,
    status,
    isTracking,
    error,
    start,
    stop,
  };
}
