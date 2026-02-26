/**
 * Tile download and management service.
 *
 * Handles downloading MBTiles files from a server, tracking what's on disk,
 * building MapLibre style JSON with correct mbtiles:// source URLs and
 * local glyph paths, and cleaning up downloaded tiles.
 */
import { File, Directory, Paths } from 'expo-file-system';
import { Asset } from 'expo-asset';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_FILES = ['base.mbtiles', 'contours.mbtiles'] as const;
export type TileFileName = (typeof TILE_FILES)[number];

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/** Root directory for all downloaded tiles: {documentDir}/tiles/ */
function tilesRoot(): Directory {
  return new Directory(Paths.document, 'tiles');
}

/** Per-trail directory: {documentDir}/tiles/{trailId}/ */
function trailTilesDir(trailId: string): Directory {
  return new Directory(Paths.document, 'tiles', trailId);
}

/** Directory where font glyphs are copied for MapLibre: {documentDir}/fonts/ */
function fontsRoot(): Directory {
  return new Directory(Paths.document, 'fonts');
}

/** Convert a file:// URI to a bare path for mbtiles:// protocol */
function uriToPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// ---------------------------------------------------------------------------
// Font glyph provisioning
// ---------------------------------------------------------------------------

/**
 * PBF glyph ranges bundled in the app binary.
 *
 * These are pre-downloaded via `npm run fetch:fonts` and live in
 * mobile/assets/fonts/Open Sans Regular/*.pbf.  At runtime we copy them
 * to {documentDir}/fonts/Open Sans Regular/ so that MapLibre can reference
 * them with a file:// glyphs URL.
 */
const GLYPH_RANGES = [
  '0-255',
  '256-511',
  '512-767',
  '768-1023',
  '7680-7935',
  '8192-8447',
  '8448-8703',
] as const;

/* eslint-disable @typescript-eslint/no-require-imports */
const GLYPH_ASSETS: Record<string, number> = {
  '0-255': require('../../assets/fonts/Open Sans Regular/0-255.pbf'),
  '256-511': require('../../assets/fonts/Open Sans Regular/256-511.pbf'),
  '512-767': require('../../assets/fonts/Open Sans Regular/512-767.pbf'),
  '768-1023': require('../../assets/fonts/Open Sans Regular/768-1023.pbf'),
  '7680-7935': require('../../assets/fonts/Open Sans Regular/7680-7935.pbf'),
  '8192-8447': require('../../assets/fonts/Open Sans Regular/8192-8447.pbf'),
  '8448-8703': require('../../assets/fonts/Open Sans Regular/8448-8703.pbf'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

let _glyphsProvisioned = false;

/**
 * Copy bundled PBF glyph files to the document directory so MapLibre
 * can load them offline.  Safe to call multiple times — skips if already done.
 *
 * Returns the filesystem path to the fonts root (no trailing slash).
 */
export async function provisionGlyphs(): Promise<string> {
  const destDir = new Directory(fontsRoot(), 'Open Sans Regular');

  if (!_glyphsProvisioned) {
    // Ensure directory tree exists
    const root = fontsRoot();
    if (!root.exists) root.create();
    if (!destDir.exists) destDir.create();

    for (const range of GLYPH_RANGES) {
      const destFile = new File(destDir, `${range}.pbf`);
      if (destFile.exists && (destFile.size ?? 0) > 100) continue;

      const asset = Asset.fromModule(GLYPH_ASSETS[range]);
      await asset.downloadAsync();
      if (asset.localUri) {
        const src = new File(asset.localUri);
        src.copy(destFile);
      }
    }

    // Create empty PBF files for all glyph ranges not covered by bundled fonts.
    // Offline tiles may contain CJK or other non-Latin text in place names;
    // without these fallback files MapLibre errors with "Failed to load glyph range".
    // An empty file is a valid protobuf meaning "no glyphs in this range".
    const emptyPbf = new Uint8Array(0);
    for (let start = 0; start < 65536; start += 256) {
      const range = `${start}-${start + 255}`;
      const file = new File(destDir, `${range}.pbf`);
      if (!file.exists) {
        file.write(emptyPbf);
      }
    }

    _glyphsProvisioned = true;
  }

  return uriToPath(fontsRoot().uri);
}

// ---------------------------------------------------------------------------
// Tile file status
// ---------------------------------------------------------------------------

export interface TileFileStatus {
  name: TileFileName;
  exists: boolean;
  sizeBytes: number;
}

export interface TrailTileStatus {
  trailId: string;
  files: TileFileStatus[];
  /** true when all expected tile files are present */
  complete: boolean;
  totalSizeBytes: number;
}

/** Check on-disk status for a trail's tiles. */
export function getTrailTileStatus(trailId: string): TrailTileStatus {
  const dir = trailTilesDir(trailId);
  const files: TileFileStatus[] = TILE_FILES.map((name) => {
    try {
      const file = new File(dir, name);
      if (file.exists) {
        return { name, exists: true, sizeBytes: file.size ?? 0 };
      }
    } catch {
      // file doesn't exist
    }
    return { name, exists: false, sizeBytes: 0 };
  });

  const complete = files.every((f) => f.exists && f.sizeBytes > 0);
  const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return { trailId, files, complete, totalSizeBytes };
}

// ---------------------------------------------------------------------------
// Tile download
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  fileName: TileFileName;
  done: boolean;
  error?: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Download tile files for a trail from a base URL.
 *
 * @param trailId  - Trail identifier (matches directory under tiles server)
 * @param baseUrl  - Base URL where tiles are hosted, e.g. "https://cdn.example.com/tiles"
 *                   Files are fetched from {baseUrl}/{trailId}/{fileName}
 * @param onProgress - Optional callback fired after each file completes
 */
export async function downloadTrailTiles(
  trailId: string,
  baseUrl: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  // Ensure directory hierarchy
  const root = tilesRoot();
  if (!root.exists) root.create();
  const dir = trailTilesDir(trailId);
  if (!dir.exists) dir.create();

  const url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  for (const name of TILE_FILES) {
    const dest = new File(dir, name);

    // Skip if already downloaded (simple size check)
    if (dest.exists && (dest.size ?? 0) > 1000) {
      onProgress?.({ fileName: name, done: true });
      continue;
    }

    const fileUrl = `${url}/${trailId}/${name}`;
    try {
      await File.downloadFileAsync(fileUrl, dest, {
        idempotent: true,
      });
      onProgress?.({ fileName: name, done: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Failed to download ${name} from ${fileUrl}: ${msg}`;
      console.error('[tile-service]', detail);
      onProgress?.({ fileName: name, done: false, error: detail });
      throw new Error(detail);
    }
  }
}

/** Delete all downloaded tile files for a trail. */
export function deleteTrailTiles(trailId: string): void {
  const dir = trailTilesDir(trailId);
  if (dir.exists) dir.delete();
}

// ---------------------------------------------------------------------------
// MapLibre style builder
// ---------------------------------------------------------------------------

/**
 * Build a MapLibre style JSON object for rendering a trail's offline tiles.
 *
 * Call `provisionGlyphs()` first to get the glyphsPath.
 *
 * @param trailId    - Trail whose tiles to reference
 * @param glyphsPath - Filesystem path to fonts root (from provisionGlyphs())
 * @returns Complete style object ready for JSON.stringify()
 */
export function buildTopoStyle(trailId: string, glyphsPath: string): object {
  const dir = trailTilesDir(trailId);
  const basePath = uriToPath(dir.uri);

  return {
    version: 8,
    name: 'Trail Companion Topo',
    sources: {
      basemap: {
        type: 'vector',
        url: `mbtiles://${basePath}/base.mbtiles`,
      },
      contour: {
        type: 'vector',
        url: `mbtiles://${basePath}/contours.mbtiles`,
      },
    },
    glyphs: `file://${glyphsPath}/{fontstack}/{range}.pbf`,
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#f8f4f0' },
      },
      {
        id: 'earth',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'earth',
        paint: { 'fill-color': '#f8f4f0' },
      },
      {
        id: 'landcover-grassland',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        filter: ['==', 'kind', 'grassland'],
        paint: { 'fill-color': '#d8e8c8', 'fill-opacity': 0.6 },
      },
      {
        id: 'landcover-forest',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        filter: ['==', 'kind', 'forest'],
        paint: { 'fill-color': '#aed1a0', 'fill-opacity': 0.5 },
      },
      {
        id: 'landcover-scrub',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        filter: ['==', 'kind', 'scrub'],
        paint: { 'fill-color': '#c8d7ab', 'fill-opacity': 0.4 },
      },
      {
        id: 'landuse-park',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        filter: [
          'in',
          'kind',
          'park',
          'national_park',
          'nature_reserve',
          'protected_area',
        ],
        paint: { 'fill-color': '#c8dfab', 'fill-opacity': 0.3 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': '#aad3df' },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'basemap',
        'source-layer': 'water',
        filter: ['in', 'kind_detail', 'river', 'stream', 'canal'],
        paint: {
          'line-color': '#aad3df',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 15, 2],
        },
      },
      {
        id: 'contour-regular',
        type: 'line',
        source: 'contour',
        'source-layer': 'contour',
        minzoom: 11,
        filter: ['!=', ['get', 'is_index'], 1],
        paint: {
          'line-color': 'rgb(179, 134, 89)',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            0.3,
            14,
            0.6,
          ],
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            0.15,
            14,
            0.35,
          ],
        },
      },
      {
        id: 'contour-index',
        type: 'line',
        source: 'contour',
        'source-layer': 'contour',
        minzoom: 9,
        filter: ['==', ['get', 'is_index'], 1],
        paint: {
          'line-color': 'rgb(166, 116, 66)',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            0.4,
            11,
            0.8,
            14,
            1.4,
          ],
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            0.1,
            11,
            0.25,
            14,
            0.5,
          ],
        },
      },
      {
        id: 'road-path',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['==', 'kind', 'path'],
        paint: {
          'line-color': '#b0a090',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0.5,
            15,
            1.5,
          ],
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['==', 'kind', 'minor_road'],
        paint: {
          'line-color': '#ffffff',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            0.5,
            15,
            2.5,
          ],
        },
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['==', 'kind', 'major_road'],
        paint: {
          'line-color': '#fefeb3',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.5,
            15,
            4,
          ],
        },
      },
      {
        id: 'road-highway',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['==', 'kind', 'highway'],
        paint: {
          'line-color': '#e9ac77',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            0.5,
            15,
            6,
          ],
        },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'buildings',
        minzoom: 13,
        paint: { 'fill-color': '#d9d0c9', 'fill-opacity': 0.7 },
      },
      {
        id: 'contour-label',
        type: 'symbol',
        source: 'contour',
        'source-layer': 'contour',
        minzoom: 11,
        filter: ['==', ['get', 'is_index'], 1],
        layout: {
          'symbol-placement': 'line',
          'text-field': [
            'concat',
            ['to-string', ['get', 'elevation']],
            'm',
          ],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            9,
            14,
            11,
          ],
          'text-max-angle': 25,
          'text-padding': 150,
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': 'rgb(131, 66, 37)',
          'text-halo-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-village',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        filter: ['==', 'kind_detail', 'village'],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#333',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-town',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        filter: ['==', 'kind_detail', 'town'],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 14,
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#333',
          'text-halo-color': '#fff',
          'text-halo-width': 2,
        },
      },
      {
        id: 'place-city',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        filter: ['in', 'kind_detail', 'city', 'metropolis'],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 16,
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#222',
          'text-halo-color': '#fff',
          'text-halo-width': 2,
        },
      },
      {
        id: 'peak',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'pois',
        filter: ['==', 'kind', 'peak'],
        layout: {
          'text-field': [
            'concat',
            ['get', 'name'],
            '\n',
            ['get', 'elevation'],
          ],
          'text-size': 11,
          'text-anchor': 'center',
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#6a4c30',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      },
    ],
  };
}
