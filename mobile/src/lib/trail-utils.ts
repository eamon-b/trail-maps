/**
 * Trail utility types and functions for the mobile app.
 *
 * Provides data types for trail display, functions to convert raw trail JSON
 * into display-ready structures, and helper functions for distance/elevation
 * calculations used by the elevation profile and GPS snapping.
 */

import type { TrailJson } from '../services/trail-loader';
import { reverseAlternates, transformSideTrips } from '@lib/variant-reverse';
import { findNearestByDistance as nearestTrackIndex } from '@lib/track-geometry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance along the trail in km */
  dist: number;
}

export interface TrailWaypoint {
  /**
   * In-memory id for the waypoint. Stable across direction reversal and
   * filtering within a single load, so it's safe for React keys and
   * cross-view selection state. Assigned positionally from the source JSON,
   * so it will change if the trail data is rebuilt with different ordering —
   * do NOT persist this id (e.g. into saved plans or AsyncStorage).
   */
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: string;
  description?: string;
  elevation?: number;
  /** Distance from previous waypoint in km */
  distance?: number;
  /** Cumulative distance along trail in km */
  totalDistance?: number;
  /** Ascent within this waypoint's segment in m */
  ascent?: number;
  /** Descent within this waypoint's segment in m */
  descent?: number;
  /** Cumulative ascent from trail start in m */
  totalAscent?: number;
  /** Cumulative descent from trail start in m */
  totalDescent?: number;
  /** Index into the track points array */
  trackIndex?: number;
}

export interface RouteVariant {
  name: string;
  type?: 'alternate' | 'side-trip';
  distance?: number;
  /** Distance along main trail where variant starts (km) */
  startDistance?: number;
  /** Distance along main trail where variant ends (km) */
  endDistance?: number;
  elevation?: { ascent?: number; descent?: number };
  points?: TrackPoint[];
  waypoints?: VariantWaypoint[];
}

export interface VariantWaypoint {
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation: number;
  /** Segment distance from previous variant waypoint (variant-relative) in km */
  distance: number;
  /** Absolute trail km: junction startDistance + distance walked along the variant */
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
  description?: string;
}

export interface Trail {
  config: {
    id: string;
    name: string;
    shortName: string;
    region: string;
    lengthKm: number;
    direction: { default: string; reversed: string };
    [key: string]: unknown;
  };
  track: {
    points: TrackPoint[];
    displayPoints?: TrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: TrailWaypoint[];
  alternates?: RouteVariant[];
  sideTrips?: RouteVariant[];
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Convert raw trail JSON (from bundled assets) into a typed Trail object. */
export function trailJsonToTrail(json: TrailJson): Trail {
  return {
    config: json.config as Trail['config'],
    track: {
      points: json.track.points,
      displayPoints: json.track.displayPoints,
      totalDistance: json.track.totalDistance,
      totalAscent: json.track.totalAscent,
      totalDescent: json.track.totalDescent,
    },
    waypoints: json.waypoints.map((wp, i) => ({
      id: `wp-${i}`,
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      type: wp.type,
      description: wp.description,
      elevation: wp.elevation,
      distance: wp.distance,
      totalDistance: wp.totalDistance,
      ascent: wp.ascent,
      descent: wp.descent,
      totalAscent: wp.totalAscent,
      totalDescent: wp.totalDescent,
    })),
    alternates: (json as Record<string, unknown>).alternates as RouteVariant[] | undefined,
    sideTrips: (json as Record<string, unknown>).sideTrips as RouteVariant[] | undefined,
  };
}

// ---------------------------------------------------------------------------
// Direction reversal
// ---------------------------------------------------------------------------

// Trail/track/waypoint reversal is shared with the web plan viewer; the
// implementation lives in src/lib/trail-reverse.ts (structural generics, so
// the mobile Trail/TrailWaypoint/TrackPoint types flow through unchanged)
// and is re-exported here so existing mobile imports keep working.
export { reverseTrackPoints, reverseWaypoints, createReversedTrail } from '@lib/trail-reverse';

// Variant reversal math is shared with the web viewer via src/lib (see
// @lib/variant-reverse for the semantics, including the untouched passthrough
// for variants that never attach to the main track).
export { reverseAlternates, transformSideTrips };

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

// findNearestByDistance is shared with the web viewers; the implementation
// lives in src/lib/track-geometry.ts and is re-exported here so existing
// mobile imports keep working.
export { findNearestByDistance } from '@lib/track-geometry';

/** Find a route variant by its key (e.g. "alternate-some-name"). */
export function findVariantByKey(key: string, trail: Trail): RouteVariant | null {
  for (const v of trail.alternates || []) {
    const vKey = `${v.type}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (vKey === key) return v;
  }
  for (const v of trail.sideTrips || []) {
    const vKey = `${v.type}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (vKey === key) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

/** Get min and max from an array of numbers. */
export function getMinMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Generate "nice" axis tick values for a range.
 * Returns evenly spaced round numbers that cover the data range.
 */
export function niceAxisTicks(min: number, max: number, targetCount: number): number[] {
  const range = max - min;
  if (targetCount <= 0) return [];
  if (range <= 0) return [min];

  const roughStep = range / targetCount;

  // Find a "nice" step size (1, 2, 5, 10, 20, 50, 100, ...)
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;

  let niceStep: number;
  if (normalized <= 1.5) niceStep = magnitude;
  else if (normalized <= 3.5) niceStep = 2 * magnitude;
  else if (normalized <= 7.5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];

  for (let v = start; v <= max; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6); // avoid floating point artifacts
  }

  return ticks;
}

// ---------------------------------------------------------------------------
// Custom waypoints
// ---------------------------------------------------------------------------

/**
 * The subset of a stored custom waypoint row that the merge needs.
 * Matches the CustomWaypoint shape returned by TrailDataService.
 */
export interface CustomWaypointLike {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele?: number | null;
  kmPosition: number;
  description?: string | null;
}

/**
 * Merge user-created waypoints into a trail's waypoint list.
 *
 * Pure function applied at the load boundary (TrailDataContext.loadTrail), so
 * every consumer — map, datasheet, water-carry, elevation profile, measure —
 * picks custom waypoints up with zero further changes.
 *
 * - Ids are `custom-${row.id}` (stable across reversal; UI uses the prefix to
 *   offer edit/delete).
 * - `totalDistance` is the stored snapped km; `trackIndex` is resolved against
 *   the full-resolution track so reversal mirrors it correctly.
 * - Segment `distance` deltas are recomputed for ALL waypoints so the merged
 *   ordering stays self-consistent.
 * - Custom waypoints carry no per-segment elevation stats (ascent/descent 0)
 *   in the base direction. These fields are not consumed for merged rows (the
 *   elevation profile is derived from track geometry), so no terrain climb is
 *   attributed to the inserted segment.
 *
 * The input trail must be in its base (as-loaded) direction. Reversal via the
 * shared createReversedTrail (@lib/trail-reverse) happens downstream and
 * recomputes every waypoint's per-segment stats generically (arriving-segment
 * convention), including custom rows.
 */
export function mergeCustomWaypoints(trail: Trail, custom: CustomWaypointLike[]): Trail {
  if (custom.length === 0) return trail;

  const points = trail.track.points;

  const customWaypoints: TrailWaypoint[] = custom.map(row => {
    const trackIndex = nearestTrackIndex(points, row.kmPosition);
    return {
      id: `custom-${row.id}`,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      type: row.type,
      description: row.description ?? undefined,
      elevation: row.ele ?? points[trackIndex]?.ele,
      totalDistance: row.kmPosition,
      ascent: 0,
      descent: 0,
      trackIndex,
    };
  });

  // Stable sort: bundled waypoints keep their relative order; a custom
  // waypoint at the same km slots in after the bundled one.
  const merged = [...trail.waypoints, ...customWaypoints].sort(
    (a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0),
  );

  // Recompute segment distances (delta from the previous waypoint) for every
  // waypoint — insertion changes the "previous waypoint" for the row after
  // each custom insert. The first waypoint's distance is measured from the
  // trail start.
  const waypoints = merged.map((wp, i) => ({
    ...wp,
    distance: i === 0
      ? Math.max(0, wp.totalDistance ?? 0)
      : Math.max(0, (wp.totalDistance ?? 0) - (merged[i - 1].totalDistance ?? 0)),
  }));

  return { ...trail, waypoints };
}
