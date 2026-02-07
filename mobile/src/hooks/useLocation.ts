import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestLocationPermission,
  getLocationPermissionStatus,
  startLocationTracking,
  stopLocationTracking,
  requestBackgroundPermission,
  startBackgroundTracking,
  stopBackgroundTracking,
  subscribeToBackgroundLocation,
  type LocationUpdate,
  type PermissionStatus,
} from '../services/location-service';
import { findNearestByDistance, type TrackPoint } from '../lib/trail-utils';
import { haversineDistance } from '@lib/distance';

export interface SnappedLocation {
  /** Raw GPS coordinates */
  raw: LocationUpdate;
  /** Snapped km position along trail */
  trailKm: number | null;
  /** Distance from trail in meters */
  distanceFromTrail: number | null;
}

interface UseLocationOptions {
  /** Enable background location tracking (survives screen lock) */
  background?: boolean;
}

interface UseLocationResult {
  /** Current location (raw + snapped) */
  location: SnappedLocation | null;
  /** GPS accuracy in meters */
  accuracy: number | null;
  /** Error message if any */
  error: string | null;
  /** Whether actively tracking */
  isTracking: boolean;
  /** Permission status */
  permissionStatus: PermissionStatus;
  /** Start GPS tracking */
  startTracking: () => Promise<void>;
  /** Stop GPS tracking */
  stopTracking: () => void;
}

/**
 * Hook for GPS location tracking with trail snapping.
 * @param trackPoints - Track points to snap location to (pass null to skip snapping)
 * @param options - Optional config (e.g. background tracking)
 */
export function useLocation(
  trackPoints?: TrackPoint[] | null,
  options?: UseLocationOptions,
): UseLocationResult {
  const background = options?.background ?? false;
  const [location, setLocation] = useState<SnappedLocation | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>('undetermined');
  const trackPointsRef = useRef(trackPoints);
  trackPointsRef.current = trackPoints;
  const lastSnappedKmRef = useRef<number | null>(null);

  // Check permission on mount
  useEffect(() => {
    getLocationPermissionStatus().then(setPermissionStatus);
  }, []);

  const snapToTrail = useCallback((update: LocationUpdate): SnappedLocation => {
    const points = trackPointsRef.current;
    if (!points || points.length === 0) {
      return { raw: update, trailKm: null, distanceFromTrail: null };
    }

    // Find nearest track point by lat/lon distance
    let nearestIdx = 0;
    let nearestDist = Infinity;
    // Sample every 10th point for efficiency, then refine
    const step = Math.max(1, Math.floor(points.length / 500));
    for (let i = 0; i < points.length; i += step) {
      const dist = haversineDistance(update.latitude, update.longitude, points[i].lat, points[i].lon);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    // Refine around the nearest coarse point
    const start = Math.max(0, nearestIdx - step);
    const end = Math.min(points.length - 1, nearestIdx + step);
    for (let i = start; i <= end; i++) {
      const dist = haversineDistance(update.latitude, update.longitude, points[i].lat, points[i].lon);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    return {
      raw: update,
      trailKm: points[nearestIdx].dist,
      distanceFromTrail: nearestDist,
    };
  }, []);

  const handleLocationUpdate = useCallback((update: LocationUpdate) => {
    setAccuracy(update.accuracy);
    setLocation(snapToTrail(update));
    setError(null);
  }, [snapToTrail]);

  const bgUnsubRef = useRef<(() => void) | null>(null);

  const startTracking = useCallback(async () => {
    try {
      const status = await requestLocationPermission();
      setPermissionStatus(status);

      if (status !== 'granted') {
        setError('Location permission not granted');
        return;
      }

      if (background) {
        const bgStatus = await requestBackgroundPermission();
        if (bgStatus !== 'granted') {
          setError('Background location permission not granted');
          return;
        }

        bgUnsubRef.current = subscribeToBackgroundLocation(handleLocationUpdate);
        await startBackgroundTracking();
      } else {
        await startLocationTracking(handleLocationUpdate);
      }

      setIsTracking(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start tracking');
    }
  }, [handleLocationUpdate, background]);

  const stopTrackingFn = useCallback(() => {
    if (background) {
      bgUnsubRef.current?.();
      bgUnsubRef.current = null;
      stopBackgroundTracking();
    } else {
      stopLocationTracking();
    }
    setIsTracking(false);
  }, [background]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopLocationTracking();
      bgUnsubRef.current?.();
      bgUnsubRef.current = null;
      stopBackgroundTracking();
    };
  }, []);

  return {
    location,
    accuracy,
    error,
    isTracking,
    permissionStatus,
    startTracking,
    stopTracking: stopTrackingFn,
  };
}
