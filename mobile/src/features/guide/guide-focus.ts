/**
 * The guide's shared **focus window** — the stretch of trail the hiker is
 * currently looking at, expressed as a km range so all three panes can speak the
 * same language.
 *
 * The panes each have their own native idea of "where I am looking": the map has
 * a lat/lon viewport, the elevation profile has a zoom window, the list has a
 * scroll offset. Switching panes used to throw that away — you would zoom into a
 * climb on the map, tap Elevation, and land back on the whole-trail overview.
 *
 * This module is the translation layer between those three views, and it is
 * deliberately pure (no React, no MapLibre, no Skia) so every conversion is unit
 * testable:
 *
 *  - `kmRangeInBounds`  — map viewport  → km range
 *  - `boundsForKmRange` — km range      → map viewport
 *  - `focusFromItems`   — visible rows  → km range
 *  - `firstIndexInFocus`— km range      → row to scroll to
 *
 * The elevation profile needs no conversion: its `KmWindow` *is* a focus window,
 * which is why `FocusWindow` is that same shape and clamping reuses the
 * profile's `clampWindow`.
 */

import { findNearestByDistance } from '@lib/track-geometry';
import { clampWindow, MIN_WINDOW_KM, type KmWindow } from '../elevation/geometry';

/**
 * A section of the trail, as a distance range. Structurally identical to the
 * elevation profile's `KmWindow` — the profile's zoom *is* the focus window when
 * the profile is the pane you are leaving.
 */
export type FocusWindow = KmWindow;

/** Track point shape the conversions need (display points satisfy it). */
export interface FocusTrackPoint {
  lat: number;
  lon: number;
  /** Cumulative distance along the trail, km. */
  dist: number;
}

/** A list row the focus can be derived from / scrolled to. */
export interface FocusItem {
  /** Cumulative distance along the trail, km. */
  totalDistance?: number;
}

/** Map viewport corners in MapLibre's [lon, lat] order. */
export interface FocusBounds {
  ne: [number, number];
  sw: [number, number];
}

/**
 * Narrowest focus the panes will hand each other, km. Shared with the elevation
 * profile's own zoom floor so a window round-tripped through the map comes back
 * to the same place. Without a floor, a list showing one waypoint (or a map
 * zoomed to a single track point) would ask the profile for a zero-width window.
 */
export const MIN_FOCUS_SPAN_KM = MIN_WINDOW_KM;

/**
 * Half-size of the box used when a km range resolves to a single point, in
 * degrees (~110 m). `fitBounds` on a zero-area box is undefined behaviour, so a
 * degenerate range becomes a small square around the point instead.
 */
const DEGENERATE_BOX_DEGREES = 0.001;

/** Whether a candidate focus is usable (finite, ordered, non-negative). */
export function isValidFocus(focus: FocusWindow | null | undefined): focus is FocusWindow {
  if (!focus) return false;
  const { startKm, endKm } = focus;
  return (
    Number.isFinite(startKm) && Number.isFinite(endKm) && startKm >= 0 && endKm >= startKm
  );
}

/**
 * Clamp a focus to the trail and floor its span, so every pane receives a window
 * it can actually render. Delegates to the profile's `clampWindow` — one
 * implementation of "keep the span, shift it inside the trail".
 */
export function normalizeFocus(
  focus: FocusWindow,
  totalKm: number,
  minSpanKm = MIN_FOCUS_SPAN_KM,
): FocusWindow {
  return clampWindow(focus.startKm, focus.endKm, totalKm, minSpanKm);
}

/**
 * Whether two focus windows describe the same section, within a tolerance that
 * scales with the span (2% of the span, never tighter than 50 m).
 *
 * Used to make pane switching a no-op when the entering pane is already looking
 * at the right stretch — otherwise every switch would re-animate the camera (or
 * re-scroll the list) to where it already was.
 */
export function isSameFocus(
  a: FocusWindow | null | undefined,
  b: FocusWindow | null | undefined,
): boolean {
  if (!a || !b) return false;
  const span = Math.max(a.endKm - a.startKm, b.endKm - b.startKm);
  const tolerance = Math.max(span * 0.02, 0.05);
  return (
    Math.abs(a.startKm - b.startKm) <= tolerance && Math.abs(a.endKm - b.endKm) <= tolerance
  );
}

/** A lat/lon rectangle, unpacked from MapLibre's [ne, sw] corner pair. */
interface LatLonRect {
  north: number;
  south: number;
  east: number;
  west: number;
}

function toRect(bounds: FocusBounds): LatLonRect {
  const [eastLon, northLat] = bounds.ne;
  const [westLon, southLat] = bounds.sw;
  return {
    north: Math.max(northLat, southLat),
    south: Math.min(northLat, southLat),
    east: Math.max(eastLon, westLon),
    west: Math.min(eastLon, westLon),
  };
}

function contains(rect: LatLonRect, p: FocusTrackPoint): boolean {
  return p.lat <= rect.north && p.lat >= rect.south && p.lon <= rect.east && p.lon >= rect.west;
}

/**
 * The stretch of trail visible in a map viewport.
 *
 * A trail can pass through one viewport several times (a switchback, a loop, or
 * simply a section that doubles back a hundred km later), and taking the min/max
 * distance over every in-view point would then report a range covering all of
 * it. So the answer is the **contiguous run** of in-view track points containing
 * the point nearest the viewport centre — the section you are actually looking
 * at, not every section that happens to be nearby.
 *
 * Returns null when the trail is not in view at all: the caller keeps the
 * previous focus rather than jumping somewhere arbitrary.
 */
export function kmRangeInBounds(
  points: FocusTrackPoint[],
  bounds: FocusBounds,
  totalKm: number,
  minSpanKm = MIN_FOCUS_SPAN_KM,
): FocusWindow | null {
  if (points.length === 0) return null;
  const rect = toRect(bounds);
  const centerLat = (rect.north + rect.south) / 2;
  const centerLon = (rect.east + rect.west) / 2;
  // Longitude degrees shrink with latitude; scaling keeps "nearest" honest
  // without paying for a haversine on every point.
  const lonScale = Math.cos((centerLat * Math.PI) / 180);

  let nearest = -1;
  let nearestScore = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!contains(rect, p)) continue;
    const dLat = p.lat - centerLat;
    const dLon = (p.lon - centerLon) * lonScale;
    const score = dLat * dLat + dLon * dLon;
    if (score < nearestScore) {
      nearestScore = score;
      nearest = i;
    }
  }
  if (nearest < 0) return null;

  // Grow outwards along the track while the points stay in view.
  let lo = nearest;
  while (lo > 0 && contains(rect, points[lo - 1])) lo--;
  let hi = nearest;
  while (hi < points.length - 1 && contains(rect, points[hi + 1])) hi++;

  const startKm = Math.min(points[lo].dist, points[hi].dist);
  const endKm = Math.max(points[lo].dist, points[hi].dist);
  return normalizeFocus({ startKm, endKm }, totalKm || endKm, minSpanKm);
}

/**
 * Map viewport covering a km range: the bounding box of the track points inside
 * it. A range that lands between two points (or on a single one) falls back to
 * the nearest point and a small box around it, so `fitBounds` always receives a
 * non-degenerate rectangle.
 *
 * Returns null only when there is no geometry at all.
 */
export function boundsForKmRange(
  points: FocusTrackPoint[],
  focus: FocusWindow,
): FocusBounds | null {
  if (points.length === 0) return null;

  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  let found = 0;

  for (const p of points) {
    if (p.dist < focus.startKm || p.dist > focus.endKm) continue;
    found++;
    if (p.lat > north) north = p.lat;
    if (p.lat < south) south = p.lat;
    if (p.lon > east) east = p.lon;
    if (p.lon < west) west = p.lon;
  }

  if (found === 0) {
    const mid = (focus.startKm + focus.endKm) / 2;
    const p = points[findNearestByDistance(points, mid)];
    north = south = p.lat;
    east = west = p.lon;
  }

  // Pad a zero-width/height box so the camera has something to fit.
  if (north - south < DEGENERATE_BOX_DEGREES * 2) {
    const mid = (north + south) / 2;
    north = mid + DEGENERATE_BOX_DEGREES;
    south = mid - DEGENERATE_BOX_DEGREES;
  }
  if (east - west < DEGENERATE_BOX_DEGREES * 2) {
    const mid = (east + west) / 2;
    east = mid + DEGENERATE_BOX_DEGREES;
    west = mid - DEGENERATE_BOX_DEGREES;
  }

  return { ne: [east, north], sw: [west, south] };
}

/**
 * The km range spanned by a set of visible list rows. Rows without a distance
 * (and an empty set) contribute nothing; null means "nothing to report", which
 * leaves the previous focus standing.
 */
export function focusFromItems(
  items: FocusItem[],
  totalKm: number,
  minSpanKm = MIN_FOCUS_SPAN_KM,
): FocusWindow | null {
  let startKm = Infinity;
  let endKm = -Infinity;
  for (const item of items) {
    const km = item.totalDistance;
    if (km == null || !Number.isFinite(km)) continue;
    if (km < startKm) startKm = km;
    if (km > endKm) endKm = km;
  }
  if (startKm === Infinity) return null;
  return normalizeFocus({ startKm, endKm }, totalKm || endKm, minSpanKm);
}

/**
 * The row to scroll to for a focus window: the first item at or after the focus
 * start, so the section fills the list from the top. A focus that starts past
 * the last row settles on that last row; -1 means there is nothing to scroll to.
 *
 * `items` must be ordered by distance (the list pane's `orderedWaypoints` are).
 */
export function firstIndexInFocus(items: FocusItem[], focus: FocusWindow): number {
  if (items.length === 0) return -1;
  const index = items.findIndex((item) => (item.totalDistance ?? 0) >= focus.startKm);
  return index === -1 ? items.length - 1 : index;
}
