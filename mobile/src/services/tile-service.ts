/**
 * Tile download and management service.
 *
 * Handles downloading MBTiles files from a server, tracking what's on disk,
 * building MapLibre style JSON with correct mbtiles:// source URLs and
 * local glyph paths, and cleaning up downloaded tiles.
 */
import { File, Directory, Paths } from 'expo-file-system';
import { Asset } from 'expo-asset';
import type { TileManifest } from '@lib/types';
import {
  TILE_FILES,
  type TileFileName,
  tilesRoot,
  trailTilesDir,
  fontsRoot,
  uriToPath,
  manifestFile,
} from './tile-paths';

export type { TileFileName };

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

/**
 * Tri-state offline-tile readiness:
 * - `complete` — all tiles present and, when a manifest with expected sizes is
 *   available, every file's on-disk size matches. Safe to report "Offline maps ✓".
 * - `partial`  — some tiles present but the set is incomplete, or a file's size
 *   does not match the manifest (e.g. a download killed mid-file leaves a
 *   truncated file). NOT safe to use offline; the UI should offer re-download.
 * - `absent`   — no tiles on disk.
 */
export type TileStatusState = 'complete' | 'partial' | 'absent';

export interface TrailTileStatus {
  trailId: string;
  files: TileFileStatus[];
  /** Convenience flag equal to `state === 'complete'`. */
  complete: boolean;
  /** Tri-state readiness (see TileStatusState). */
  state: TileStatusState;
  totalSizeBytes: number;
  /** Version string from downloaded manifest, if available */
  version?: string;
}

/**
 * Check on-disk status for a trail's tiles.
 *
 * When a manifest is present (written by downloadTrailTiles before the download
 * starts, so an interrupted download is detectable) the actual file sizes are
 * verified against the manifest's expected sizes. A truncated or missing file
 * reports `partial` rather than the old false-positive `complete`. Custom-trail
 * grid downloads carry no manifest, so they fall back to a presence heuristic.
 */
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

  const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const anyPresent = files.some((f) => f.exists && f.sizeBytes > 0);
  const allPresent = files.every((f) => f.exists && f.sizeBytes > 0);

  // Read the saved manifest for the version string and expected file sizes.
  let version: string | undefined;
  let expectedSizes: Map<string, number> | null = null;
  const mf = manifestFile(trailId);
  if (mf.exists) {
    try {
      const parsed = JSON.parse(mf.textSync()) as TileManifest;
      version = parsed.version;
      if (Array.isArray(parsed.files) && parsed.files.length > 0) {
        expectedSizes = new Map(parsed.files.map((f) => [f.name, f.size]));
      }
    } catch {
      // corrupt manifest, ignore
    }
  }

  let state: TileStatusState;
  if (expectedSizes) {
    // Verify every expected tile is present at exactly its recorded size.
    const verified = files.every((f) => {
      const expected = expectedSizes!.get(f.name);
      return expected != null && f.exists && f.sizeBytes === expected;
    });
    state = verified ? 'complete' : anyPresent ? 'partial' : 'absent';
  } else {
    // No manifest to verify against (custom grid downloads, legacy tiles).
    state = allPresent ? 'complete' : anyPresent ? 'partial' : 'absent';
  }

  return { trailId, files, complete: state === 'complete', state, totalSizeBytes, version };
}

// ---------------------------------------------------------------------------
// Tile download
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  /** Current file being downloaded */
  fileName: TileFileName;
  /** Whether this file is done */
  done: boolean;
  /** Error message if download failed */
  error?: string;
  /** Bytes downloaded so far (across all files) */
  bytesDownloaded: number;
  /** Total bytes expected (from manifest, 0 if unknown) */
  bytesTotal: number;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/** Options for downloadTrailTiles */
export interface DownloadOptions {
  /** Called after each file completes with byte-level totals */
  onProgress?: ProgressCallback;
  /** Set to true to cancel the download between files */
  signal?: { cancelled: boolean };
}

/**
 * Fetch the manifest for a trail. Returns null if not available.
 */
async function fetchManifest(
  baseUrl: string,
  trailId: string,
): Promise<TileManifest | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/${trailId}/manifest.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as TileManifest;
  } catch {
    return null;
  }
}

/**
 * Check if a remote manifest has a newer version than what's on disk.
 */
export async function checkForTileUpdate(
  trailId: string,
  baseUrl: string,
): Promise<{ updateAvailable: boolean; localVersion?: string; remoteVersion?: string }> {
  const local = getTrailTileStatus(trailId);
  const remote = await fetchManifest(baseUrl, trailId);

  if (!remote) return { updateAvailable: false, localVersion: local.version };
  if (!local.complete) return { updateAvailable: true, remoteVersion: remote.version };
  if (!local.version) return { updateAvailable: true, remoteVersion: remote.version };

  return {
    updateAvailable: remote.version !== local.version,
    localVersion: local.version,
    remoteVersion: remote.version,
  };
}

/**
 * Download tile files for a trail from a base URL.
 *
 * Fetches the manifest first for size validation, supports cancellation
 * between files, and provides byte-level progress totals.
 *
 * @param trailId  - Trail identifier (matches directory under tiles server)
 * @param baseUrl  - Base URL where tiles are hosted, e.g. "https://cdn.example.com/tiles"
 *                   Files are fetched from {baseUrl}/{trailId}/{fileName}
 * @param optionsOrCallback - DownloadOptions, or legacy ProgressCallback for compat
 */
export async function downloadTrailTiles(
  trailId: string,
  baseUrl: string,
  optionsOrCallback?: DownloadOptions | ProgressCallback,
): Promise<void> {
  // Support both new options object and legacy callback signature
  const opts: DownloadOptions =
    typeof optionsOrCallback === 'function'
      ? { onProgress: optionsOrCallback }
      : optionsOrCallback ?? {};

  const { onProgress, signal } = opts;

  // Ensure directory hierarchy
  const root = tilesRoot();
  if (!root.exists) root.create();
  const dir = trailTilesDir(trailId);
  if (!dir.exists) dir.create();

  const url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  // Fetch manifest for size info and post-download validation
  const manifest = await fetchManifest(url, trailId);
  const expectedSizes = new Map<string, number>();
  let bytesTotal = 0;
  if (manifest) {
    for (const f of manifest.files) {
      expectedSizes.set(f.name, f.size);
      bytesTotal += f.size;
    }
    // Persist the manifest up-front (before any file lands) so an interrupted
    // download is detectable: getTrailTileStatus verifies on-disk sizes against
    // these expected sizes and reports a truncated/missing file as 'partial'
    // instead of a false-positive 'complete'.
    manifestFile(trailId).write(JSON.stringify(manifest));
  }

  let bytesDownloaded = 0;

  for (const name of TILE_FILES) {
    // Check cancellation
    if (signal?.cancelled) {
      throw new Error('Cancelled');
    }

    const dest = new File(dir, name);
    const expectedSize = expectedSizes.get(name);

    // Skip if already downloaded and matches expected size (or reasonable fallback)
    if (dest.exists) {
      const size = dest.size ?? 0;
      if (expectedSize ? size === expectedSize : size > 1000) {
        bytesDownloaded += size;
        onProgress?.({ fileName: name, done: true, bytesDownloaded, bytesTotal });
        continue;
      }
    }

    const fileUrl = `${url}/${trailId}/${name}`;
    try {
      await File.downloadFileAsync(fileUrl, dest, {
        idempotent: true,
      });

      // Validate downloaded size against manifest
      const downloadedSize = dest.size ?? 0;
      if (expectedSize && downloadedSize !== expectedSize) {
        throw new Error(
          `Size mismatch for ${name}: expected ${expectedSize} bytes, got ${downloadedSize}`,
        );
      }

      bytesDownloaded += downloadedSize;
      onProgress?.({ fileName: name, done: true, bytesDownloaded, bytesTotal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Failed to download ${name} from ${fileUrl}: ${msg}`;
      console.error('[tile-service]', detail);
      onProgress?.({ fileName: name, done: false, error: detail, bytesDownloaded, bytesTotal });
      throw new Error(detail);
    }
  }
  // The manifest was written up-front (see above); once every file has landed
  // at its expected size, getTrailTileStatus will report 'complete'.
}

/** Delete all downloaded tile files for a trail. */
export function deleteTrailTiles(trailId: string): void {
  const dir = trailTilesDir(trailId);
  if (dir.exists) dir.delete();
}

// ---------------------------------------------------------------------------
// MapLibre style builder
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
// Single source of truth: scripts/topo-style.json, copied to mobile/assets/
const TOPO_STYLE_TEMPLATE = require('../../assets/topo-style.json');
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Build a MapLibre style JSON object for rendering a trail's offline tiles.
 *
 * Loads the shared topo-style.json template and interpolates local file paths
 * for mbtiles:// sources and file:// glyph URLs.
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

  // Deep clone the template to avoid mutating the bundled module
  const style = JSON.parse(JSON.stringify(TOPO_STYLE_TEMPLATE));

  // Interpolate source URLs
  style.sources.basemap.url = `mbtiles://${basePath}/base.mbtiles`;
  style.sources.contour.url = `mbtiles://${basePath}/contours.mbtiles`;

  // Interpolate glyph path
  style.glyphs = `file://${glyphsPath}/{fontstack}/{range}.pbf`;

  return style;
}
