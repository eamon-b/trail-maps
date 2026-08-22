/**
 * The server boundary, as a dependency-light module.
 *
 * Only the bundled trails exist server-side: they are the comments API's
 * `ALLOWED_TRAILS` allowlist and the only ids in `data/waypoint-ids.json`. A
 * user-imported trail (`u_<hash>`) and its waypoints (`uw_<hash>`) exist on one
 * device and nowhere else, so every network path — comment pull, outbox write,
 * curated-description sync — has to gate on {@link isServerKnown} first.
 *
 * Why this lives apart from `trail-loader`: the gate is checked deep in the sync
 * engine, and importing the loader there would drag ~3 MB of bundled trail JSON,
 * `expo-file-system` and the SQLite layer into the sync module graph for the
 * sake of a set membership test. `assets/trails/index.json` is 4 KB and has the
 * same six ids, so this module is the cheap authority and `trail-loader`
 * re-exports it (see its `isServerKnown`).
 */

const SERVER_TRAIL_IDS: ReadonlySet<string> = new Set(
  (require('../../assets/trails/index.json') as { id: string }[]).map((entry) => entry.id),
);

/**
 * Whether this trail id is known to the server (comments API allowlist,
 * waypoint-id registry) — i.e. whether it is one of the bundled trails.
 *
 * Imported ids must never be sent: a comment posted against one would 4xx at
 * best and create orphan rows at worst.
 */
export function isServerKnown(id: string): boolean {
  return SERVER_TRAIL_IDS.has(id);
}

/** The bundled trail ids, in bundle order. */
export function serverTrailIds(): string[] {
  return [...SERVER_TRAIL_IDS];
}
