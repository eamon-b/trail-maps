/**
 * Shared path helpers for tile services.
 *
 * Centralises directory layout and URI conversion used by
 * tile-service.ts and tile-manager.ts.
 */
import { File, Directory, Paths } from 'expo-file-system';

export const TILE_FILES = ['base.mbtiles', 'contours.mbtiles'] as const;
export type TileFileName = (typeof TILE_FILES)[number];

/** Root directory for all downloaded tiles: {documentDir}/tiles/ */
export function tilesRoot(): Directory {
  return new Directory(Paths.document, 'tiles');
}

/** Per-trail directory: {documentDir}/tiles/{trailId}/ */
export function trailTilesDir(trailId: string): Directory {
  return new Directory(Paths.document, 'tiles', trailId);
}

/** Directory where font glyphs are copied for MapLibre: {documentDir}/fonts/ */
export function fontsRoot(): Directory {
  return new Directory(Paths.document, 'fonts');
}

/** Convert a file:// URI to a bare filesystem path for mbtiles:// protocol */
export function uriToPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Path to a trail's manifest.json on disk */
export function manifestFile(trailId: string): File {
  return new File(trailTilesDir(trailId), 'manifest.json');
}

// ---------------------------------------------------------------------------
// Tile file generations
// ---------------------------------------------------------------------------

/** Split a tile file name into stem and extension: 'base.mbtiles' → ['base', '.mbtiles']. */
function splitName(name: string): [stem: string, ext: string] {
  const dot = name.lastIndexOf('.');
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * The next generation of an on-disk tile file name:
 * `base.mbtiles` → `base-1.mbtiles` → `base-2.mbtiles` → …
 *
 * maplibre-native caches the SQLite handle behind an `mbtiles://` URL for the
 * life of the process, keyed by path. Promoting a re-downloaded pack over the
 * path already in that cache leaves the map reading the old — now unlinked, and
 * in the case the "Re-download" button exists for, damaged — inode until the
 * app is force-stopped (#45). So each promotion lands on a path this process
 * has never opened, which is a fresh handle guaranteed by the same path-keyed
 * cache that caused the bug.
 */
export function nextTileFileName(current: string): string {
  const [stem, ext] = splitName(current);
  const match = /^(.*)-(\d+)$/.exec(stem);
  const base = match ? match[1] : stem;
  const generation = match ? Number(match[2]) : 0;
  return `${base}-${generation + 1}${ext}`;
}

/**
 * Is this on-disk name some generation of one of {@link TILE_FILES} —
 * `base.mbtiles`, `base-3.mbtiles`, and so on?
 *
 * Used to sweep superseded generations after a promotion. `manifest.json` and
 * in-flight `{name}.part` staging files match nothing here, so the sweep leaves
 * them alone.
 */
export function isTileFileName(name: string): boolean {
  return TILE_FILES.some((tile) => {
    if (name === tile) return true;
    const [stem, ext] = splitName(tile);
    if (!name.startsWith(`${stem}-`) || !name.endsWith(ext)) return false;
    return /^\d+$/.test(name.slice(stem.length + 1, name.length - ext.length));
  });
}
