/**
 * Axis math for the elevation profile — pure, React-free, unit-testable.
 *
 * Ported from the old app's `trail-utils` (`getMinMax` + `niceAxisTicks`) so
 * the new Skia profile reuses the exact tick logic the previous app shipped.
 *
 * The unit-aware helpers (`distanceAxisTicks`, `elevationAxis`) compute ticks
 * that are "nice" in the *display* unit — a mi axis reads 0/10/20 mi, a ft axis
 * reads round feet — while returning each tick's position in the chart's native
 * domain (km for distance, metres for elevation) so the caller's existing
 * pixel-mapping is unchanged.
 */

import { convertDistance, convertElevation, type DistanceUnit } from '@lib/format-distance';

/** Min and max of a numeric array (0/0 for an empty array). */
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
 * Produce "nice" round tick values (…1, 2, 5, 10, 20, 50…) covering roughly
 * `targetCount` steps across [min, max]. Returns [] for a non-positive
 * targetCount and [min] for a zero/negative range.
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

/** A rendered axis tick: `pos` in the chart's native domain, `label` in the
 * active display unit (no unit suffix). */
export interface AxisTick {
  pos: number;
  label: string;
}

/**
 * Decimal places a tick step needs to stay distinguishable: whole steps read as
 * integers, a 0.5 step needs one place, a 0.05 step two (capped at three).
 */
function tickDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
}

/**
 * Label a run of nice ticks, choosing the precision from their spacing. Zoomed
 * windows produce sub-unit steps (e.g. 0.2 km), which a fixed one-decimal
 * format would collapse into duplicate labels.
 */
function tickLabels(values: number[]): string[] {
  const step = values.length > 1 ? Math.abs(values[1] - values[0]) : 0;
  const decimals = tickDecimals(step);
  return values.map((v) =>
    decimals === 0 ? String(Math.round(v * 1e6) / 1e6) : v.toFixed(decimals),
  );
}

/**
 * Distance axis ticks that are nice in the display unit but positioned in km.
 * e.g. a 0–427 mi trail yields 0/100/200/300/400 mi labels at their km offsets.
 */
export function distanceAxisTicks(
  startKm: number,
  endKm: number,
  unit: DistanceUnit,
  targetCount: number,
): AxisTick[] {
  const ticks = niceAxisTicks(convertDistance(startKm, unit), convertDistance(endKm, unit), targetCount);
  // convertDistance is linear, so its inverse scale is 1 / convertDistance(1).
  const kmPerUnit = 1 / (convertDistance(1, unit) || 1);
  const labels = tickLabels(ticks);
  return ticks.map((t, i) => ({ pos: t * kmPerUnit, label: labels[i] }));
}

/** An elevation axis: ticks (nice in the display unit, positioned in metres)
 * plus the padded metre domain that seats the edge ticks on the frame. */
export interface ElevationAxis {
  /** Domain minimum in metres (padded to the lowest tick). */
  min: number;
  /** Domain maximum in metres (padded to the highest tick). */
  max: number;
  ticks: AxisTick[];
}

/**
 * Elevation axis ticks that are nice in the display unit (metres for 'km', feet
 * for 'mi') but positioned in metres, with the domain padded to the tick
 * extremes so the top/bottom ticks sit on the chart frame.
 */
export function elevationAxis(
  minMeters: number,
  maxMeters: number,
  unit: DistanceUnit,
  targetCount: number,
): ElevationAxis {
  const ticksU = niceAxisTicks(
    convertElevation(minMeters, unit),
    convertElevation(maxMeters, unit),
    targetCount,
  );
  const metersPerUnit = 1 / (convertElevation(1, unit) || 1);
  const labels = tickLabels(ticksU);
  const ticks: AxisTick[] = ticksU.map((t, i) => ({ pos: t * metersPerUnit, label: labels[i] }));
  const min = ticks.length > 0 ? Math.min(minMeters, ticks[0].pos) : minMeters;
  const max = ticks.length > 0 ? Math.max(maxMeters, ticks[ticks.length - 1].pos) : maxMeters;
  return { min, max, ticks };
}
