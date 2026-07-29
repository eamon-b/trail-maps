/**
 * Axis math for the elevation profile — pure, React-free, unit-testable.
 *
 * Ported from the old app's `trail-utils` (`getMinMax` + `niceAxisTicks`) so
 * the new Skia profile reuses the exact tick logic the previous app shipped.
 */

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
