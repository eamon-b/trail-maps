/**
 * The "currently hiking" guide — the pure rules behind My Guides pinning it to
 * the top and a fresh launch opening straight into it. The choice itself is
 * `currentTrailId` in the settings store.
 */

/**
 * The list with the current trail moved to the front; every other trail keeps
 * its order. Unchanged (same array) when there is no current trail or it is not
 * in the list — a deleted import, or a catalog trail this phone no longer lists.
 */
export function orderWithCurrentFirst<T extends { id: string }>(
  trails: T[],
  currentTrailId: string | null,
): T[] {
  if (!currentTrailId) return trails;
  const index = trails.findIndex((t) => t.id === currentTrailId);
  if (index <= 0) return trails;
  return [trails[index], ...trails.slice(0, index), ...trails.slice(index + 1)];
}

/**
 * The trail a fresh launch should open, or null to stay on My Guides: only a
 * current trail the phone still lists, and never when the launch was for
 * something else (a file opened from outside the app).
 */
export function launchTrailId(
  currentTrailId: string | null,
  knownTrailIds: readonly string[],
  launchedForSomethingElse: boolean,
): string | null {
  if (!currentTrailId || launchedForSomethingElse) return null;
  return knownTrailIds.includes(currentTrailId) ? currentTrailId : null;
}
