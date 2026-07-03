/**
 * Shared path helpers for tile services.
 *
 * Centralises directory layout and URI conversion used by
 * tile-service.ts, grid-tile-service.ts, and tile-manager.ts.
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
