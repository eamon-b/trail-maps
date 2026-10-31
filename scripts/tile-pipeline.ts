/**
 * Shared tile pipeline functions.
 *
 * Extracted from build-tiles.ts so that the trail-corridor packs, the
 * Australia contour archive and the world contour build can share them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, execFileSync, type ExecSyncOptions } from 'child_process';
import type { TileManifest, TileManifestFile } from '../src/lib/types.js';

// --- Path setup ---

const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
export const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const DEM_CACHE_DIR = path.join(PROJECT_ROOT, 'data/dem');

// --- Constants ---

export const MIN_ZOOM = 4;
export const MAX_ZOOM = 15;
/**
 * Lowest zoom contour tiles are generated at.
 *
 * This is the single source of truth: it is interpolated into the tippecanoe
 * `-Z` flag AND used as the validation expectation for contours.mbtiles.
 * Keeping them linked is deliberate — heysen's contours were once built
 * without `-Z9`, producing z0–z8 tiles that every validator of the day passed.
 */
export const CONTOUR_MIN_ZOOM = 9;
export const CONTOUR_INTERVAL = 10; // metres
export const INDEX_CONTOUR_INTERVAL = 50; // metres (bold lines)
/**
 * Warp resolution for contour generation. The source DEM is 1 arc-second
 * (~30m, 0.000278°); warping at 2x that density with cubicspline resampling
 * interpolates smooth curves between the 30m samples, so gdal_contour traces
 * rounded contours instead of polygonal lines on the DEM lattice. Costs 4x
 * the pixels. build-contours-world.ts warps at the same resolution, so
 * offline and worker-served contours line up at identical elevations.
 */
export const CONTOUR_WARP_TR_DEG = 0.000139;

/**
 * One zoom tier of the chunked contour builds: a `WHERE` clause selecting the
 * elevations that first appear at `minZoom`, written to `{cellId}_{suffix}.fgb`
 * and handed to tippecanoe as a `-L` layer with that minzoom.
 */
export interface ContourTier {
  suffix: string;
  minZoom: number;
  where: string;
}

/**
 * Contour density tiers, shared by build-contours-world.ts and the per-trail
 * packs. The packs must show what the Worker serves online, so their tiers
 * must not drift: this is the single definition of which elevations appear at
 * which zoom.
 *
 * The clauses partition the elevations exactly once each — see the z13 note.
 */
export const CONTOUR_TIERS: ContourTier[] = [
  { suffix: 'z9', minZoom: CONTOUR_MIN_ZOOM, where: `(CAST(elevation AS INTEGER) % 100) = 0` },
  {
    suffix: 'z10',
    minZoom: 10,
    where: `(CAST(elevation AS INTEGER) % 50) = 0 AND (CAST(elevation AS INTEGER) % 100) != 0`,
  },
  {
    suffix: 'z12',
    minZoom: 12,
    where: `(CAST(elevation AS INTEGER) % 20) = 0 AND (CAST(elevation AS INTEGER) % 50) != 0`,
  },
  // %50 != 0 as well: odd multiples of 50 (50, 150, ...) have %20 = 10 and are
  // already emitted by the z10 tier — without it they'd appear twice.
  {
    suffix: 'z13',
    minZoom: 13,
    where: `(CAST(elevation AS INTEGER) % 20) != 0 AND (CAST(elevation AS INTEGER) % 50) != 0`,
  },
];

/** The one vector-tile layer every contour archive serves (public schema). */
export const CONTOUR_LAYER = 'contour';

/**
 * The layer name a tier is tiled under *inside tippecanoe*: `contour_z9`,
 * `contour_z10`, … — never the name a tile is served with.
 *
 * tippecanoe has no per-input zoom range: the `-L {"file", "layer"}` object
 * takes no `minzoom` key (it was silently ignored by every build before
 * 2026-10, so each tile at z9–z12 carried every 10 m contour, blew its byte
 * budget and had its lines dropped and coarsened — the "jagged when zoomed
 * out" contours). The only per-feature gate it offers is the `-j` feature
 * filter, which is keyed by layer name and may test `$zoom`. So each tier is
 * read as its own layer, `contourTierFilter()` lets it into a tile only from
 * its minzoom, and `renameContourTiers()` (tile-join `-R`) folds the layers
 * back into the one `contour` layer before anything is served or shipped.
 */
export function contourTierLayer(tier: ContourTier): string {
  return `${CONTOUR_LAYER}_${tier.suffix}`;
}

/** The tippecanoe `-L` JSON for one tier file. */
export function contourTierLayerArg(filePath: string, tier: ContourTier): string {
  return JSON.stringify({ file: filePath, layer: contourTierLayer(tier) });
}

/**
 * The tippecanoe `-j` feature filter that admits each tier from its minzoom.
 * A tier that starts at the archive's minzoom needs no rule: a layer the
 * filter does not name passes through at every zoom.
 */
export function contourTierFilter(tiers: ContourTier[] = CONTOUR_TIERS): string {
  const filter: Record<string, unknown> = {};
  for (const tier of tiers) {
    if (tier.minZoom > CONTOUR_MIN_ZOOM) {
      filter[contourTierLayer(tier)] = ['>=', '$zoom', tier.minZoom];
    }
  }
  return JSON.stringify(filter);
}

/** tile-join `-R old:new` pairs folding every tier layer into `contour`. */
export function contourTierRenameArgs(tiers: ContourTier[] = CONTOUR_TIERS): string[] {
  return tiers.flatMap(tier => ['-R', `${contourTierLayer(tier)}:${CONTOUR_LAYER}`]);
}

/** The tippecanoe knobs the contour experiment harness varies. */
export interface ContourTippecanoeOptions {
  /** `--simplification` (Douglas-Peucker tolerance in tile units). */
  simplification?: number;
  /** `--minimum-detail`: the coarsest grid an oversize tile may be quantised to. */
  minimumDetail?: number;
  /** `--simplify-only-low-zooms`: leave maxzoom tiles at full vertex detail. */
  simplifyOnlyLowZooms?: boolean;
  /** `--maximum-tile-bytes`; undefined = tippecanoe's 500 KB default. */
  maxTileBytes?: number;
  /** `--visvalingam`: Visvalingam-Whyatt instead of Douglas-Peucker. */
  visvalingam?: boolean;
  /** Pass the tier `$zoom` filter (off reproduces the pre-2026-10 archives). */
  tiered?: boolean;
}

/**
 * The quality bundle every contour build tiles with, chosen at the
 * 2026-08-22 decision gate (Mt Sonder, `npm run experiment:contours`, run
 * `smooth-z13`): simplification 14 left z12–z14 contours visibly polygonal;
 * 2 renders smooth at every zoom for ~+35% archive size in mountainous tiles
 * (z15 is unaffected).
 */
export const CONTOUR_TIPPECANOE_DEFAULTS: Required<ContourTippecanoeOptions> = {
  simplification: 2,
  // Keep full vertex detail at maxzoom: z15 tiles are what MapLibre overzooms
  // past z15, so simplifying them makes contours visibly polygonal exactly
  // where users zoom in. Lower zooms stay simplified.
  simplifyOnlyLowZooms: true,
  // tippecanoe's default (128 units): an oversize tile may be quantised no
  // coarser than that before features are dropped — 4 allowed a 16×16 grid.
  minimumDetail: 7,
  maxTileBytes: 1_000_000,
  visvalingam: false,
  tiered: true,
};

/**
 * The tippecanoe argv shared by every contour build, minus `-o`, `-t` and the
 * `-L` tier layers: zoom range, attributes, the quality bundle above and the
 * tier filter. Build one tiered archive, then `renameContourTiers()` it.
 */
export function contourTippecanoeArgs(options: ContourTippecanoeOptions = {}, opts?: { verbose?: boolean }): string[] {
  const o = { ...CONTOUR_TIPPECANOE_DEFAULTS, ...options };
  return [
    // Quiet the progress indicator unless verbose. Output also streams to the
    // terminal (stdio inherit) instead of a pipe: any capture buffer
    // eventually fills over a multi-hour merge and kills tippecanoe with
    // ENOBUFS — -q alone doesn't prevent per-tile feature-drop warnings.
    ...(opts?.verbose ? [] : ['-q']),
    `-Z${CONTOUR_MIN_ZOOM}`,
    `-z${MAX_ZOOM}`,
    '-P',
    '-y',
    'elevation',
    '-y',
    'is_index',
    '--drop-smallest-as-needed',
    `--simplification=${o.simplification}`,
    ...(o.simplifyOnlyLowZooms ? ['--simplify-only-low-zooms'] : []),
    `--minimum-detail=${o.minimumDetail}`,
    ...(o.maxTileBytes ? [`--maximum-tile-bytes=${o.maxTileBytes}`] : []),
    ...(o.visvalingam ? ['--visvalingam'] : []),
    ...(o.tiered ? ['-j', contourTierFilter()] : []),
    '--force',
  ];
}

/**
 * A short digest of the contour tippecanoe settings, for markers that let a
 * later run reuse tippecanoe output (the world build's batch `.done`). Taken
 * over the argv with the verbosity flag left out, since `-q` changes only the
 * terminal output: two runs that differ by anything else produce different
 * tiles, and must not reuse each other's.
 */
export function contourSettingsHash(options: ContourTippecanoeOptions = {}): string {
  const args = contourTippecanoeArgs(options, { verbose: true });
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12);
}

/**
 * Fold a tippecanoe output's tier layers (`contour_z9`…) into the one served
 * `contour` layer with tile-join. `outputPath` may be `.mbtiles` or
 * `.pmtiles`. `--no-tile-size-limit` is mandatory: tile-join re-encodes every
 * tile, and silently drops one over 500 KB without it, while the tippecanoe
 * run allows a megabyte. Renaming a layer the input does not have is a no-op,
 * so joining already-renamed archives through this is safe.
 */
export function renameContourTiers(
  inputPaths: string | string[],
  outputPath: string,
  opts?: { verbose?: boolean }
): void {
  const inputs = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  execFileSync(
    'tile-join',
    [
      '-o',
      outputPath,
      '--no-tile-size-limit',
      '--force',
      ...(opts?.verbose ? [] : ['-q']),
      ...contourTierRenameArgs(),
      ...inputs,
    ],
    {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );
}

// --- Utility functions ---

export function run(cmd: string, options?: { cwd?: string; verbose?: boolean }): string {
  const execOptions: ExecSyncOptions = {
    encoding: 'utf-8',
    cwd: options?.cwd ?? PROJECT_ROOT,
    stdio: options?.verbose ? 'inherit' : 'pipe',
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
  };

  try {
    const result = execSync(cmd, execOptions);
    return typeof result === 'string' ? result.trim() : '';
  } catch (error) {
    const execError = error as { stderr?: string; status?: number };
    console.error(`Command failed: ${cmd}`);
    if (execError.stderr) {
      console.error(execError.stderr);
    }
    throw error;
  }
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Remove a work directory and all its contents.
 * Safe to call if the directory doesn't exist.
 */
export function cleanWorkDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Chunk size for streamed hashing (4 MiB). */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Stream a file through one or more hashes in a single pass.
 *
 * Deliberately uses chunked `fs.readSync` rather than `fs.createReadStream`:
 * the rest of the pipeline (sqlite3 validation, GDAL/tippecanoe invocation,
 * manifest writing) is synchronous, and base.mbtiles for a long trail can be
 * multiple GB — `fs.readFileSync` would both balloon RSS and, past ~2 GiB, hit
 * Node's maximum Buffer length and throw. Reading a fixed 4 MiB window keeps
 * memory flat at any file size while leaving callers synchronous.
 */
function hashFile(filePath: string, algorithms: string[]): string[] {
  const hashes = algorithms.map(algorithm => crypto.createHash(algorithm));
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead = fs.readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    while (bytesRead > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      for (const hash of hashes) hash.update(chunk);
      bytesRead = fs.readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hashes.map(hash => hash.digest('hex'));
}

export function fileSha256(filePath: string): string {
  return hashFile(filePath, ['sha256'])[0];
}

export function fileMd5(filePath: string): string {
  return hashFile(filePath, ['md5'])[0];
}

/**
 * Both digests the manifest needs, computed in one pass over the bytes.
 * sha256 is the tooling/content-address hash; md5 is what the device can
 * cheaply verify after download (expo-file-system exposes `File.md5`).
 */
export function fileDigests(filePath: string): { sha256: string; md5: string } {
  const [sha256, md5] = hashFile(filePath, ['sha256', 'md5']);
  return { sha256, md5 };
}

/**
 * Content-addressed remote object key for a tile file: the logical name with
 * the first 12 hex chars of its sha256 spliced in before the extension, e.g.
 * `base.mbtiles` + `58ce65fc4290…` → `base.58ce65fc4290.mbtiles`.
 *
 * Uploads write new bytes at new keys and swap manifest.json last, so a client
 * holding the previous manifest keeps resolving the previous (untouched)
 * objects for the whole duration of an upload.
 */
export function contentAddressedKey(name: string, sha256: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}.${sha256.slice(0, 12)}${ext}`;
}

export function fileSizeBytes(filePath: string): number {
  return fs.statSync(filePath).size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- MGA Zone lookup ---

/**
 * Return the EPSG code for the MGA zone covering a given longitude.
 * MGA (Map Grid of Australia) zones use EPSG:283XX where XX is the zone number.
 */
export function mgaEpsgForLon(lonCenter: number): number {
  if (lonCenter < 114) return 28349; // Zone 49
  if (lonCenter < 120) return 28350; // Zone 50
  if (lonCenter < 126) return 28351; // Zone 51
  if (lonCenter < 132) return 28352; // Zone 52
  if (lonCenter < 138) return 28353; // Zone 53
  if (lonCenter < 144) return 28354; // Zone 54
  if (lonCenter < 150) return 28355; // Zone 55
  return 28356; // Zone 56
}

/**
 * Rough lon/lat box of mainland Australia and Tasmania: the area the SRTM
 * cache in data/dem covers and MGA (EPSG:283xx) is defined for.
 */
export const AUSTRALIA_BOUNDS = { west: 112, south: -44, east: 154, north: -10 };

/**
 * Metric CRS to buffer a track in: MGA inside Australia, otherwise the WGS84
 * UTM zone of the centroid (EPSG:326xx north, 327xx south). MGA is only
 * defined for Australia — a New Zealand or US trail buffered in MGA zone 56
 * gets a corridor that is badly out of shape. A trail spanning several UTM
 * zones is still close enough for a 20 km buffer; one that needs better can
 * set its own EPSG in build-tiles.ts's TRAIL_TILE_CONFIGS.
 */
export function projectedEpsgFor(lonCenter: number, latCenter: number): number {
  if (
    lonCenter >= AUSTRALIA_BOUNDS.west &&
    lonCenter <= AUSTRALIA_BOUNDS.east &&
    latCenter >= AUSTRALIA_BOUNDS.south &&
    latCenter <= AUSTRALIA_BOUNDS.north
  ) {
    return mgaEpsgForLon(lonCenter);
  }
  const zone = Math.min(60, Math.floor((lonCenter + 180) / 6) + 1);
  return (latCenter < 0 ? 32700 : 32600) + zone;
}

// --- Dependency checking ---

/**
 * The felt/tippecanoe release the contour builds are verified against, and
 * the one `contours/scripts/remote/bootstrap.sh` builds (`TIPPECANOE_REF`; a test
 * keeps the two equal). The tier fix needs `$zoom` in `-j` feature filters
 * (tippecanoe 1.27.13) and tile-join `-R` (1.26.1), which every 2.x release
 * has; the pin is about everything else. 2.79.0 is felt's latest *release*
 * (2025-07-24) and the version the bootstrap's "latest release" lookup
 * installed on the September 2026 box: the tier fix was checked against its
 * behaviour (2.78.0 changed how `--drop-smallest-as-needed` gives up), while
 * felt's main branch has since rewritten the JSON parser that reads `-L` and
 * `-j` and changed how pyramids drop features (2.80–2.82, untagged).
 */
export const TIPPECANOE_VERSION = '2.79.0';

/** The oldest tippecanoe whose `-j` filters can test `$zoom` (the tiers). */
export const TIPPECANOE_MIN_VERSION = '1.27.13';

/** `tippecanoe v2.79.0` → `2.79.0`; null when no version is in the text. */
export function parseTippecanoeVersion(text: string): string | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric comparison of two `x.y.z` versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What to do about the installed tippecanoe: `ok`, `warn` (a different but
 * capable release) or `fail` (too old for the tiers, unreadable, or — when
 * the pin is required — anything but the pin).
 */
export function checkTippecanoeVersion(
  installed: string | null,
  requirePinned: boolean
): { status: 'ok' | 'warn' | 'fail'; message?: string } {
  if (!installed) {
    return { status: 'fail', message: 'could not read the tippecanoe version (`tippecanoe --version`)' };
  }
  if (compareVersions(installed, TIPPECANOE_MIN_VERSION) < 0) {
    return {
      status: 'fail',
      message: `tippecanoe ${installed} is older than ${TIPPECANOE_MIN_VERSION}: its -j filters cannot test $zoom, so the contour tiers would not apply`,
    };
  }
  if (installed === TIPPECANOE_VERSION) return { status: 'ok' };
  const message =
    `tippecanoe ${installed} is installed; the contour builds are verified against ${TIPPECANOE_VERSION}` +
    ' (contours/scripts/remote/bootstrap.sh builds it)';
  return requirePinned ? { status: 'fail', message } : { status: 'warn', message };
}

/** The installed tippecanoe's `x.y.z`, or null when it cannot be read. */
export function installedTippecanoeVersion(): string | null {
  try {
    // Prints to stderr, and exits 0 or 1 depending on the release.
    const out = execSync('tippecanoe --version 2>&1 || true', { encoding: 'utf-8', stdio: 'pipe' });
    return parseTippecanoeVersion(out);
  } catch {
    return null;
  }
}

interface DependencyCheck {
  name: string;
  command: string;
}

export function checkDependencies(opts: {
  skipContours?: boolean;
  skipBase?: boolean;
  /**
   * Refuse any tippecanoe but TIPPECANOE_VERSION, for builds too long to
   * gamble on another release (the world archive, which is published as built).
   * `TIPPECANOE_ANY_VERSION=1` overrides it. Without it a different capable
   * release only warns.
   */
  requirePinnedTippecanoe?: boolean;
}): void {
  const deps: DependencyCheck[] = [];

  // Always need ogr2ogr for corridor/polygon generation
  deps.push({ name: 'GDAL (ogr2ogr)', command: 'ogr2ogr --version' });

  // Always need sqlite3 to validate generated mbtiles before manifesting
  deps.push({ name: 'sqlite3', command: 'sqlite3 --version' });

  if (!opts.skipContours) {
    deps.push({ name: 'GDAL (gdalwarp)', command: 'gdalwarp --version' });
    // gdal_contour only gained --version in GDAL 3.9 (3.8 is Ubuntu 24.04's);
    // before that every flag-only call exits non-zero, so check it exists.
    deps.push({ name: 'GDAL (gdal_contour)', command: 'which gdal_contour' });
    deps.push({ name: 'tippecanoe', command: 'tippecanoe --version' });
  }

  if (!opts.skipBase) {
    deps.push({ name: 'pmtiles', command: 'pmtiles version' });
  }

  if (!opts.skipContours || !opts.skipBase) {
    // tile-join folds the contour tiers into one layer (renameContourTiers)
    // and unions base tiles; it exits non-zero for all flags, so just check
    // it exists.
    deps.push({ name: 'tile-join', command: 'which tile-join' });
  }

  const missing: string[] = [];
  for (const dep of deps) {
    try {
      run(dep.command);
    } catch {
      missing.push(dep.name);
    }
  }

  if (missing.length > 0) {
    console.error('\nMissing required dependencies:');
    missing.forEach(d => console.error(`  - ${d}`));
    console.error('\nInstall them before running this script.');
    process.exit(1);
  }

  if (!opts.skipContours) {
    const requirePinned = !!opts.requirePinnedTippecanoe && process.env.TIPPECANOE_ANY_VERSION !== '1';
    const check = checkTippecanoeVersion(installedTippecanoeVersion(), requirePinned);
    if (check.status === 'fail') {
      console.error(`\n${check.message}.`);
      if (requirePinned) {
        console.error(
          `Build tippecanoe ${TIPPECANOE_VERSION} (contours/scripts/remote/bootstrap.sh), or set TIPPECANOE_ANY_VERSION=1 to run anyway.`
        );
      }
      process.exit(1);
    }
    if (check.status === 'warn') console.warn(`  ⚠ ${check.message}`);
  }
}

// --- Pipeline step functions ---

/**
 * Build a VRT mosaic of cached DEM tiles, then clip to a region polygon.
 */
export function clipDem(
  regionPath: string,
  demOutputPath: string,
  verbose: boolean,
  /**
   * Absolute paths of the DEM tiles to mosaic. Omitted, every tile in the
   * SRTM cache (data/dem) is used — the grid builds' behaviour.
   */
  demFilePaths?: string[]
): void {
  console.log('  Clipping DEM to region...');

  let demPathList = demFilePaths;
  if (!demPathList) {
    // Check for cached DEM tiles
    if (!fs.existsSync(DEM_CACHE_DIR)) {
      console.error(`    ✗ DEM cache directory not found: ${DEM_CACHE_DIR}`);
      console.error('    Download SRTM DEM tiles first.');
      throw new Error('DEM tiles not found');
    }

    const demExtensions = ['.tif', '.tiff', '.hgt'];
    demPathList = fs
      .readdirSync(DEM_CACHE_DIR)
      .filter(f => demExtensions.some(ext => f.toLowerCase().endsWith(ext)))
      .map(f => path.join(DEM_CACHE_DIR, f));
    if (demPathList.length === 0) {
      throw new Error(`No DEM files (.tif, .hgt) found in ${DEM_CACHE_DIR}`);
    }
  }
  if (demPathList.length === 0) {
    throw new Error('No DEM tiles given to clip');
  }

  // Build VRT mosaic from all DEM tiles
  const vrtPath = path.join(path.dirname(demOutputPath), 'dem_mosaic.vrt');
  const demPaths = demPathList.map(f => `"${f}"`).join(' ');
  run(`gdalbuildvrt -vrtnodata -9999 "${vrtPath}" ${demPaths}`, { verbose });

  // Clip to region polygon (overwrite if re-running)
  run(
    [
      'gdalwarp',
      '-overwrite',
      `-cutline "${regionPath}"`,
      '-crop_to_cutline',
      '-dstnodata -9999',
      '-co COMPRESS=LZW',
      '-co TILED=YES',
      '-co BIGTIFF=YES',
      `"${vrtPath}"`,
      `"${demOutputPath}"`,
    ].join(' '),
    { verbose }
  );

  // Clean up VRT
  if (fs.existsSync(vrtPath)) fs.unlinkSync(vrtPath);

  console.log(`    ✓ DEM clipped: ${demOutputPath} (${formatBytes(fileSizeBytes(demOutputPath))})`);
}

/**
 * Smooth a DEM using cubic-spline resampling.
 * This acts as a low-pass filter that reduces single-pixel SRTM noise
 * while preserving real terrain features. Resamples at 2x the 1-arc-second
 * source resolution (CONTOUR_WARP_TR_DEG) so contours traced from the result
 * follow smooth interpolated curves rather than the 30m DEM lattice.
 */
export function smoothDem(demPath: string, smoothedPath: string, verbose: boolean): void {
  console.log('  Smoothing DEM (cubicspline)...');

  if (fs.existsSync(smoothedPath)) fs.unlinkSync(smoothedPath);

  run(
    [
      'gdalwarp',
      '-overwrite',
      '-r cubicspline',
      `-tr ${CONTOUR_WARP_TR_DEG} ${CONTOUR_WARP_TR_DEG}`,
      // Align the output pixel grid to -tr multiples so separately-warped
      // regions sample the DEM identically and contours meet at shared edges.
      '-tap',
      '-co COMPRESS=LZW',
      '-co TILED=YES',
      '-co BIGTIFF=YES',
      `"${demPath}"`,
      `"${smoothedPath}"`,
    ].join(' '),
    { verbose }
  );

  console.log(`    ✓ Smoothed DEM: ${smoothedPath} (${formatBytes(fileSizeBytes(smoothedPath))})`);
}

/**
 * Generate contour lines from DEM.
 * If skipSmooth is false (default), applies cubic-spline smoothing first.
 */
export function generateContours(
  demPath: string,
  contoursRawPath: string,
  verbose: boolean,
  opts?: { skipSmooth?: boolean }
): void {
  console.log('  Generating contour lines...');

  // Optionally smooth the DEM before generating contours
  let contourInputPath = demPath;
  const smoothedPath = demPath.replace(/\.tif$/, '_smoothed.tif');

  if (!opts?.skipSmooth) {
    smoothDem(demPath, smoothedPath, verbose);
    contourInputPath = smoothedPath;
  }

  // Remove existing output (gdal_contour won't overwrite)
  if (fs.existsSync(contoursRawPath)) fs.unlinkSync(contoursRawPath);

  run(
    [
      'gdal_contour',
      '-a elevation',
      `-i ${CONTOUR_INTERVAL}`,
      '-snodata -9999',
      '-f FlatGeobuf',
      `"${contourInputPath}"`,
      `"${contoursRawPath}"`,
    ].join(' '),
    { verbose }
  );

  // Clean up smoothed DEM
  if (fs.existsSync(smoothedPath)) fs.unlinkSync(smoothedPath);

  console.log(`    ✓ Raw contours: ${contoursRawPath} (${formatBytes(fileSizeBytes(contoursRawPath))})`);
}

/**
 * Classify contours and convert to MBTiles vector tiles.
 * Adds is_index field (1 for every 50m contour, 0 otherwise).
 * Uses zoom-dependent filtering for contour density (CONTOUR_TIERS).
 *
 * tippecanoe writes `contours.tiered.mbtiles` beside the output with one layer
 * per tier, and `renameContourTiers()` folds them into the one `contour` layer
 * the app's style reads — see `contourTierLayer()` for why two steps.
 */
export function classifyAndTileContours(
  contoursRawPath: string,
  contoursClassifiedPath: string,
  contoursMbtilesPath: string,
  verbose: boolean
): void {
  console.log('  Classifying and tiling contours...');

  // 4a: Add is_index field
  if (fs.existsSync(contoursClassifiedPath)) fs.unlinkSync(contoursClassifiedPath);
  const rawLayerName = 'contour';
  run(
    [
      'ogr2ogr',
      '-f FlatGeobuf',
      `"${contoursClassifiedPath}"`,
      `"${contoursRawPath}"`,
      `-nln ${CONTOUR_LAYER}`,
      '-dialect sqlite',
      '-sql',
      `"SELECT geometry, elevation, CAST(CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS INTEGER) AS is_index FROM '${rawLayerName}'"`,
    ].join(' '),
    { verbose }
  );

  // 4b: Split into zoom-tier files for density control
  const workDir = path.dirname(contoursMbtilesPath);
  const tierPath = (tier: ContourTier): string => path.join(workDir, `contours_${tier.suffix}.fgb`);

  const layerArgs: string[] = [];
  for (const tier of CONTOUR_TIERS) {
    if (fs.existsSync(tierPath(tier))) fs.unlinkSync(tierPath(tier));
    run(
      [
        'ogr2ogr',
        '-f FlatGeobuf',
        `"${tierPath(tier)}"`,
        `"${contoursClassifiedPath}"`,
        '-dialect sqlite',
        '-sql',
        `"SELECT * FROM '${CONTOUR_LAYER}' WHERE ${tier.where}"`,
      ].join(' '),
      { verbose }
    );

    if (fs.existsSync(tierPath(tier)) && fileSizeBytes(tierPath(tier)) > 0) {
      layerArgs.push('-L', contourTierLayerArg(tierPath(tier), tier));
      console.log(`    ${tier.suffix}: ${formatBytes(fileSizeBytes(tierPath(tier)))}`);
    }
  }

  // 4c: Generate vector tiles, one tippecanoe layer per tier, gated by zoom.
  //     argv form: the -j filter carries `$zoom`, which a shell would expand.
  const tieredPath = contoursMbtilesPath.replace(/\.mbtiles$/, '.tiered.mbtiles');
  if (fs.existsSync(tieredPath)) fs.unlinkSync(tieredPath);
  execFileSync('tippecanoe', ['-o', tieredPath, ...contourTippecanoeArgs({}, { verbose }), ...layerArgs], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  // 4d: Fold the tier layers into the served `contour` layer.
  renameContourTiers(tieredPath, contoursMbtilesPath, { verbose });

  // Clean up intermediates
  if (fs.existsSync(tieredPath)) fs.unlinkSync(tieredPath);
  for (const tier of CONTOUR_TIERS) {
    if (fs.existsSync(tierPath(tier))) fs.unlinkSync(tierPath(tier));
  }

  console.log(`    ✓ Contour tiles: ${contoursMbtilesPath} (${formatBytes(fileSizeBytes(contoursMbtilesPath))})`);
}

/**
 * Extract base map vector tiles from Protomaps.
 * Supports both remote HTTP extraction and local file extraction.
 */
export function extractBaseTiles(
  regionPath: string,
  basePmtilesPath: string,
  baseMbtilesPath: string,
  protomapsSource: string,
  verbose: boolean
): void {
  console.log('  Extracting base map tiles...');

  // Extract region from Protomaps
  run(
    [
      'pmtiles',
      'extract',
      `"${protomapsSource}"`,
      `"${basePmtilesPath}"`,
      `--region="${regionPath}"`,
      `--minzoom=${MIN_ZOOM}`,
      `--maxzoom=${MAX_ZOOM}`,
    ].join(' '),
    { verbose }
  );

  // Convert PMTiles to MBTiles for React Native compatibility
  run(['tile-join', `-o "${baseMbtilesPath}"`, '--force', `"${basePmtilesPath}"`].join(' '), { verbose });

  console.log(`    ✓ Base tiles: ${baseMbtilesPath} (${formatBytes(fileSizeBytes(baseMbtilesPath))})`);
}

/**
 * Zoom range a caller expects an artifact to contain, asserted against the
 * zoom levels actually present in the `tiles` table.
 */
export interface MbtilesZoomExpectation {
  minZoom?: number;
  maxZoom?: number;
}

/** Contours are always built with tippecanoe `-Z${CONTOUR_MIN_ZOOM} -z${MAX_ZOOM}`. */
export const CONTOUR_ZOOM_EXPECTATION: MbtilesZoomExpectation = {
  minZoom: CONTOUR_MIN_ZOOM,
  maxZoom: MAX_ZOOM,
};

/**
 * Base tiles are extracted with `--minzoom=${MIN_ZOOM} --maxzoom=${MAX_ZOOM}`
 * and every current-pipeline build produces exactly that range. (Heysen's Feb
 * build was z8–z15 — a stale-flags artifact, disproved by rebuilding: the same
 * Protomaps source yields z4–z15 with the current pipeline.)
 */
export const BASE_ZOOM_EXPECTATION: MbtilesZoomExpectation = {
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
};

/**
 * Structurally validate a generated .mbtiles file. Throws with a descriptive
 * message if the file would be unusable — or worse — on a device.
 *
 * MapLibre native builds a TileJSON from mbtiles metadata using unguarded
 * std::stoi/std::stod (crashing the whole app on bad input), and an empty or
 * corrupt file has historically been built and uploaded silently (AAWT's
 * contours.mbtiles was a 32KB stub with zero tiles; bibbulmun's was a
 * malformed database). Everything MapLibre parses is checked here.
 *
 * Metadata is also checked against reality: heysen's contours.mbtiles was once
 * built without the global `-Z9` tippecanoe flag, yielding z0–z8 tiles and a
 * self-consistent `minzoom=0` — structurally valid, wrong at every zoom the
 * app renders. The `expected` argument lets callers declare the zoom range the
 * build is supposed to produce so that class of miss fails the build.
 *
 * @param filePath - Path to the .mbtiles file
 * @param expected - Optional zoom range the tiles table must actually cover
 */
export function validateMbtilesArtifact(filePath: string, expected?: MbtilesZoomExpectation): void {
  const name = path.basename(filePath);
  const sql = (query: string): string => run(`sqlite3 "${filePath}" "${query}"`);

  const integrity = sql('PRAGMA integrity_check;');
  if (integrity !== 'ok') {
    throw new Error(`${name} failed integrity check: ${integrity.split('\n')[0]}`);
  }

  const tileCount = parseInt(sql('SELECT count(*) FROM tiles;'), 10);
  if (!Number.isFinite(tileCount) || tileCount < 1) {
    throw new Error(`${name} contains no tiles`);
  }

  // Actual zoom coverage of the tiles table.
  const zoomOut = sql('SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles;');
  const [actualMinRaw, actualMaxRaw] = zoomOut.split('|');
  const actualMinZoom = parseInt(actualMinRaw, 10);
  const actualMaxZoom = parseInt(actualMaxRaw, 10);
  if (!Number.isFinite(actualMinZoom) || !Number.isFinite(actualMaxZoom)) {
    throw new Error(`${name} has unreadable zoom levels in tiles table: "${zoomOut}"`);
  }

  const metaOut = sql("SELECT name, value FROM metadata WHERE name IN ('minzoom', 'maxzoom', 'scale', 'bounds');");
  let metaMinZoom: number | null = null;
  let metaMaxZoom: number | null = null;
  for (const line of metaOut.split('\n').filter(l => l.length > 0)) {
    const sep = line.indexOf('|');
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    if (key === 'minzoom' || key === 'maxzoom') {
      if (!/^\d+$/.test(value)) {
        throw new Error(`${name} metadata ${key} is not an integer: "${value}"`);
      }
      if (key === 'minzoom') metaMinZoom = parseInt(value, 10);
      else metaMaxZoom = parseInt(value, 10);
    } else if (key === 'scale') {
      if (value.trim() === '' || !Number.isFinite(Number(value))) {
        throw new Error(`${name} metadata scale is not a number: "${value}"`);
      }
    } else if (key === 'bounds') {
      const parts = value.split(',');
      if (parts.length !== 4 || !parts.every(p => p.trim() !== '' && Number.isFinite(Number(p)))) {
        throw new Error(`${name} metadata bounds is malformed: "${value}"`);
      }
    }
  }

  // Metadata must describe the tiles that are actually in the file: MapLibre
  // uses metadata zooms to decide which tiles to request, so a mismatch means
  // either requests for tiles that don't exist or tiles that are never asked for.
  if (metaMinZoom !== null && metaMinZoom !== actualMinZoom) {
    throw new Error(`${name} metadata minzoom=${metaMinZoom} but lowest tile zoom is ${actualMinZoom}`);
  }
  if (metaMaxZoom !== null && metaMaxZoom !== actualMaxZoom) {
    throw new Error(`${name} metadata maxzoom=${metaMaxZoom} but highest tile zoom is ${actualMaxZoom}`);
  }

  // Caller-declared expectations: catches a build that ran with the wrong
  // (or missing) zoom flags, even when the resulting file is self-consistent.
  if (expected?.minZoom !== undefined && actualMinZoom !== expected.minZoom) {
    throw new Error(
      `${name} lowest tile zoom is ${actualMinZoom}, expected ${expected.minZoom} ` +
        `(built with the wrong minimum-zoom flag?)`
    );
  }
  if (expected?.maxZoom !== undefined && actualMaxZoom !== expected.maxZoom) {
    throw new Error(
      `${name} highest tile zoom is ${actualMaxZoom}, expected ${expected.maxZoom} ` +
        `(built with the wrong maximum-zoom flag?)`
    );
  }

  console.log(`    ✓ Validated ${name}: ${tileCount} tiles, z${actualMinZoom}–z${actualMaxZoom}, integrity ok`);
}

export interface ManifestFileInput {
  name: string;
  path: string;
  /** Zoom range this artifact must actually contain (mbtiles only). */
  expectedZoom?: MbtilesZoomExpectation;
}

/**
 * Write tile manifest JSON.
 *
 * Every .mbtiles file is structurally validated first — a build that would
 * produce an empty, corrupt, or wrong-zoom-range tile database fails here
 * instead of shipping. Callers that just rebuilt an artifact should validate
 * the work-dir copy *before* publishing it; this pass still matters for the
 * `--skip-base` / `--skip-contours` paths, where the manifest is rewritten
 * over files that were not rebuilt this run.
 *
 * Each entry carries a `key` — the content-addressed remote object name the
 * uploader writes to — plus `md5` for cheap on-device verification. Both are
 * derived from a single streamed pass over the file, so rewriting a manifest
 * over unchanged artifacts reproduces the same keys.
 *
 * @param id - Trail ID
 * @param outputDir - Directory to write manifest.json into
 * @param bounds - Geographic bounds [west, south, east, north]
 * @param files - List of tile files to include in the manifest
 */
export function writeManifest(
  id: string,
  outputDir: string,
  bounds: { west: number; south: number; east: number; north: number },
  files: ManifestFileInput[]
): TileManifest {
  const manifestFiles: TileManifestFile[] = [];

  for (const file of files) {
    if (fs.existsSync(file.path)) {
      if (file.name.endsWith('.mbtiles')) {
        validateMbtilesArtifact(file.path, file.expectedZoom);
      }
      const { sha256, md5 } = fileDigests(file.path);
      manifestFiles.push({
        name: file.name,
        size: fileSizeBytes(file.path),
        sha256,
        md5,
        key: contentAddressedKey(file.name, sha256),
      });
    } else {
      console.warn(`    ⚠ ${id}: listed tile file is missing, omitting from manifest: ${file.path}`);
    }
  }

  // A manifest with no files is never valid output — the app would download an
  // "offline map" containing nothing. Most likely both --skip-* flags were used
  // on a region that was never built.
  if (manifestFiles.length === 0) {
    throw new Error(
      `${id}: refusing to write an empty manifest — none of the ${files.length} ` +
        `listed tile file(s) exist in ${outputDir}`
    );
  }

  const manifest: TileManifest = {
    trailId: id,
    version: new Date().toISOString().split('T')[0],
    files: manifestFiles,
    totalSize: manifestFiles.reduce((sum, f) => sum + f.size, 0),
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
    zoomRange: [MIN_ZOOM, MAX_ZOOM],
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
