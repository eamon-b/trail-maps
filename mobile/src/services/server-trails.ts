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
 * same ids as the allowlist (`scripts/server-trail-allowlist.test.ts` holds them
 * equal), so this module is the cheap authority and `trail-loader` re-exports
 * it (see its `isServerKnown`).
 *
 * Trails published to the R2 catalog but not bundled in this build (a trail
 * added after the APK was made) are server-known too: the catalog is ours, and
 * publishing a trail means adding it to the allowlist. `trail-data-updates`
 * registers their ids here whenever it loads or refreshes the catalog — pushed
 * in rather than pulled, so this module still imports nothing.
 *
 * Community routes (`c_<16>`, `services/community-routes`) are the other
 * exception the other way round: they live on the server, but outside the
 * allowlist, so they are local-only here exactly like `u_` imports
 * ({@link isLocalOnlyTrailId}).
 */

const SERVER_TRAIL_IDS: ReadonlySet<string> = new Set(
  (require('../../assets/trails/index.json') as { id: string }[]).map((entry) => entry.id),
);

/** Catalog-only trail ids — see {@link registerRemoteTrailIds}. */
let remoteTrailIds: ReadonlySet<string> = new Set();

/**
 * Whether this trail id is known to the server (comments API allowlist,
 * waypoint-id registry) — i.e. whether it is bundled or in the R2 catalog.
 *
 * Imported ids must never be sent: a comment posted against one would 4xx at
 * best and create orphan rows at worst.
 */
export function isServerKnown(id: string): boolean {
  // Community routes (`c_…`) exist on the server, but not in `ALLOWED_TRAILS`:
  // comments, descriptions and plan sync are off for them, as for imports.
  if (isLocalOnlyTrailId(id)) return false;
  return SERVER_TRAIL_IDS.has(id) || remoteTrailIds.has(id);
}

/**
 * Ids that must never reach a comments/plans route: user imports (`u_`) and
 * community routes (`c_`, `plans/community-routes.md`). Checked by prefix
 * rather than by the full id shape so a malformed id is refused too.
 */
export function isLocalOnlyTrailId(id: string): boolean {
  return id.startsWith('u_') || id.startsWith('c_');
}

/**
 * Replace the set of catalog-only trail ids (published to R2, not bundled).
 * Called by `trail-data-updates`, which has already refused `u_` and `c_` ids —
 * they are refused again here, because this set is the gate on every network path.
 */
export function registerRemoteTrailIds(ids: Iterable<string>): void {
  remoteTrailIds = new Set([...ids].filter((id) => !isLocalOnlyTrailId(id)));
}

/** The bundled trail ids, in bundle order. */
export function serverTrailIds(): string[] {
  return [...SERVER_TRAIL_IDS];
}
