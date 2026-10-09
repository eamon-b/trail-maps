/**
 * Pure rules behind the add/edit waypoint screen (`app/guide/[trailId]/waypoint-edit`).
 *
 * Kept out of the screen so they are tested without React: the form's starting
 * values, where the position lands on the trail and whether that is close
 * enough to keep, and the plain-English line describing it.
 */

import {
  USER_WAYPOINT_LIMITS,
  USER_WAYPOINT_TYPES,
  placeOnTrack,
  type PlaceableTrackPoint,
  type UserWaypoint,
  type UserWaypointType,
  type UserWaypointVisibility,
} from '@lib/user-waypoints';
import type { RouteBreak } from '@lib/trail-types';
import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { formatShortDistance } from '../guide/waypoint-filters';
import { isPlaceOffTrail } from '../guide/waypoint-detail';

export interface WaypointForm {
  name: string;
  type: UserWaypointType | null;
  description: string;
  visibility: UserWaypointVisibility;
  lat: number | null;
  lon: number | null;
}

/** The type chips, in picker order. */
export const WAYPOINT_TYPE_CHOICES: { value: UserWaypointType; label: string }[] =
  USER_WAYPOINT_TYPES.map((type) => ({ value: type, label: waypointTypeLabel(type) }));

/** Parse a numeric route param (`lat`/`lon` arrive as strings). */
export function numberParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The form's starting values: the waypoint being edited, else a new one at the
 * given position. A new waypoint starts private — sharing is a choice.
 */
export function initialWaypointForm(
  existing: UserWaypoint | null,
  at: { lat: number | null; lon: number | null },
): WaypointForm {
  if (existing) {
    return {
      name: existing.name,
      type: existing.type,
      description: existing.description,
      visibility: existing.visibility,
      lat: existing.lat,
      lon: existing.lon,
    };
  }
  return { name: '', type: null, description: '', visibility: 'private', lat: at.lat, lon: at.lon };
}

export type PositionSummary =
  | { ok: true; km: number; metres: number; text: string }
  | { ok: false; text: string };

/**
 * Where a position sits on the trail, as the form says it: "At km 12.3, on the
 * trail" or "At km 12.3, 240 m off the trail". `km` is along the direction the
 * guide is shown in (the caller passes that track). Too far away is refused:
 * the waypoint would not be about this trail.
 */
export function summarisePosition(
  lat: number | null,
  lon: number | null,
  points: readonly PlaceableTrackPoint[],
  breaks: RouteBreak[] | undefined,
  units: DistanceUnit,
): PositionSummary {
  if (lat === null || lon === null) {
    return { ok: false, text: 'No position yet. Long-press the map, or use your location.' };
  }
  const at = placeOnTrack(lat, lon, points, breaks);
  if (!at) return { ok: false, text: 'This trail has no track to place a waypoint on.' };
  const limitKm = USER_WAYPOINT_LIMITS.maxKmFromTrail;
  if (at.metres > limitKm * 1000) {
    return {
      ok: false,
      text: `This spot is ${formatDistance(at.metres / 1000, units)} from the trail. A waypoint must be within ${formatDistance(limitKm, units)} of it.`,
    };
  }
  const where = isPlaceOffTrail(at.metres)
    ? `${formatShortDistance(at.metres, units)} off the trail`
    : 'on the trail';
  return {
    ok: true,
    km: at.km,
    metres: at.metres,
    text: `At ${formatDistance(at.km, units)} along the trail, ${where}`,
  };
}
