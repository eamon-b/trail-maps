/**
 * Pure helpers for the hike screen's "Mark my location" action
 * (write-first-edit-after — see plans/usability-p1-field-features.md
 * decision 4). Split out of the screen so the naming/accuracy rules are
 * unit-testable without mounting the screen.
 */

/** Default name for a "Mark my location" waypoint: "Marked HH:MM" */
export function markedWaypointName(at: Date = new Date()): string {
  const h = at.getHours().toString().padStart(2, '0');
  const m = at.getMinutes().toString().padStart(2, '0');
  return `Marked ${h}:${m}`;
}

/**
 * Description preamble for a degraded fix ("±120 m fix") — only when the fix
 * is poor enough (> 50 m) that the reader should distrust the pin position.
 */
export function accuracyPreamble(accuracy: number | null): string | null {
  if (accuracy == null || accuracy <= 50) return null;
  return `±${Math.round(accuracy)} m fix`;
}
