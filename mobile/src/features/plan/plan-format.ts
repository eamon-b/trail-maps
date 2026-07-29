/**
 * Plan-screen display formatting. Distance/elevation go through the shared
 * `@lib/format-distance`; this only owns the plan-specific bits (hours, food
 * weight) so the calculators' raw outputs render consistently.
 */

/** "8.0 h" — one decimal, always a unit. */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

/** "≈ 3 days" / "≈ 1 day". */
export function formatDays(days: number): string {
  return `≈ ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Food-carry weight: "2.0 kg" (kg to 1dp, from the calculator's estimate). */
export function formatFoodWeight(weightKg: number): string {
  return `${weightKg.toFixed(1)} kg`;
}
