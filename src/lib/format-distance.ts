/**
 * Distance formatting — the single choke point for turning a kilometre value
 * into a unit-aware, human-readable string.
 *
 * Shared between web and mobile via the `@lib` alias. Keep it free of platform
 * APIs so both bundlers can import it.
 */

export type DistanceUnit = 'km' | 'mi';

/** Kilometres per mile. */
const KM_PER_MILE = 1.609344;

/** Feet per metre. */
const FEET_PER_METRE = 3.280839895;

/**
 * Convert a distance in kilometres to the requested unit.
 * (Exposed for callers that need the raw number, e.g. axis ticks.)
 */
export function convertDistance(km: number, unit: DistanceUnit): number {
  return unit === 'mi' ? km / KM_PER_MILE : km;
}

/**
 * Convert an elevation in metres to the unit that pairs with a distance unit:
 * metric ('km') stays metres, imperial ('mi') becomes feet — matching FarOut,
 * which shows feet to imperial users.
 * (Exposed for callers that need the raw number, e.g. elevation axis ticks.)
 */
export function convertElevation(meters: number, unit: DistanceUnit): number {
  const m = meters ?? 0;
  return unit === 'mi' ? m * FEET_PER_METRE : m;
}

/** Group an integer's digits with thousands separators ("1276" → "1,276"). */
function groupThousands(n: number): string {
  const neg = n < 0;
  const grouped = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

export interface FormatDistanceOptions {
  /** Decimal places to show. Default 1. */
  decimals?: number;
  /** Append the unit suffix (" km" / " mi"). Default true. */
  withUnit?: boolean;
}

/**
 * Format a kilometre distance for display.
 *
 * @example formatDistance(688.3, 'km') // "688.3 km"
 * @example formatDistance(688.3, 'mi') // "427.7 mi"
 * @example formatDistance(5, 'km', { withUnit: false }) // "5.0"
 */
export function formatDistance(
  km: number,
  unit: DistanceUnit,
  options: FormatDistanceOptions = {},
): string {
  const { decimals = 1, withUnit = true } = options;
  const value = convertDistance(km ?? 0, unit);
  const rounded = value.toFixed(decimals);
  return withUnit ? `${rounded} ${unit}` : rounded;
}

/**
 * Format an elevation for display. Metric ('km') shows whole metres; imperial
 * ('mi') shows whole feet with a thousands separator (FarOut convention).
 *
 * @example formatElevation(389, 'km') // "389 m"
 * @example formatElevation(389, 'mi') // "1,276 ft"
 */
export function formatElevation(meters: number, unit: DistanceUnit): string {
  const value = Math.round(convertElevation(meters ?? 0, unit));
  const suffix = unit === 'mi' ? 'ft' : 'm';
  return `${groupThousands(value)} ${suffix}`;
}
