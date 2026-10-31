/**
 * Which R2 archive each `{source}` path segment serves. Kept free of runtime
 * dependencies (no pmtiles, no Workers globals) so the root test suite can
 * import the real mapping rather than a copy of it.
 */

/**
 * Served tilesets, keyed by the `{source}` path segment. Adding a tileset is
 * one entry here plus uploading the archive to R2 — nothing else in the Worker
 * is per-source.
 *
 * `contours` served the Australia archive until it was retired (#228); it is
 * now an alias of `world`, kept because shipped app builds request it for
 * Australian trails. contours/australia.pmtiles stays in R2 as a frozen
 * download but is no longer served here.
 */
export const SOURCES: Readonly<Record<string, string>> = {
  contours: 'contours/world.pmtiles',
  world: 'contours/world.pmtiles',
  // Not contours: the Protomaps planet basemap the bundled offline packs are
  // extracted from. Phones build an imported route's offline pack from it (#227).
  base: 'basemap/planet.pmtiles',
};

/** The source whose health decides the top-level `ok` of /health. */
export const DEFAULT_SOURCE = 'world';

/** Own keys only, so `constructor`, `__proto__` and the like are never sources. */
export function isKnownSource(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOURCES, source);
}

/** The R2 key a source serves, or null for an unknown source (→ 404). */
export function archiveKeyForSource(source: string): string | null {
  return isKnownSource(source) ? SOURCES[source] : null;
}
