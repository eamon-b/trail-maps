/**
 * Map scale bar maths: how many metres one screen point covers at a given
 * zoom and latitude, and the longest "round" distance that fits in the bar.
 *
 * Pure so it can be tested without a map. MapLibre Native lays its world out
 * in 512-point tiles, so at zoom z the equator is 512·2^z points wide; away
 * from the equator a point covers cos(latitude) as much ground (Web Mercator).
 */

import type { DistanceUnit } from '@lib/format-distance';

/** Equatorial circumference of the Web Mercator sphere, metres. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** MapLibre Native's tile size, in screen points. */
const TILE_SIZE_PT = 512;

const METRES_PER_MILE = 1609.344;
const METRES_PER_FOOT = 0.3048;

/** Metres of ground under one screen point at `zoom`, `latitude` degrees. */
export function metresPerPoint(zoom: number, latitude: number): number {
  const lat = Math.max(-85, Math.min(85, latitude));
  return (
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) /
    (TILE_SIZE_PT * Math.pow(2, zoom))
  );
}

/** Largest 1, 2 or 5 × 10^n that is ≤ `value` (value > 0). */
export function roundDown125(value: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const leading = value / magnitude;
  const step = leading >= 5 ? 5 : leading >= 2 ? 2 : 1;
  return step * magnitude;
}

export interface ScaleBarSpec {
  /** Bar length in screen points (≤ the requested maximum). */
  width: number;
  /** What the bar measures, e.g. "500 m", "2 km", "1,000 ft", "5 mi". */
  label: string;
}

const formatCount = (n: number): string => n.toLocaleString('en-US');

/**
 * The scale bar for a camera: the longest round distance that fits in
 * `maxWidth` points, in metres/kilometres or feet/miles to match the user's
 * distance unit. `null` when the inputs cannot describe a scale.
 */
export function scaleBarFor(
  zoom: number,
  latitude: number,
  unit: DistanceUnit,
  maxWidth: number,
): ScaleBarSpec | null {
  if (!Number.isFinite(zoom) || !Number.isFinite(latitude) || !(maxWidth > 0)) return null;
  const mpp = metresPerPoint(zoom, latitude);
  if (!(mpp > 0)) return null;
  const maxMetres = mpp * maxWidth;

  let metres: number;
  let label: string;
  if (unit === 'mi') {
    const maxMiles = maxMetres / METRES_PER_MILE;
    if (maxMiles >= 1) {
      const miles = roundDown125(maxMiles);
      metres = miles * METRES_PER_MILE;
      label = `${formatCount(miles)} mi`;
    } else {
      const feet = roundDown125(maxMetres / METRES_PER_FOOT);
      metres = feet * METRES_PER_FOOT;
      label = `${formatCount(feet)} ft`;
    }
  } else if (maxMetres >= 1000) {
    const km = roundDown125(maxMetres / 1000);
    metres = km * 1000;
    label = `${formatCount(km)} km`;
  } else {
    metres = roundDown125(maxMetres);
    label = `${formatCount(metres)} m`;
  }

  return { width: metres / mpp, label };
}
