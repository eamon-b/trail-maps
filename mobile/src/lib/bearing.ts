/**
 * Bearing math shared by the off-trail alert, the next-waypoint cards, and
 * the BearingIndicator (P1 PR C). Extracted from off-trail-alert-service so
 * the map/dashboard features don't import alerting code.
 *
 * Bearing convention: degrees clockwise from true north (0=N, 90=E, 180=S,
 * 270=W).
 */

/** How fast the user must be moving for GPS course heading to be trusted. */
export const MIN_SPEED_FOR_HEADING_MS = 0.5;

/** How fresh the fix must be for GPS course heading to be trusted. */
export const MAX_FIX_AGE_FOR_HEADING_MS = 60_000;

/**
 * Initial great-circle bearing from point 1 to point 2, in degrees [0, 360).
 */
export function bearingBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x =
    Math.cos(rLat1) * Math.sin(rLat2) -
    Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const CARDINAL_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                       'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-wind cardinal text for a bearing (e.g. 42° → "NE"). */
export function cardinalDirection(degrees: number): string {
  const idx = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return CARDINAL_DIRS[idx];
}

/** Format a bearing in degrees to a compass direction string (e.g. "247° WSW") */
export function formatBearing(degrees: number): string {
  return `${Math.round(degrees)}° ${cardinalDirection(degrees)}`;
}

/**
 * Shortest signed rotation from `heading` to `targetBearing`, in (-180, 180].
 * This is the angle the on-screen arrow is rotated by: 0 = straight ahead,
 * positive = clockwise (target to the right). Handles wrap-around
 * (heading 350°, target 10° → +20°, not -340°).
 */
export function relativeRotation(targetBearing: number, heading: number): number {
  let delta = (targetBearing - heading) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

/**
 * Whether GPS course heading can be trusted (decision 8): heading from
 * expo-location is course-over-ground — valid while moving, garbage standing
 * still. Requires a real heading (>= 0; expo-location reports -1 when course
 * is unknown, common on Android), speed > 0.5 m/s, and a fix younger than
 * 60 s. When this is false the UI must degrade to cardinal text, not show a
 * stale or fictitious arrow.
 */
export function isHeadingUsable(
  heading: number | null | undefined,
  speed: number | null | undefined,
  fixTimestamp: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (heading == null || heading < 0) return false;
  if (speed == null || speed <= MIN_SPEED_FOR_HEADING_MS) return false;
  if (fixTimestamp == null) return false;
  return now - fixTimestamp < MAX_FIX_AGE_FOR_HEADING_MS;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
