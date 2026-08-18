/**
 * Pure geometry helpers for the elevation profile: window (zoom range)
 * clamping, deriving a committed window from a live gesture transform, and
 * pixel-space hit-testing for waypoint markers and the crosshair snap.
 *
 * All functions are React-/Skia-free so they can be unit-tested directly and
 * (for the small arithmetic ones) safely inlined into gesture worklets.
 */

import { findNearestByDistance } from '@lib/track-geometry';

/** A visible distance range [startKm, endKm] along the trail. */
export interface KmWindow {
  startKm: number;
  endKm: number;
}

/**
 * Smallest window the user can zoom into, in km. At 1 km the distance axis
 * still labels cleanly (0.2 km steps) and a single switchback is legible.
 */
export const MIN_WINDOW_KM = 1;

/**
 * Clamp a candidate window to [0, totalKm] while keeping a sane span:
 *  - span is floored at `minWindowKm` (or the whole trail if it is shorter),
 *  - the window is shifted (not squashed) back inside the trail if it runs off
 *    either end, so the requested span is preserved where possible.
 */
export function clampWindow(
  startKm: number,
  endKm: number,
  totalKm: number,
  minWindowKm = MIN_WINDOW_KM,
): KmWindow {
  if (!(totalKm > 0)) return { startKm: 0, endKm: 0 };

  let start = Math.min(startKm, endKm);
  let end = Math.max(startKm, endKm);

  const maxSpan = totalKm;
  const minSpan = Math.min(minWindowKm, totalKm);
  let span = Math.min(Math.max(end - start, minSpan), maxSpan);

  // Re-center the (possibly resized) span on the original midpoint.
  const mid = (start + end) / 2;
  start = mid - span / 2;
  end = start + span;

  // Shift inside [0, totalKm] without changing the span.
  if (start < 0) {
    start = 0;
    end = span;
  }
  if (end > totalKm) {
    end = totalKm;
    start = totalKm - span;
  }
  if (start < 0) start = 0;

  return { startKm: start, endKm: end };
}

/** Horizontal plot geometry needed to map km <-> x. */
export interface PlotLayout {
  /** Left inset (px) where the plot area starts. */
  left: number;
  /** Plot area width (px). */
  chartWidth: number;
}

/**
 * Park a window of `span` km inside [0, totalKm] by *shifting* it — the span is
 * never squashed (only capped at the trail length), so dragging past either end
 * simply rests against it.
 */
function shiftIntoRange(startKm: number, span: number, totalKm: number): KmWindow {
  const fitted = Math.min(span, totalKm);
  const maxStart = totalKm - fitted;
  let start = startKm;
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return { startKm: start, endKm: start + fitted };
}

/**
 * Shift a window horizontally by a finger drag, preserving its span.
 *
 * The content follows the finger: dragging **right** (positive `translationX`)
 * moves the window *earlier* along the trail. Degenerate inputs (no width, no
 * span, no trail) return the base window unchanged.
 */
export function panWindowByPixels(
  base: KmWindow,
  translationXPx: number,
  chartWidth: number,
  totalKm: number,
): KmWindow {
  const span = base.endKm - base.startKm;
  if (!(span > 0) || !(chartWidth > 0) || !(totalKm > 0)) {
    return { startKm: base.startKm, endKm: base.endKm };
  }
  const dxKm = (translationXPx / chartWidth) * span;
  return shiftIntoRange(base.startKm - dxKm, span, totalKm);
}

/**
 * Pinch-zoom a window about a focal pixel: the km sitting under `focalX` stays
 * under `focalX`, so the trail expands/contracts around the user's fingers.
 *
 * `scale` > 1 zooms in (smaller span). The span is clamped to
 * [`minWindowKm`, `totalKm`] and the result shifted back inside the trail — at
 * the ends that means the focal point drifts rather than the window escaping.
 */
export function zoomWindowAtFocal(
  base: KmWindow,
  scale: number,
  focalX: number,
  layout: PlotLayout,
  totalKm: number,
  minWindowKm = MIN_WINDOW_KM,
): KmWindow {
  const baseSpan = base.endKm - base.startKm;
  if (!(baseSpan > 0) || !(layout.chartWidth > 0) || !(totalKm > 0)) {
    return { startKm: base.startKm, endKm: base.endKm };
  }
  const factor = scale > 0 ? scale : 1;
  const minSpan = Math.min(Math.max(minWindowKm, 1e-6), totalKm);
  const span = Math.min(Math.max(baseSpan / factor, minSpan), totalKm);
  // Where the focal point sits across the plot (clamped so a focal point in the
  // y-axis gutter anchors on the left edge instead of extrapolating).
  const frac = Math.min(Math.max((focalX - layout.left) / layout.chartWidth, 0), 1);
  const focalKm = base.startKm + frac * baseSpan;
  return shiftIntoRange(focalKm - frac * span, span, totalKm);
}

/** A rendered waypoint marker in pixel space. */
export interface MarkerHit {
  id: string;
  x: number;
  y: number;
}

/**
 * Nearest marker to a tap within `radius` px, or null. When several markers
 * fall inside the radius the closest (Euclidean) one wins.
 */
export function hitTestMarkers(
  markers: MarkerHit[],
  tapX: number,
  tapY: number,
  radius: number,
): string | null {
  let bestId: string | null = null;
  let bestDistSq = radius * radius;
  for (const m of markers) {
    const dx = m.x - tapX;
    const dy = m.y - tapY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      bestId = m.id;
    }
  }
  return bestId;
}

/** A waypoint the profile can mark on the trace. */
export interface ProfileMarkerInput {
  id: string;
  type: string;
  totalDistance?: number;
  elevation?: number;
}

/** A resolved marker in pixel space, with its paint (color + radius). */
export interface ProfileMarker {
  id: string;
  x: number;
  y: number;
  color: string;
  radius: number;
}

/** The plot geometry a marker is placed into (all px, plus the km window). */
export interface MarkerPlot {
  startKm: number;
  endKm: number;
  /** Left inset (px) where the plot area starts. */
  left: number;
  /** Plot area width (px). */
  chartWidth: number;
  /** Top inset (px) of the plot area. */
  top: number;
  /** Plot area height (px). */
  chartHeight: number;
  /** Elevation-domain minimum (metres) mapped to the plot floor. */
  eleMin: number;
  /** Elevation-domain span (metres); must be non-zero. */
  eleRange: number;
}

/**
 * Place waypoint markers on the elevation trace. Pure so favorite emphasis and
 * windowing are unit-testable without Skia: markers outside the window (or with
 * no distance) are dropped, and `resolve` supplies each marker's color + radius
 * so the caller routes favorite/category colors through the theme.
 */
export function buildProfileMarkers(
  waypoints: ProfileMarkerInput[],
  plot: MarkerPlot,
  resolve: (wp: ProfileMarkerInput) => { color: string; radius: number },
): ProfileMarker[] {
  const span = Math.max(plot.endKm - plot.startKm, 1e-6);
  const out: ProfileMarker[] = [];
  for (const wp of waypoints) {
    if (wp.totalDistance == null) continue;
    if (wp.totalDistance < plot.startKm || wp.totalDistance > plot.endKm) continue;
    const x = plot.left + ((wp.totalDistance - plot.startKm) / span) * plot.chartWidth;
    const ele = wp.elevation ?? plot.eleMin;
    const y = plot.top + plot.chartHeight - ((ele - plot.eleMin) / plot.eleRange) * plot.chartHeight;
    const { color, radius } = resolve(wp);
    out.push({ id: wp.id, x, y, color, radius });
  }
  return out;
}

/** A track point carrying at least distance + elevation. */
export interface DistEle {
  dist: number;
  ele: number;
}

/**
 * Snap a km position to the nearest track point (for the crosshair readout).
 * `points` must be sorted ascending by `dist` (binary search).
 */
export function nearestPointByKm<T extends DistEle>(points: T[], km: number): T | null {
  if (points.length === 0) return null;
  return points[findNearestByDistance(points, km)] ?? null;
}

/** Convert a screen x (px) to a km position within the given window/layout. */
export function xToKm(x: number, window: KmWindow, layout: PlotLayout): number {
  const span = window.endKm - window.startKm;
  if (!(layout.chartWidth > 0)) return window.startKm;
  return window.startKm + ((x - layout.left) / layout.chartWidth) * span;
}

/**
 * Convert a km position to a screen x (px) within the window/layout — the
 * inverse of `xToKm`. Used for every windowed overlay (ticks, GPS marker,
 * crosshair) so they all track the same zoom transform.
 */
export function kmToX(km: number, window: KmWindow, layout: PlotLayout): number {
  const span = window.endKm - window.startKm;
  if (!(span > 0)) return layout.left;
  return layout.left + ((km - window.startKm) / span) * layout.chartWidth;
}
