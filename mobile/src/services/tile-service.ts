/**
 * Tile download and management service.
 *
 * Handles downloading MBTiles files from a server, tracking what's on disk,
 * building MapLibre style JSON with correct mbtiles:// source URLs and
 * local glyph paths, and cleaning up downloaded tiles.
 */
import { File, Directory } from 'expo-file-system';
import { Asset } from 'expo-asset';
import { openDatabaseAsync } from 'expo-sqlite';
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
 * reports `partial` rather than a false-positive `complete`. Tiles with no
 * manifest fall back to a presence heuristic.
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
    // No manifest to verify against (legacy tiles).
    state = allPresent ? 'complete' : anyPresent ? 'partial' : 'absent';
  }

  return { trailId, files, complete: state === 'complete', state, totalSizeBytes, version };
}

// ---------------------------------------------------------------------------
// MBTiles validation
// ---------------------------------------------------------------------------

export interface MbtilesValidation {
  ok: boolean;
  /** Human-readable reason when ok is false */
  reason?: string;
}

/**
 * Values MapLibre native parses numerically from the mbtiles metadata table.
 * A non-numeric (or empty) value makes std::stoi/std::stod throw on the
 * MBTilesFileSource thread, which aborts the whole process — it cannot be
 * caught from JS. See maplibre-native mbtiles_file_source.cpp.
 */
const INT_RE = /^\d+$/;

function isFiniteNumberString(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * Structurally validate a downloaded .mbtiles file before it is ever handed
 * to MapLibre as an mbtiles:// source.
 *
 * MapLibre native builds a TileJSON from the file when the source loads:
 * it stoi()s minzoom/maxzoom metadata (falling back to
 * `SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles`, which is NULL on an
 * empty tiles table), stod()s scale and each comma-separated bounds part.
 * In the bundled maplibre-native (11.x) any of those throwing crashes the
 * app with SIGABRT, so everything it parses is checked here first.
 * A corrupt database (queries throw) also fails validation.
 */
export async function validateMbtiles(
  trailId: string,
  fileName: TileFileName,
): Promise<MbtilesValidation> {
  const dirPath = uriToPath(trailTilesDir(trailId).uri);
  let db: Awaited<ReturnType<typeof openDatabaseAsync>> | null = null;
  try {
    db = await openDatabaseAsync(fileName, { useNewConnection: true }, dirPath);
    await db.execAsync('PRAGMA query_only = ON;');

    // Any row at all — an empty tiles table renders nothing and, when zoom
    // metadata is also missing, crashes MapLibre's MIN/MAX zoom fallback.
    const anyTile = await db.getFirstAsync<{ zoom_level: number }>(
      'SELECT zoom_level FROM tiles LIMIT 1',
    );
    if (anyTile == null) {
      return { ok: false, reason: 'no tiles in tiles table' };
    }

    const metaRows = await db.getAllAsync<{ name: string; value: string }>(
      "SELECT name, value FROM metadata WHERE name IN ('minzoom', 'maxzoom', 'scale', 'bounds')",
    );
    for (const row of metaRows) {
      const value = row.value ?? '';
      if (row.name === 'minzoom' || row.name === 'maxzoom') {
        if (!INT_RE.test(value)) {
          return { ok: false, reason: `metadata ${row.name} is not an integer: "${value}"` };
        }
      } else if (row.name === 'scale') {
        if (!isFiniteNumberString(value)) {
          return { ok: false, reason: `metadata scale is not a number: "${value}"` };
        }
      } else if (row.name === 'bounds') {
        const parts = value.split(',');
        if (parts.length !== 4 || !parts.every(isFiniteNumberString)) {
          return { ok: false, reason: `metadata bounds is malformed: "${value}"` };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  } finally {
    try {
      await db?.closeAsync();
    } catch {
      // closing a broken database can itself throw; nothing to do
    }
  }
}

/**
 * Cache of validation results keyed by trailId/fileName/size so the map
 * screen doesn't reopen the database on every style build. The size in the
 * key invalidates the entry when the file is re-downloaded or truncated.
 */
const validationCache = new Map<string, MbtilesValidation>();

export async function validateMbtilesCached(
  trailId: string,
  fileName: TileFileName,
): Promise<MbtilesValidation> {
  let size = 0;
  try {
    const file = new File(trailTilesDir(trailId), fileName);
    size = file.exists ? file.size ?? 0 : 0;
  } catch {
    size = 0;
  }
  const key = `${trailId}/${fileName}:${size}`;
  const cached = validationCache.get(key);
  if (cached) return cached;

  const result = await validateMbtiles(trailId, fileName);
  validationCache.set(key, result);
  return result;
}

/** Drop cached validation results (all trails, or one trail's files). */
export function clearMbtilesValidationCache(trailId?: string): void {
  if (trailId == null) {
    validationCache.clear();
    return;
  }
  for (const key of validationCache.keys()) {
    if (key.startsWith(`${trailId}/`)) validationCache.delete(key);
  }
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

    // Skip if already downloaded, matches expected size (or reasonable
    // fallback), and passes structural validation — a previously downloaded
    // bad file must not survive a re-download just because its size matches.
    if (dest.exists) {
      const size = dest.size ?? 0;
      const sizeOk = expectedSize ? size === expectedSize : size > 1000;
      if (sizeOk && (await validateMbtilesCached(trailId, name)).ok) {
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

      // Validate structure before accepting the file: a bad mbtiles handed to
      // MapLibre crashes the app natively, so refuse it at download time.
      clearMbtilesValidationCache(trailId);
      const validation = await validateMbtiles(trailId, name);
      if (!validation.ok) {
        try {
          dest.delete();
        } catch {
          // leave a partial file; size check will flag it next time
        }
        throw new Error(`${name} is not a usable tile database (${validation.reason})`);
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
  clearMbtilesValidationCache(trailId);
}

// ---------------------------------------------------------------------------
// MapLibre style builder
// ---------------------------------------------------------------------------

// Single source of truth: scripts/topo-style.json, copied to mobile/assets/
const TOPO_STYLE_TEMPLATE = require('../../assets/topo-style.json');

export interface TopoStyleOptions {
  /**
   * Include the contour source and layers (default true). Set false when
   * contours.mbtiles failed validation so the basemap still renders offline
   * instead of MapLibre crashing on a bad contour source.
   */
  includeContours?: boolean;
}

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
 * @param options    - See TopoStyleOptions
 * @returns Complete style object ready for JSON.stringify()
 */
export function buildTopoStyle(
  trailId: string,
  glyphsPath: string,
  options?: TopoStyleOptions,
): object {
  const includeContours = options?.includeContours ?? true;
  const dir = trailTilesDir(trailId);
  const basePath = uriToPath(dir.uri);

  // Deep clone the template to avoid mutating the bundled module
  const style = JSON.parse(JSON.stringify(TOPO_STYLE_TEMPLATE));

  // Interpolate source URLs
  style.sources.basemap.url = `mbtiles://${basePath}/base.mbtiles`;
  if (includeContours) {
    style.sources.contour.url = `mbtiles://${basePath}/contours.mbtiles`;
  } else {
    delete style.sources.contour;
    style.layers = style.layers.filter(
      (layer: { source?: string }) => layer.source !== 'contour',
    );
  }

  // Interpolate glyph path
  style.glyphs = `file://${glyphsPath}/{fontstack}/{range}.pbf`;

  return style;
}
