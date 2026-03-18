/**
 * Trail utility types and functions for the mobile app.
 *
 * Provides data types for trail display, functions to convert raw trail JSON
 * into display-ready structures, and helper functions for distance/elevation
 * calculations used by the elevation profile and GPS snapping.
 */

import type { TrailJson } from '../services/trail-loader';

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
  waypoints?: {
    name: string;
    type: string;
    lat: number;
    lon: number;
    elevation: number;
    distance: number;
    totalDistance: number;
    ascent: number;
    descent: number;
    totalAscent: number;
    totalDescent: number;
    variantTrackIndex: number;
    description?: string;
  }[];
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
    waypoints: json.waypoints.map(wp => ({
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

/** Reverse track points, flipping cumulative distances. */
export function reverseTrackPoints(points: TrackPoint[], totalDistance: number): TrackPoint[] {
  return [...points].reverse().map(p => ({
    ...p,
    dist: totalDistance - p.dist,
  }));
}

/** Reverse waypoints, recalculating segment distances and ascent/descent. */
export function reverseWaypoints(
  waypoints: TrailWaypoint[],
  totalDistance: number,
  trackLength: number,
): TrailWaypoint[] {
  const reversed = [...waypoints].reverse();

  const withNewTotals = reversed.map(wp => ({
    ...wp,
    newTotalDistance: totalDistance - (wp.totalDistance || 0),
  }));

  let runningAscent = 0;
  let runningDescent = 0;

  return withNewTotals.map((wp, i, arr) => {
    const segmentAscent = wp.descent || 0;
    const segmentDescent = wp.ascent || 0;
    runningAscent += segmentAscent;
    runningDescent += segmentDescent;

    const segmentDist = i === 0 ? 0 : wp.newTotalDistance - arr[i - 1].newTotalDistance;

    return {
      ...wp,
      distance: Math.abs(segmentDist),
      totalDistance: wp.newTotalDistance,
      ascent: segmentAscent,
      descent: segmentDescent,
      totalAscent: runningAscent,
      totalDescent: runningDescent,
      trackIndex: trackLength - 1 - (wp.trackIndex || 0),
    };
  });
}

/** Reverse alternate route variants, flipping start/end distances. */
export function reverseAlternates(alternates: RouteVariant[], totalDistance: number): RouteVariant[] {
  return alternates.map(alt => ({
    ...alt,
    startDistance: totalDistance - (alt.endDistance || 0),
    endDistance: totalDistance - (alt.startDistance || 0),
    points: alt.points ? [...alt.points].reverse() : [],
  }));
}

/** Transform side trips for direction change (flip attachment point). */
export function transformSideTrips(sideTrips: RouteVariant[], totalDistance: number): RouteVariant[] {
  return sideTrips.map(trip => ({
    ...trip,
    startDistance: totalDistance - (trip.startDistance || 0),
  }));
}

/** Create a fully reversed copy of a trail (swap start/end direction). */
export function createReversedTrail(trail: Trail): Trail {
  const totalDist = trail.track.totalDistance;
  const trackLength = trail.track.points.length;

  const reversedPoints = reverseTrackPoints(trail.track.points, totalDist);
  const reversedDisplay = trail.track.displayPoints
    ? reverseTrackPoints(trail.track.displayPoints, totalDist)
    : undefined;

  return {
    config: trail.config,
    track: {
      points: reversedPoints,
      displayPoints: reversedDisplay,
      totalDistance: totalDist,
      totalAscent: trail.track.totalDescent,
      totalDescent: trail.track.totalAscent,
    },
    waypoints: reverseWaypoints(trail.waypoints, totalDist, trackLength),
    alternates: reverseAlternates(trail.alternates || [], totalDist),
    sideTrips: transformSideTrips(trail.sideTrips || [], totalDist),
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find the index of the track point nearest to a given km distance.
 * Uses binary search for efficiency on sorted distance arrays.
 */
export function findNearestByDistance(points: TrackPoint[], targetKm: number): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return 0;

  let lo = 0;
  let hi = points.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < targetKm) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first point with dist >= targetKm
  // Check if lo-1 is closer
  if (lo > 0) {
    const diffBefore = Math.abs(points[lo - 1].dist - targetKm);
    const diffAfter = Math.abs(points[lo].dist - targetKm);
    return diffBefore <= diffAfter ? lo - 1 : lo;
  }

  return lo;
}

/**
 * Find the index of a target waypoint in the waypoints array.
 * Primary match: name + totalDistance (within 0.1 km tolerance).
 * Fallback: name + lat/lon coordinates (within ~11 m tolerance).
 * Returns -1 if not found.
 */
export function findWaypointIndex(
  waypoints: TrailWaypoint[],
  target: TrailWaypoint,
): number {
  if (target.totalDistance != null) {
    const idx = waypoints.findIndex(
      w => w.name === target.name &&
           w.totalDistance != null &&
           Math.abs(w.totalDistance! - target.totalDistance!) < 0.1,
    );
    if (idx >= 0) return idx;
  }
  return waypoints.findIndex(
    w => w.name === target.name &&
         Math.abs(w.lat - target.lat) < 0.0001 &&
         Math.abs(w.lon - target.lon) < 0.0001,
  );
}

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
