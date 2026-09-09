/**
 * Pure, React-free helpers for the waypoint detail screen: relative-date
 * formatting for the comment feed, the water-status chip registry, the
 * water-family test that decides whether the composer offers flow chips, a
 * simple distance→ETA estimate, and the lookup behind the "From OpenStreetMap"
 * section. Kept here so they are unit-tested without the screen.
 */

import type { WaterStatus } from '@lib/comments-api-types';
import type { TrailPOI } from '@lib/trail-types';
import { categoryToken } from '../elevation/waypoint-category';
import type { TrailJson } from '../../services/trail-assets';

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

/** Default hiking pace for the rough ETA estimate. */
export const DEFAULT_PACE_KMH = 4;

/**
 * Rough minutes-to-reach for a waypoint `distanceKm` ahead. Returns null for a
 * waypoint at or behind the hiker (no meaningful ETA).
 */
export function estimateEtaMinutes(
  distanceKm: number,
  paceKmh: number = DEFAULT_PACE_KMH,
): number | null {
  if (distanceKm <= 0 || paceKmh <= 0) return null;
  return (distanceKm / paceKmh) * 60;
}

/** Format an ETA in minutes as "12 min" / "1 h 20 min" / "<1 min". */
export function formatEta(minutes: number | null): string | null {
  if (minutes == null) return null;
  const rounded = Math.round(minutes);
  if (rounded < 1) return '<1 min';
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
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
