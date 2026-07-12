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
 * A GPS fix older than this (ms) is too stale to record — the user may have
 * moved far since. The Mark button disables past this age.
 */
export const STALE_FIX_MS = 60_000;

/** Below this age (ms) a fix is fresh enough that we don't annotate its age. */
export const FIX_AGE_ANNOTATE_MIN_MS = 15_000;

/** True when the last fix is too old to trust for marking a position. */
export function isFixStale(fixTimestampMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - fixTimestampMs > STALE_FIX_MS;
}

/**
 * Description preamble for a degraded fix ("±120 m fix") — only when the fix
 * is poor enough (> 50 m) that the reader should distrust the pin position.
 *
 * When the fix accuracy is annotated and the fix is aging (15–60 s old, i.e.
 * not fresh but not yet stale enough to block marking), the age is appended so
 * the recorded position carries an honest "±120 m fix, 32 s old" caveat.
 */
export function accuracyPreamble(
  accuracy: number | null,
  fixAgeMs?: number | null,
): string | null {
  if (accuracy == null || accuracy <= 50) return null;
  let text = `±${Math.round(accuracy)} m fix`;
  if (
    fixAgeMs != null &&
    fixAgeMs >= FIX_AGE_ANNOTATE_MIN_MS &&
    fixAgeMs <= STALE_FIX_MS
  ) {
    text += `, ${Math.round(fixAgeMs / 1000)} s old`;
  }
  return text;
}
