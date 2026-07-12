import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LocationState } from '../components/LocationStatusBar';
import type { SnappedLocation } from './useLocation';
import { findNearestByDistance, type TrackPoint } from '../lib/trail-utils';
import {
  computeAlertState,
  computeAlertDetail,
  getBearingToTrail,
  THRESHOLD_PRESETS,
  SNOOZE_DURATIONS,
  type AlertThresholdPreset,
  type SnoozeDuration,
} from '../services/off-trail-alert-service';

const SNOOZE_STORAGE_KEY = 'trail-companion:snoozeUntil';

/** Number of consecutive readings required before a state transition fires */
const DEBOUNCE_COUNT = 3;

/** GPS accuracy above which alerts are fully suppressed (unreliable readings) */
const MAX_RELIABLE_ACCURACY = 200;

interface UseOffTrailAlertOptions {
  thresholdPreset?: AlertThresholdPreset;
  enabled?: boolean;
}

export interface UseOffTrailAlertResult {
  alertState: LocationState;
  alertDetail: string | undefined;
  /** Bearing back to the nearest trail point (degrees), set while off trail */
  bearingToTrail: number | null;
  isSnoozed: boolean;
  snoozeUntil: Date | null;
  snooze: (duration: SnoozeDuration) => void;
  clearSnooze: () => void;
}

/**
 * Hook that computes off-trail alert state with debouncing and snooze support.
 *
 * - Debounces state changes: requires DEBOUNCE_COUNT consecutive readings
 *   in the new state before committing (prevents GPS drift false positives).
 * - Suppresses alerts when GPS accuracy is too poor (> MAX_RELIABLE_ACCURACY m).
 * - Supports snooze to temporarily disable alerts for known detours.
 */
export function useOffTrailAlert(
  location: SnappedLocation | null,
  accuracy: number | null,
  trackPoints: TrackPoint[],
  options: UseOffTrailAlertOptions = {},
): UseOffTrailAlertResult {
  const { thresholdPreset = 'normal', enabled = true } = options;
  const thresholds = THRESHOLD_PRESETS[thresholdPreset];

  const [alertState, setAlertState] = useState<LocationState>('noGps');
  const [alertDetail, setAlertDetail] = useState<string | undefined>(undefined);
  const [bearingToTrail, setBearingToTrail] = useState<number | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState<Date | null>(null);

  // Ring buffer for debounce: last N computed states
  const pendingStates = useRef<LocationState[]>([]);
  const committedState = useRef<LocationState>('noGps');

  const isSnoozed = snoozeUntil != null && snoozeUntil > new Date();

  // Restore persisted snooze on mount
  useEffect(() => {
    AsyncStorage.getItem(SNOOZE_STORAGE_KEY).then((value) => {
      if (value) {
        const expiry = new Date(value);
        if (expiry > new Date()) {
          setSnoozeUntil(expiry);
        } else {
          AsyncStorage.removeItem(SNOOZE_STORAGE_KEY);
        }
      }
    });
  }, []);

  const snooze = useCallback((duration: SnoozeDuration) => {
    const expiry = new Date(Date.now() + SNOOZE_DURATIONS[duration]);
    setSnoozeUntil(expiry);
    AsyncStorage.setItem(SNOOZE_STORAGE_KEY, expiry.toISOString());
  }, []);

  const clearSnooze = useCallback(() => {
    setSnoozeUntil(null);
    AsyncStorage.removeItem(SNOOZE_STORAGE_KEY);
  }, []);

  // Clear the snooze the moment it expires, rather than waiting for the next
  // GPS tick (which can be minutes away in battery-saver cadence). This drops
  // the lingering snooze chip and un-caps alerts on time, and cleans up the
  // persisted value on natural expiry.
  useEffect(() => {
    if (snoozeUntil == null) return;
    const ms = snoozeUntil.getTime() - Date.now();
    if (ms <= 0) {
      setSnoozeUntil(null);
      AsyncStorage.removeItem(SNOOZE_STORAGE_KEY);
      return;
    }
    const timer = setTimeout(() => {
      setSnoozeUntil(null);
      AsyncStorage.removeItem(SNOOZE_STORAGE_KEY);
    }, ms);
    return () => clearTimeout(timer);
  }, [snoozeUntil]);

  useEffect(() => {
    if (!enabled) {
      setAlertState('noGps');
      setAlertDetail(undefined);
      return;
    }

    // Suppress when accuracy is too unreliable
    if (accuracy != null && accuracy > MAX_RELIABLE_ACCURACY) {
      setAlertState('noGps');
      setAlertDetail('GPS signal weak');
      return;
    }

    const rawState = computeAlertState(location?.distanceFromTrail ?? null, accuracy, thresholds);

    // Debounce: accumulate readings, only commit if last DEBOUNCE_COUNT agree
    pendingStates.current = [...pendingStates.current.slice(-(DEBOUNCE_COUNT - 1)), rawState];

    const allAgree = pendingStates.current.length >= DEBOUNCE_COUNT &&
      pendingStates.current.every(s => s === rawState);

    // Allow immediate improvement (from worse to better state doesn't need debounce)
    const isImprovement = isStateImprovement(committedState.current, rawState);

    if (allAgree || isImprovement) {
      committedState.current = rawState;

      // During snooze, cap state at 'drifting' (no warning/offTrail alerts)
      const effectiveState = isSnoozed && (rawState === 'warning' || rawState === 'offTrail')
        ? 'drifting'
        : rawState;

      setAlertState(effectiveState);

      // Compute detail text including bearing to trail when off-trail
      let bearing: number | null = null;
      if (rawState === 'offTrail' && location?.raw && location.trailKm != null && trackPoints.length > 0) {
        const nearestIdx = findNearestByDistance(trackPoints, location.trailKm);
        const nearestPt = trackPoints[nearestIdx];
        if (nearestPt) {
          bearing = getBearingToTrail(
            location.raw.latitude,
            location.raw.longitude,
            nearestPt.lat,
            nearestPt.lon,
          );
        }
      }

      setBearingToTrail(bearing);
      setAlertDetail(
        computeAlertDetail(
          effectiveState,
          location?.trailKm ?? null,
          location?.distanceFromTrail ?? null,
          bearing,
        ),
      );
    }
  }, [location, accuracy, enabled, thresholds, isSnoozed, trackPoints]);

  return { alertState, alertDetail, bearingToTrail, isSnoozed, snoozeUntil, snooze, clearSnooze };
}

/**
 * Returns true if transitioning from `current` to `next` is an improvement
 * (i.e. moving to a "safer" state).  Improvements don't require debouncing.
 *
 * State severity order (least to most severe):
 *   onTrail < drifting < warning < offTrail < noGps
 */
function isStateImprovement(current: LocationState, next: LocationState): boolean {
  const severity: Record<LocationState, number> = {
    onTrail: 0,
    drifting: 1,
    warning: 2,
    offTrail: 3,
    noGps: 4,
  };
  return severity[next] < severity[current];
}
