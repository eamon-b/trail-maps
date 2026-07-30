/**
 * Plan-screen display formatting. Distance/elevation go through the shared
 * `@lib/format-distance`; this only owns the plan-specific bits (hours, food
 * weight) so the calculators' raw outputs render consistently.
 */

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
