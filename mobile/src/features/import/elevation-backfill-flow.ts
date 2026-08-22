/**
 * The elevation-backfill flow, with no UI attached.
 *
 * `@lib/elevation-backfill` already knows how to ask a terrain API for a
 * profile and how to write it onto a built trail. What it does *not* know is
 * that on this side of the app an import is a `{ trail, report }` pair, and that
 * the report is not a rendering detail — `saveImport` persists
 * `report.hasElevation` into the registry row, and the review screen renders
 * `report.warnings` verbatim. So a backfill that updated only the trail would
 * leave a guide on disk flagged "no elevation" while carrying a full profile,
 * and a review card still warning about a flat one.
 *
 * Hence this wrapper: one call that moves the trail and the report together, so
 * the screen can do `setImported({ ...imported, ...backfilled })` and have the
 * stats, the warnings and the eventual save all agree.
 *
 * Two smaller reasons it exists rather than the screen calling `@lib` directly:
 *
 * 1. **Progress is a JS-thread concern.** The lookup is a sequence of awaited
 *    HTTP requests, so React gets the thread back between batches for free —
 *    but only if the `onProgress` callback is threaded through from the screen
 *    to `backfillElevation`. Doing that here keeps `app/import.tsx` a renderer
 *    of state, matching `import-gpx.ts`.
 * 2. **The button label needs the request count before the user commits**, and
 *    the estimate has to be computed from the same defaults the lookup will
 *    actually use. {@link elevationRequestEstimate} makes that one import
 *    instead of two.
 *
 * Nothing here is partial: either a complete profile is applied and a new pair
 * returned, or the promise rejects and the caller's existing import is still
 * exactly as it was.
 */

import {
  applyElevation,
  backfillElevation,
  estimateElevationRequests,
} from '@lib/elevation-backfill';
import type { ImportGpxResult } from '@lib/gpx-import';

/**
 * Prefix of the warning `importGpx` adds for a file with no `<ele>` data. Only
 * the stem is matched, so a reworded tail on the `@lib` side does not silently
 * leave a stale warning on screen next to a freshly fetched profile.
 */
const NO_ELEVATION_WARNING_PREFIX = 'No elevation data';

/** What replaces it once a profile has been fetched — provenance, not a warning. */
const BACKFILLED_NOTE =
  'Elevation came from Open-Elevation (terrain data), not from the file.';

export interface BackfillElevationFlowOptions {
  /** Called after every batch with (points fetched, points total). */
  onProgress?: (done: number, total: number) => void;
  /** Cancels the lookup; rejects with an error named `AbortError`. */
  signal?: AbortSignal;
}

/**
 * Fetch a terrain profile for an imported trail and fold it into the import.
 *
 * @returns a NEW `{ trail, report }` — the trail marked
 * `config.elevationSource: 'backfilled'` with ascent/descent re-derived, and the
 * report updated so `hasElevation` is true, the stale "no elevation" warning is
 * gone, and a note says where the numbers came from. The input is untouched.
 *
 * @throws whatever `backfillElevation` throws: an `AbortError` when `signal`
 * fires, or an `Error` describing the HTTP/parse failure. The screen renders
 * the message; every one of them is worth a retry.
 */
export async function backfillImportElevation(
  imported: ImportGpxResult,
  options: BackfillElevationFlowOptions = {},
): Promise<ImportGpxResult> {
  const elevations = await backfillElevation(imported.trail.track.points, {
    onProgress: options.onProgress,
    signal: options.signal,
  });

  const trail = applyElevation(imported.trail, elevations);

  return {
    trail,
    report: {
      ...imported.report,
      hasElevation: true,
      // The raw values are DEM samples, not barometry: whatever the file's own
      // data looked like, the noise warning no longer describes what is shown.
      elevationLooksNoisy: false,
      warnings: [
        ...imported.report.warnings.filter(
          (warning) => !warning.startsWith(NO_ELEVATION_WARNING_PREFIX),
        ),
        BACKFILLED_NOTE,
      ],
    },
  };
}

/**
 * How many HTTP requests a backfill of this trail will make — the number the
 * "Fetch elevation" button puts in front of the user before they wait for it.
 */
export function elevationRequestEstimate(trail: {
  /** Only the count is used, so this stays as loose as `TrailJson` needs it. */
  track: { points: readonly unknown[] };
}): number {
  return estimateElevationRequests(trail.track.points.length);
}
