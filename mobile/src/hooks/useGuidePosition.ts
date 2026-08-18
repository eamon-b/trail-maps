/**
 * GPS position for the active guide.
 *
 * Combines `useLocation` (foreground watch + snap) with the active guide's
 * full-resolution track to produce a compact, UI-ready position for the guide
 * panes. The full-res `track.points` is snapped against (not the decimated
 * `displayPoints`) so the current km and off-trail distance stay accurate; the
 * windowed snap keeps the per-fix cost low regardless of track length.
 *
 * Permission is requested lazily: nothing happens until a consumer calls
 * `start()` (wired to a "Show my location" affordance), honouring the no
 * always-on GPS policy.
 *
 * The four-state machine:
 *   no-permission — not yet started, or permission denied → show the pill
 *   acquiring     — started, permission ok, waiting for the first fix
 *   fix           — a fix snapped on-trail
 *   off-trail     — a fix, but beyond the off-trail threshold from the track
 */

import { useCallback, useMemo, useState } from 'react';
import { useGuide } from '../features/guide/GuideContext';
import { useLocation } from './useLocation';
import { isOffTrail } from '../services/position-on-trail';

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
  /** Lazily request permission and begin tracking. */
  start: () => Promise<void>;
  /** Stop tracking. */
  stop: () => void;
}

export function useGuidePosition(): GuidePosition {
  const { trail } = useGuide();
  const points = trail.track.points;

  const {
    location,
    accuracy,
    permissionStatus,
    isTracking,
    startTracking,
    stopTracking,
  } = useLocation(points);

  // Whether the user has opted in this session. Kept separate from `isTracking`
  // so the "acquiring" state shows the instant `start()` is pressed, before the
  // async permission request resolves.
  const [hasStarted, setHasStarted] = useState(false);

  const start = useCallback(async () => {
    setHasStarted(true);
    await startTracking();
  }, [startTracking]);

  const stop = useCallback(() => {
    setHasStarted(false);
    stopTracking();
  }, [stopTracking]);

  const offTrailMeters = location?.offTrailMeters ?? null;

  const status = useMemo<GuidePositionStatus>(() => {
    if (location) {
      return isOffTrail(offTrailMeters) ? 'off-trail' : 'fix';
    }
    if (hasStarted && permissionStatus !== 'denied') return 'acquiring';
    return 'no-permission';
  }, [location, offTrailMeters, hasStarted, permissionStatus]);

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
    start,
    stop,
  };
}
