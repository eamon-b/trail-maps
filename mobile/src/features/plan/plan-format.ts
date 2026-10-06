/**
 * Plan-screen display formatting. Distance/elevation go through the shared
 * `@lib/format-distance`; this only owns the plan-specific bits (hours, food
 * weight) so the calculators' raw outputs render consistently.
 */

import { formatDistance } from '@lib/format-distance';
import { DEFAULT_DRY_STRETCH_KM } from '@lib/water-carry-calculator';
import type { Units } from '../../state/settings-store';

/** Pounds per kilogram. */
const LB_PER_KG = 2.20462;

/** "8.0 h" — one decimal, always a unit. */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

/** "≈ 3 days" / "≈ 1 day". */
export function formatDays(days: number): string {
  return `≈ ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Food-carry weight from the calculator's estimate. Metric ('km') shows
 * kilograms; imperial ('mi') shows pounds — matching FarOut, which shows lbs
 * to imperial users. Always one decimal.
 *
 * @example formatFoodWeight(2, 'km') // "2.0 kg"
 * @example formatFoodWeight(2, 'mi') // "4.4 lb"
 */
export function formatFoodWeight(weightKg: number, units: Units): string {
  if (units === 'mi') {
    return `${(weightKg * LB_PER_KG).toFixed(1)} lb`;
  }
  return `${weightKg.toFixed(1)} kg`;
}

/**
 * The dry-stretch badge, in the hiker's unit. The threshold is the one the
 * carries were flagged against (`plan-adapters` passes the same constant), so
 * the badge never names a figure the flag was not computed from. Miles keep a
 * decimal: 15 km is 9.3 mi, and "≥ 9 mi" would understate it.
 *
 * @example dryStretchBadge('km') // "Dry ≥ 15 km"
 * @example dryStretchBadge('mi') // "Dry ≥ 9.3 mi"
 */
export function dryStretchBadge(units: Units): string {
  const decimals = units === 'mi' ? 1 : 0;
  return `Dry ≥ ${formatDistance(DEFAULT_DRY_STRETCH_KM, units, { decimals })}`;
}
