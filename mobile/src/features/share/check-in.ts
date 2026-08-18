/**
 * FarOut-style check-in composer.
 *
 * Turns the live guide state (or a tapped waypoint) into a plain-text check-in
 * ready for the OS share sheet: a natural-language sentence, an optional user
 * note, a one-tap Google Maps link, and a "(via Tracknotes)" sign-off.
 *
 * Pure and platform-free — no React, no `Share`, no browser/native APIs — so it
 * is trivially testable and safe to import anywhere. The invoking hook
 * (`use-check-in-share`) owns the actual `Share.share` call.
 */

import { formatDistance, type DistanceUnit } from '@lib/format-distance';

/** A live GPS fix from the guide position session. */
export interface CheckInGps {
  lat: number;
  lon: number;
  /** Snapped km along the trail (drives the progress readout). */
  currentKm: number;
  /** True when the fix is beyond the off-trail threshold. */
  offTrail?: boolean;
}

/** The waypoint being shared from, when the check-in originates on a detail. */
export interface CheckInWaypoint {
  name: string;
  /** Total distance of the waypoint along the trail, in km. */
  km: number;
  lat: number;
  lon: number;
}

export interface CheckInInput {
  trailName: string;
  /** Full trail length in km (the "of X" in the progress readout). */
  totalKm: number;
  units: DistanceUnit;
  /**
   * The user's live position. Present for a position check-in (guide) and
   * optionally for a waypoint check-in (used for the readout + maps link when
   * the hiker has a fix).
   */
  gps?: CheckInGps | null;
  /** Present when sharing from a waypoint detail. */
  waypoint?: CheckInWaypoint | null;
  /** Optional free-text note the user attached. */
  message?: string | null;
}

export interface CheckInPayload {
  title: string;
  message: string;
}

/** Format a coordinate pair as decimal degrees with hemisphere, 5 dp. */
export function formatCoords(lat: number, lon: number): string {
  const latHemi = lat < 0 ? 'S' : 'N';
  const lonHemi = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(5)}°${latHemi}, ${Math.abs(lon).toFixed(5)}°${lonHemi}`;
}

/** A one-tap Google Maps link for the given coordinate (signed, 5 dp). */
export function mapsLink(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

const SIGNOFF = '(via Tracknotes)';

/**
 * Compose a shareable check-in. Two shapes:
 *   - waypoint present → "Checking in at {name} ({km}) on {trail}."
 *   - otherwise (gps)  → "Checking in from {trail} — {done} of {total}."
 *
 * Both append the user's note (if any), a maps link, and the sign-off.
 */
export function composeCheckIn(input: CheckInInput): CheckInPayload {
  const { trailName, totalKm, units, gps, waypoint, message } = input;

  const lines: string[] = [];
  let title: string;
  let linkLat: number | null = null;
  let linkLon: number | null = null;

  if (waypoint) {
    title = `Check-in at ${waypoint.name}`;
    const km = formatDistance(waypoint.km, units);
    let sentence = `Checking in at ${waypoint.name} (${km}) on ${trailName}.`;
    // With a live fix, add the hiker's position; the fix also drives the link.
    if (gps) {
      sentence += ` Position: ${formatCoords(gps.lat, gps.lon)}.`;
      linkLat = gps.lat;
      linkLon = gps.lon;
    } else {
      // No fix: point the map link at the waypoint itself.
      linkLat = waypoint.lat;
      linkLon = waypoint.lon;
    }
    lines.push(sentence);
  } else if (gps) {
    title = `Check-in on ${trailName}`;
    const done = formatDistance(gps.currentKm, units);
    const total = formatDistance(totalKm, units);
    const offTrail = gps.offTrail ? ' (off trail)' : '';
    lines.push(
      `Checking in from ${trailName}${offTrail} — ${done} of ${total}. ` +
        `Position: ${formatCoords(gps.lat, gps.lon)}.`,
    );
    linkLat = gps.lat;
    linkLon = gps.lon;
  } else {
    // Nothing locatable — degrade to a bare check-in rather than throwing.
    title = `Check-in on ${trailName}`;
    lines.push(`Checking in from ${trailName}.`);
  }

  const note = message?.trim();
  if (note) lines.push(note);

  if (linkLat != null && linkLon != null) lines.push(mapsLink(linkLat, linkLon));

  lines.push(SIGNOFF);

  return { title, message: lines.join('\n') };
}
