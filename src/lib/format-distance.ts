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

/**
 * Convert a distance in kilometres to the requested unit.
 * (Exposed for callers that need the raw number, e.g. axis ticks.)
 */
export function convertDistance(km: number, unit: DistanceUnit): number {
  return unit === 'mi' ? km / KM_PER_MILE : km;
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
