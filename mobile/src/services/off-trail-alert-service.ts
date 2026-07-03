import type { LocationState } from '../components/LocationStatusBar';

/** Preset threshold configurations */
export type AlertThresholdPreset = 'tight' | 'normal' | 'loose';

/** Distance thresholds for off-trail alert states (in meters) */
export interface AlertThresholds {
  /** Max distance to be "on trail" */
  onTrail: number;
  /** Max distance to be "drifting" */
  drifting: number;
  /** Max distance to be in "warning" zone; beyond this = offTrail */
  warning: number;
}

export const THRESHOLD_PRESETS: Record<AlertThresholdPreset, AlertThresholds> = {
  tight:  { onTrail: 30,  drifting: 100, warning: 300 },
  normal: { onTrail: 50,  drifting: 200, warning: 500 },
  loose:  { onTrail: 100, drifting: 300, warning: 750 },
};

/** Available snooze durations */
export const SNOOZE_DURATIONS = {
  '15min': 15 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '60min': 60 * 60 * 1000,
} as const;

export type SnoozeDuration = keyof typeof SNOOZE_DURATIONS;

/**
 * Compute location alert state from distance-from-trail and GPS accuracy.
 *
 * GPS accuracy is used to suppress false alerts: when accuracy > 20m, we
 * credit half the accuracy radius to reduce the effective distance.
 *
 * @param distanceFromTrail - Distance from nearest trail point in meters, or null (no GPS)
 * @param accuracy - GPS accuracy in meters, or null (unknown)
 * @param thresholds - Alert threshold configuration
 */
export function computeAlertState(
  distanceFromTrail: number | null,
  accuracy: number | null,
  thresholds: AlertThresholds = THRESHOLD_PRESETS.normal,
): LocationState {
  if (distanceFromTrail == null) return 'noGps';

  // When GPS accuracy is poor, reduce effective distance to suppress false positives.
  // We credit half the accuracy radius — if the user could be that much closer,
  // we don't want to alarm them.
  const effectiveDistance =
    accuracy != null && accuracy > 20
      ? Math.max(0, distanceFromTrail - accuracy * 0.5)
      : distanceFromTrail;

  if (effectiveDistance <= thresholds.onTrail) return 'onTrail';
  if (effectiveDistance <= thresholds.drifting) return 'drifting';
  if (effectiveDistance <= thresholds.warning) return 'warning';
  return 'offTrail';
}

/**
 * Compute the detail text to show on the location status bar.
 */
export function computeAlertDetail(
  state: LocationState,
  currentKm: number | null,
  distanceFromTrail: number | null,
  bearingToTrail?: number | null,
): string | undefined {
  switch (state) {
    case 'onTrail':
      return currentKm != null ? `km ${currentKm.toFixed(1)}` : undefined;
    case 'noGps':
      return currentKm != null ? `Last known: km ${currentKm.toFixed(1)}` : undefined;
    case 'drifting':
      return distanceFromTrail != null
        ? `${Math.round(distanceFromTrail)}m from trail`
        : undefined;
    case 'warning':
      return distanceFromTrail != null
        ? `${Math.round(distanceFromTrail)}m from trail`
        : undefined;
    case 'offTrail': {
      if (distanceFromTrail == null) return undefined;
      const dist = `${Math.round(distanceFromTrail)}m from trail`;
      if (bearingToTrail != null) {
        return `${dist} · head ${formatBearing(bearingToTrail)}`;
      }
      return dist;
    }
  }
}

/** Format a bearing in degrees to a compass direction string (e.g. "247° WSW") */
export function formatBearing(degrees: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(degrees / 22.5) % 16;
  return `${Math.round(degrees)}° ${dirs[idx]}`;
}

/**
 * Calculate bearing from a user position to a trail point.
 * Returns bearing in degrees (0=N, 90=E, 180=S, 270=W).
 */
export function getBearingToTrail(
  userLat: number,
  userLon: number,
  trailLat: number,
  trailLon: number,
): number {
  const dLon = toRad(trailLon - userLon);
  const lat1 = toRad(userLat);
  const lat2 = toRad(trailLat);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
