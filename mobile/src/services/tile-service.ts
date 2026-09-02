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
// Type-only (erased at build): the map's palette vocabulary lives with the rest
// of the map cartography, and map-style already takes TileStatusState from here.
import type { MapTheme } from '../features/map/map-style';
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
        // expo-file-system 56 made File.copy() async (copySync() is the old
        // behaviour). Left unawaited, MapLibre could be pointed at a glyph
        // directory whose .pbf files are still being written.
        await src.copy(destFile);
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
 * When a manifest is present the actual file sizes are verified against the
 * manifest's expected sizes. A truncated or missing file reports `partial`
 * rather than a false-positive `complete`. Tiles with no manifest fall back to
 * a presence heuristic.
 *
 * Only the canonical TILE_FILES names are inspected, so in-flight `.part`
 * downloads never contribute to the reported state or to totalSizeBytes.
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
  // The whole read — including the existence probe — is guarded: this is called
  // for ids that were never downloaded and may never be downloadable (a user-
  // imported `u_` guide has no pack of its own), and "no pack on disk" has to
  // report `absent`, never throw into the caller's render.
  let version: string | undefined;
  let expectedSizes: Map<string, number> | null = null;
  try {
    const mf = manifestFile(trailId);
    if (mf.exists) {
      const parsed = JSON.parse(mf.textSync()) as TileManifest;
      version = parsed.version;
      if (Array.isArray(parsed.files) && parsed.files.length > 0) {
        expectedSizes = new Map(parsed.files.map((f) => [f.name, f.size]));
      }
    }
  } catch {
    // missing directory or corrupt manifest — treat as unverifiable
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
 * Any of those throwing crashes the app with SIGABRT, so everything it parses
 * is checked here first. A corrupt database (queries throw) also fails
 * validation.
 *
 * The bundled maplibre-native moved with MapLibre RN 11 (Android 11.12.1 →
 * 13.2.0, iOS 6.17.1 → 6.26.0). The parse-and-abort path is unchanged upstream,
 * and these guards are cheap, so they stay — but they are the reason an empty
 * or truncated pack has to be re-checked on a real device after any native
 * bump, since the failure is a process abort JS never sees.
 */
export async function validateMbtiles(
  trailId: string,
  fileName: TileFileName,
): Promise<MbtilesValidation> {
  return validateMbtilesFile(trailId, fileName);
}

/**
 * Internal generalisation of {@link validateMbtiles} that accepts any file name
 * inside the trail's tile directory — notably the `{name}.part` staging files
 * written by downloadTrailTiles, which must be validated *before* they are
 * renamed over the live file.
 */
async function validateMbtilesFile(
  trailId: string,
  fileName: string,
): Promise<MbtilesValidation> {
  // openDatabaseAsync CREATES an empty SQLite database when the path is
  // missing, which would turn "file absent" into "file present but empty" —
  // an mbtiles with no tiles table, i.e. exactly the shape that SIGABRTs
  // MapLibre. Never open a database for a file that isn't there.
  let fileExists = false;
  try {
    fileExists = new File(trailTilesDir(trailId), fileName).exists;
  } catch {
    fileExists = false;
  }
  if (!fileExists) {
    return { ok: false, reason: 'file does not exist' };
  }

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

/** Suffix for in-flight downloads staged alongside their final destination. */
const PART_SUFFIX = '.part';

/**
 * Result of comparing a file against a manifest MD5 digest.
 *
 * `skipped` covers the two cases where there is nothing to compare: a legacy
 * manifest with no `md5` field, and a platform that cannot produce a digest
 * (the property is null/absent). Both fall back to the size + structural
 * checks that gated downloads before content addressing.
 */
type Md5Verdict = 'match' | 'mismatch' | 'skipped';

/**
 * Compare a file's MD5 against a manifest digest.
 *
 * The digest comes from `File.md5` (expo-file-system SDK 54), which hashes the
 * file natively — hashing 100MB of mbtiles in JS would be far too slow, which
 * is why the manifest carries an md5 for the device alongside the sha256 used
 * by the build tooling.
 */
function checkMd5(file: File, expected?: string): { verdict: Md5Verdict; actual: string | null } {
  if (!expected) return { verdict: 'skipped', actual: null };

  let actual: string | null = null;
  try {
    const value = (file as { md5?: string | null }).md5;
    actual = typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
  } catch {
    actual = null;
  }

  if (actual == null) return { verdict: 'skipped', actual: null };
  return { verdict: actual === expected.toLowerCase() ? 'match' : 'mismatch', actual };
}

/** Best-effort removal of a staging file; never throws. */
function deletePart(dir: Directory, name: TileFileName): void {
  try {
    const part = new File(dir, `${name}${PART_SUFFIX}`);
    if (part.exists) part.delete();
  } catch {
    // A stray .part is inert — TILE_FILES-driven status ignores it, and the
    // next download overwrites it. Nothing useful to do on failure.
  }
}

/**
 * Download tile files for a trail from a base URL.
 *
 * Downloads are **atomic**: each file lands at `{name}.part`, is size- and
 * structure-checked there, and is only renamed over the live `{name}` once
 * every file in the set has been fetched and validated. This means
 *
 *  - MapLibre never sees a half-written mbtiles (a torn read aborts natively);
 *  - an interrupted or failed *update* leaves the previous, working pack —
 *    files *and* manifest — completely untouched, so getTrailTileStatus keeps
 *    reporting 'complete';
 *  - the window in which the on-disk set mixes old and new files is one
 *    rename per file rather than one download per file.
 *
 * The manifest is promoted last for updates. For a *fresh* download (no
 * complete pack on disk yet) it is still written up-front, so that an
 * interrupted first download is detectable as 'partial' rather than being
 * mistaken for a legacy manifest-less pack.
 *
 * Fetches the manifest first for size, MD5 and remote-key information,
 * supports cancellation between files, and provides byte-level progress totals.
 *
 * @param trailId  - Trail identifier (matches directory under tiles server)
 * @param baseUrl  - Base URL where tiles are hosted, e.g. "https://cdn.example.com/tiles"
 *                   Files are fetched from {baseUrl}/{trailId}/{key ?? fileName}
 *                   and always stored on device under {fileName}
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

  // Is there already a usable pack here? If so this is an *update*, and the
  // existing manifest must survive untouched until the new files are in place.
  const isUpdate = getTrailTileStatus(trailId).state === 'complete';

  // Clear staging files left behind by an earlier interrupted run.
  for (const name of TILE_FILES) deletePart(dir, name);

  // Fetch manifest for size info and post-download validation
  const manifest = await fetchManifest(url, trailId);
  const expectedSizes = new Map<string, number>();
  /** Manifest MD5 digests, keyed by logical (on-device) file name. */
  const expectedMd5 = new Map<string, string>();
  /**
   * Remote object keys, keyed by logical file name. Content-addressed manifests
   * publish each file at `{name}.{hash}.{ext}` so a new upload never overwrites
   * the object an older manifest still points at; legacy manifests have no
   * `key` and are fetched under their plain name.
   */
  const remoteKeys = new Map<string, string>();
  let bytesTotal = 0;
  if (manifest) {
    for (const f of manifest.files) {
      expectedSizes.set(f.name, f.size);
      if (f.md5) expectedMd5.set(f.name, f.md5);
      if (f.key) remoteKeys.set(f.name, f.key);
      bytesTotal += f.size;
    }
    if (!isUpdate) {
      // Fresh download: persist the manifest up-front (before any file lands)
      // so an interrupted download is detectable. getTrailTileStatus verifies
      // on-disk sizes against these expected sizes and reports a
      // truncated/missing file as 'partial' instead of a false-positive
      // 'complete'. There is no older pack to invalidate.
      manifestFile(trailId).write(JSON.stringify(manifest));
    }
    // Update: the new manifest is staged in memory and written only after every
    // file has downloaded, validated and been renamed into place. Writing it
    // now would make the *old* files mismatch the *new* sizes, downgrading a
    // perfectly good pack to 'partial' the moment anything goes wrong.
  }

  let bytesDownloaded = 0;

  /** Files fetched this run, staged at {name}.part, awaiting promotion. */
  const staged: TileFileName[] = [];

  const cleanupStaged = () => {
    for (const name of TILE_FILES) deletePart(dir, name);
    staged.length = 0;
  };

  // ---- Phase 1: download + validate every file into its .part staging path --
  for (const name of TILE_FILES) {
    // Check cancellation
    if (signal?.cancelled) {
      cleanupStaged();
      throw new Error('Cancelled');
    }

    const dest = new File(dir, name);
    const expectedSize = expectedSizes.get(name);
    const md5 = expectedMd5.get(name);

    // Skip if already downloaded, matches expected size (or reasonable
    // fallback), and passes structural validation — a previously downloaded
    // bad file must not survive a re-download just because its size matches.
    //
    // The digest is checked here too when the manifest has one: this branch is
    // what makes the user's "Re-download" a no-op, so trusting size alone would
    // let a same-size-but-wrong-content file survive the very action meant to
    // repair it. It costs one native hash per already-present file per
    // *download attempt* (not per status check), and it doubles as the "this
    // file is unchanged between manifest versions" test that lets an update
    // skip re-fetching bytes it already has.
    if (dest.exists) {
      const size = dest.size ?? 0;
      const sizeOk = expectedSize ? size === expectedSize : size > 1000;
      const hashOk = checkMd5(dest, md5).verdict !== 'mismatch';
      if (sizeOk && hashOk && (await validateMbtilesCached(trailId, name)).ok) {
        bytesDownloaded += size;
        onProgress?.({ fileName: name, done: true, bytesDownloaded, bytesTotal });
        continue;
      }
    }

    const partName = `${name}${PART_SUFFIX}`;
    const part = new File(dir, partName);
    // Content-addressed manifests point at an immutable remote key; the file is
    // always *stored* under its plain logical name.
    const fileUrl = `${url}/${trailId}/${remoteKeys.get(name) ?? name}`;
    try {
      // Download to a temp name in the same directory (same filesystem, so the
      // later promotion is a cheap rename) rather than over the live file,
      // which MapLibre native may currently have open.
      await File.downloadFileAsync(fileUrl, part, {
        idempotent: true,
      });

      // Validate downloaded size against manifest
      const downloadedSize = part.size ?? 0;
      if (expectedSize && downloadedSize !== expectedSize) {
        throw new Error(
          `Size mismatch for ${name}: expected ${expectedSize} bytes, got ${downloadedSize}`,
        );
      }

      // Verify content integrity before anything else looks at the bytes: a
      // truncated-but-plausible or man-in-the-middled file can still be a
      // structurally valid sqlite database. Same failure path as a size
      // mismatch — the .part is discarded and the old pack stays in place.
      const { verdict, actual } = checkMd5(part, md5);
      if (verdict === 'mismatch') {
        throw new Error(`Checksum mismatch for ${name}: expected MD5 ${md5}, got ${actual}`);
      }
      if (verdict === 'skipped' && md5) {
        console.warn(
          `[tile-service] no MD5 available for ${name} on this platform; ` +
            'accepting the download on size and structure alone.',
        );
      }

      // Validate structure before accepting the file: a bad mbtiles handed to
      // MapLibre crashes the app natively, so refuse it at download time —
      // while it is still a .part and the previous good file is untouched.
      const validation = await validateMbtilesFile(trailId, partName);
      if (!validation.ok) {
        throw new Error(`${name} is not a usable tile database (${validation.reason})`);
      }

      staged.push(name);
      bytesDownloaded += downloadedSize;
      onProgress?.({ fileName: name, done: true, bytesDownloaded, bytesTotal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Failed to download ${name} from ${fileUrl}: ${msg}`;
      console.error('[tile-service]', detail);
      // Discard every staging file: the old pack (files + manifest) is still
      // intact on disk and must stay the version the app uses.
      cleanupStaged();
      onProgress?.({ fileName: name, done: false, error: detail, bytesDownloaded, bytesTotal });
      throw new Error(detail);
    }
  }

  // ---- Phase 2: promote all validated .part files at once -------------------
  try {
    for (const name of staged) {
      const dest = new File(dir, name);
      // rename()/move() reject an existing destination on both platforms, so
      // unlink first. An fd MapLibre already holds keeps the old inode alive,
      // so this cannot tear a read in progress.
      if (dest.exists) dest.delete();
      new File(dir, `${name}${PART_SUFFIX}`).rename(name);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = `Failed to install downloaded tiles for ${trailId}: ${msg}`;
    console.error('[tile-service]', detail);
    cleanupStaged();
    throw new Error(detail);
  }

  // Contents at these paths changed — drop any cached validation verdicts.
  if (staged.length > 0) clearMbtilesValidationCache(trailId);

  // ---- Phase 3: promote the manifest ---------------------------------------
  // Only now does getTrailTileStatus start comparing against the new sizes.
  if (manifest && isUpdate) {
    manifestFile(trailId).write(JSON.stringify(manifest));
  }
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
/**
 * Dark palette for that template: `{ [layerId]: paintOverrides }`, merged over
 * the matching layer's paint block. It carries no structure of its own — no
 * sources, no filters, no layer order — so contour tiers and layer ordering stay
 * single-sourced in topo-style.json and only the colours are stated twice.
 * A layer with no entry keeps its light paint (see `topo-style-dark.json`).
 */
const TOPO_STYLE_DARK_PALETTE = require('../../assets/topo-style-dark.json');

export interface TopoStyleOptions {
  /**
   * Include the contour source and layers (default true). Set false when
   * contours.mbtiles failed validation so the basemap still renders offline
   * instead of MapLibre crashing on a bad contour source.
   */
  includeContours?: boolean;
  /**
   * Which palette to paint the basemap in (default 'light'). The offline map
   * follows the app theme; see MapTheme in features/map/map-style.
   */
  theme?: MapTheme;
}

/**
 * Merge the dark palette's paint overrides into an already-cloned style.
 *
 * Unknown layer ids are ignored rather than throwing: the palette is data, and
 * a stale entry must not be able to blank the offline map on a device. A test
 * asserts every id in the palette exists in the template, which is where that
 * drift is meant to be caught.
 */
function applyDarkPalette(style: { layers: { id: string; paint?: Record<string, unknown> }[] }): void {
  for (const layer of style.layers) {
    const overrides = (TOPO_STYLE_DARK_PALETTE as Record<string, Record<string, unknown>>)[layer.id];
    if (!overrides) continue;
    layer.paint = { ...(layer.paint ?? {}), ...overrides };
  }
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
  const theme = options?.theme ?? 'light';
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

  // Repaint last, so a dropped contour source can never leave dark overrides
  // attached to a layer that is no longer there.
  if (theme === 'dark') applyDarkPalette(style);

  return style;
}
