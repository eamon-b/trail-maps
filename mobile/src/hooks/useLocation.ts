/**
 * Foreground GPS tracking with trail snapping.
 *
 * Ported from the old app and trimmed to the pieces Tracknotes needs: a lazy,
 * permission-gated foreground watch whose fixes are snapped to a supplied track
 * (via the pure `position-on-trail` service) to yield a current km and an
 * off-trail distance.
 *
 * The heavy geometry lives in `snapToTrail`; this hook only owns the tracking
 * lifecycle, the permission state, and a small hint-index cache that keeps the
 * per-fix snap cheap. Background tracking is intentionally absent — it stays
 * opt-in and lives in the location service.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestLocationPermission,
  getLocationPermissionStatus,
  startLocationTracking,
  stopLocationTracking,
  type LocationUpdate,
  type PermissionStatus,
} from '../services/location-service';
import { snapToTrail, type SnapPoint } from '../services/position-on-trail';

export interface SnappedLocation {
  /** Raw GPS coordinates. */
  raw: LocationUpdate;
  /** Snapped km position along the trail (null when no track was supplied). */
  trailKm: number | null;
  /** Distance from the trail in metres (null when no track was supplied). */
  offTrailMeters: number | null;
}

export interface UseLocationResult {
  /** Current location (raw + snapped), or null before the first fix. */
  location: SnappedLocation | null;
  /** GPS accuracy in metres. */
  accuracy: number | null;
  /** Error message, if any. */
  error: string | null;
  /** Whether a tracking session is live. */
  isTracking: boolean;
  /** Latest known permission status. */
  permissionStatus: PermissionStatus;
  /** Request permission (if needed) and start the foreground watch. */
  startTracking: () => Promise<void>;
  /** Stop this hook's tracking subscription. */
  stopTracking: () => void;
}

/**
 * @param trackPoints Points to snap fixes to (pass null/undefined to skip).
 */
export function useLocation(trackPoints?: readonly SnapPoint[] | null): UseLocationResult {
  const [location, setLocation] = useState<SnappedLocation | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>('undetermined');

  const trackPointsRef = useRef(trackPoints);
  trackPointsRef.current = trackPoints;

  // Previous nearest index — feeds the windowed snap. Reset when the track
  // changes (e.g. a direction reversal renumbers every point).
  const hintRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    hintRef.current = undefined;
  }, [trackPoints]);

  // Check permission on mount (non-prompting).
  useEffect(() => {
    getLocationPermissionStatus().then(setPermissionStatus).catch(() => {});
  }, []);

  const handleLocationUpdate = useCallback((update: LocationUpdate) => {
    setAccuracy(update.accuracy);
    const points = trackPointsRef.current;
    if (!points || points.length === 0) {
      setLocation({ raw: update, trailKm: null, offTrailMeters: null });
    } else {
      const snap = snapToTrail(update.latitude, update.longitude, points, hintRef.current);
      if (snap) hintRef.current = snap.index;
      setLocation({
        raw: update,
        trailKm: snap?.currentKm ?? null,
        offTrailMeters: snap?.offTrailMeters ?? null,
      });
    }
    setError(null);
  }, []);

  // Re-entrancy guard: a start already in flight short-circuits further calls.
  const startingRef = useRef(false);
  const activeRef = useRef(false);

  const startTracking = useCallback(async () => {
    if (startingRef.current || activeRef.current) return;
    startingRef.current = true;
    try {
      const status = await requestLocationPermission();
      setPermissionStatus(status);
      if (status !== 'granted') {
        setError('Location permission not granted');
        return;
      }
      await startLocationTracking(handleLocationUpdate);
      activeRef.current = true;
      setIsTracking(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start tracking');
    } finally {
      startingRef.current = false;
    }
  }, [handleLocationUpdate]);

  const stopTracking = useCallback(() => {
    // Unsubscribe only this hook instance — another screen may be tracking.
    stopLocationTracking(handleLocationUpdate);
    activeRef.current = false;
    setIsTracking(false);
  }, [handleLocationUpdate]);

  // Clean up this instance's subscription on unmount.
  useEffect(() => {
    return () => {
      stopLocationTracking(handleLocationUpdate);
    };
  }, [handleLocationUpdate]);

  return {
    location,
    accuracy,
    error,
    isTracking,
    permissionStatus,
    startTracking,
    stopTracking,
  };
}
