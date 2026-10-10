/**
 * Pure, React-free helpers for the waypoint detail screen: relative-date
 * formatting for the comment feed, the water-status chip registry, the
 * water-family test that decides whether the composer offers flow chips, the
 * walk from the hiker to a place, and the lookup behind the "From OpenStreetMap"
 * section. Kept here so they are unit-tested without the screen.
 */

import type { WaterStatus } from '@lib/comments-api-types';
import { NO_BREAK_STARTS, type ElevationPoint } from '@lib/track-geometry';
import type { TrailPOI } from '@lib/trail-types';
import { categoryToken } from '../elevation/waypoint-category';
import type { TrailJson } from '../../services/trail-assets';
import { tripAlongTrail, type TrailTrip } from '../../services/distance-calculator';
import { snapToTrail, type SnapPoint } from '@lib/position-on-trail';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A compact relative date for a comment timestamp: "just now", "5 min ago",
 * "3 h ago", "2 d ago", then an absolute "3 Jul" (with year for older dates).
 */
export function relativeDate(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = nowMs - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)} d ago`;

  const d = new Date(then);
  const day = d.getDate();
  const month = MONTHS[d.getMonth()];
  const sameYear = new Date(nowMs).getFullYear() === d.getFullYear();
  return sameYear ? `${day} ${month}` : `${day} ${month} ${d.getFullYear()}`;
}

/** Theme color token key + label for a water status. */
export interface WaterStatusMeta {
  label: string;
  /** Key into `useTheme().colors`. */
  colorToken: 'waterFlowing' | 'waterLow' | 'waterDry';
}

const WATER_STATUS_META: Record<WaterStatus, WaterStatusMeta> = {
  flowing: { label: 'Flowing', colorToken: 'waterFlowing' },
  low: { label: 'Low', colorToken: 'waterLow' },
  dry: { label: 'Dry', colorToken: 'waterDry' },
};

/** The chips offered by the composer, in source-reliability order. */
export const WATER_STATUS_OPTIONS: WaterStatus[] = ['flowing', 'low', 'dry'];

/** Metadata (label + color token) for a water status. */
export function waterStatusMeta(status: WaterStatus): WaterStatusMeta {
  return WATER_STATUS_META[status];
}

/**
 * Whether a waypoint type belongs to the water family — the composer only
 * offers flow chips for these.
 */
export function isWaterFamily(type: string): boolean {
  return categoryToken(type) === 'waypointWater';
}

// ---------------------------------------------------------------------------
// From the hiker to the waypoint
// ---------------------------------------------------------------------------

/**
 * Within this many metres of the hiker's km, a place is level with them and
 * there is nothing to walk along the trail — the same 50 m "Here" threshold
 * `formatSignedDistance` uses.
 */
export const HERE_KM = 0.05;

/**
 * A place (waypoint or POI) further than this from the trail line is a walk
 * off it, worth saying so; nearer, it is on the trail as far as the hiker
 * cares. Its own figure, not the GPS fix's `OFF_TRAIL_THRESHOLD_M`: that one
 * is tuned for GPS noise and may move for reasons that have nothing to do with
 * how a place is described.
 */
export const PLACE_OFF_TRAIL_M = 50;

/** Whether a place `metres` from the trail line is a walk off it. */
export function isPlaceOffTrail(metres: number | null | undefined): boolean {
  return metres != null && metres > PLACE_OFF_TRAIL_M;
}

/**
 * The walk along the trail from the hiker's snapped km to a place at
 * `placeKm`, or null when the place is level with them (within `HERE_KM`).
 * The maths is the distance strip's (`tripAlongTrail`), at the hiker's pace.
 *
 * This is the trail part only: a hiker off the trail, or a place off it, has
 * a further walk this cannot measure — the trip card says so beside it.
 */
export function tripToWaypoint(
  currentKm: number,
  placeKm: number,
  trackPoints: readonly ElevationPoint[],
  baseKmh: number,
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): TrailTrip | null {
  if (Math.abs(placeKm - currentKm) < HERE_KM || trackPoints.length === 0) return null;
  return tripAlongTrail(currentKm, placeKm, trackPoints, baseKmh, breakStarts);
}

/**
 * How far a waypoint sits from the trail line, in metres. A turn-off carries
 * its own `offTrailKm` (the road or track to the place); anything else is
 * measured straight to the line, which is the least the walk can be.
 */
export function waypointOffTrailMeters(
  waypoint: { lat: number; lon: number; offTrailKm?: number },
  trackPoints: readonly SnapPoint[],
): number | null {
  if (waypoint.offTrailKm != null) return waypoint.offTrailKm * 1000;
  return distanceToLineMeters(waypoint.lat, waypoint.lon, trackPoints);
}

/**
 * Straight-line metres from (lat, lon) to the track as a line, not to its
 * nearest vertex: the app's tracks are thinned, and a waypoint on a long
 * straight stretch can sit hundreds of metres from either end of it.
 */
export function distanceToLineMeters(
  lat: number,
  lon: number,
  trackPoints: readonly SnapPoint[],
): number | null {
  const snap = snapToTrail(lat, lon, trackPoints);
  if (!snap) return null;
  let best = snap.offTrailMeters;
  // The nearest segment touches the nearest vertex (or, on a coarse scan's
  // near miss, one either side of it): project onto those.
  const from = Math.max(0, snap.index - 2);
  const to = Math.min(trackPoints.length - 1, snap.index + 2);
  for (let i = from; i < to; i++) {
    best = Math.min(best, segmentDistanceMeters(lat, lon, trackPoints[i], trackPoints[i + 1]));
  }
  return best;
}

const METRES_PER_DEGREE = 111_320;

/** Point-to-segment distance on a local equirectangular projection. */
function segmentDistanceMeters(
  lat: number,
  lon: number,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const kx = METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const ky = METRES_PER_DEGREE;
  const ax = (a.lon - lon) * kx;
  const ay = (a.lat - lat) * ky;
  const dx = (b.lon - a.lon) * kx;
  const dy = (b.lat - a.lat) * ky;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// ---------------------------------------------------------------------------
// Duplicate POIs
// ---------------------------------------------------------------------------

/**
 * The OSM points of interest flagged as describing this waypoint's place.
 *
 * `@lib/poi-dedup` annotates rather than deletes precisely so this lookup can
 * exist: a flagged POI is drawn nowhere — not on the map, not in the list, not
 * on the profile — but it frequently carries `website`, `opening_hours`,
 * `operator` or `capacity` that the curated waypoint lacks. The detail screen is
 * the one place a hidden POI ever surfaces, attributed to OSM and clearly
 * separate from the curated content.
 *
 * Local data only: no SQLite read, no request, so it works the same for an
 * imported guide as for a bundled one. Empty whenever the waypoint has no
 * stable id (nothing could have been flagged against it) or the trail was never
 * enriched.
 */
export function duplicatePoisFor(
  trail: Pick<TrailJson, 'pois'>,
  waypointId: string | undefined,
): TrailPOI[] {
  if (!waypointId || !trail.pois) return [];
  return trail.pois.filter((poi) => poi.duplicateOf === waypointId);
}
