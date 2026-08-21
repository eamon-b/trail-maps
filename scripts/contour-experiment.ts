/**
 * Contour Quality Experiment Harness
 *
 * Builds the SAME small bbox under a matrix of contour-pipeline settings so the
 * best-quality bundle can be chosen by eye before burning a week of remote
 * compute on the world build (issue #34).
 *
 * Each variant runs the production per-cell pipeline from
 * build-contours-australia.ts — buffered gdalwarp (`-tap`) → gdal_contour -i 10
 * → 4 zoom-tier ogr2ogr splits carrying `is_index` → tippecanoe — with one or
 * more knobs changed, and writes `data/experiments/{run}/{variant}.pmtiles`
 * plus timings/sizes/feature counts in `results.json`.
 *
 * A generated `index.html` renders every variant in synchronized MapLibre panes
 * reading the local PMTiles through the pmtiles JS protocol:
 *
 *   npx serve data/experiments/{run}     # any static server with range support
 *
 * Prerequisites: gdal (3.6+), tippecanoe (2.17+ for direct .pmtiles output)
 *
 * Usage:
 *   npx tsx scripts/contour-experiment.ts --list
 *   npx tsx scripts/contour-experiment.ts
 *   npx tsx scripts/contour-experiment.ts --variants baseline,lanczos-2x
 *   npx tsx scripts/contour-experiment.ts --bbox 138.5 -33.9 138.7 -33.7
 *   npx tsx scripts/contour-experiment.ts --run mt-sonder-take2 --keep-work
 *   npx tsx scripts/contour-experiment.ts --dem-dir data/dem-glo30 --verbose
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  PROJECT_ROOT,
  DEM_CACHE_DIR,
  CONTOUR_INTERVAL,
  INDEX_CONTOUR_INTERVAL,
  CONTOUR_MIN_ZOOM,
  MAX_ZOOM,
  CONTOUR_WARP_TR_DEG,
  run,
  ensureDir,
  formatBytes,
} from './tile-pipeline.js';

// --- Constants ---

const EXPERIMENTS_DIR = path.join(PROJECT_ROOT, 'data/experiments');

/** Mt Sonder, NT — steep relief in a 0.15° box; test tile z15 28450/18593. */
const DEFAULT_BBOX: Bbox = [132.5, -23.65, 132.65, -23.5];

/** Same warp buffer as the Australia cell pipeline (~1.1 km). */
const CELL_BUFFER_DEG = 0.01;

/**
 * Native 1 arc-second DEM spacing; warpScale multiplies this density, so
 * warpScale 2 reproduces production's CONTOUR_WARP_TR_DEG exactly. Derived from
 * that constant so the baseline variant can never drift away from the shipped
 * pipeline.
 */
const DEM_TR_DEG = CONTOUR_WARP_TR_DEG * 2;

const CLASSIFIED_LAYER = 'contour';

/** Copied verbatim from build-contours-australia.ts — the tier split IS the schema. */
interface Tier {
  suffix: string;
  minZoom: number;
  where: string;
}

const TIERS: Tier[] = [
  { suffix: 'z9',  minZoom: 9,  where: `(CAST(elevation AS INTEGER) % 100) = 0` },
  { suffix: 'z10', minZoom: 10, where: `(CAST(elevation AS INTEGER) % 50) = 0 AND (CAST(elevation AS INTEGER) % 100) != 0` },
  { suffix: 'z12', minZoom: 12, where: `(CAST(elevation AS INTEGER) % 20) = 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
  // %50 != 0 as well: odd multiples of 50 (50, 150, ...) have %20 = 10 and are
  // already emitted by the z10 tier — without it they'd appear twice.
  { suffix: 'z13', minZoom: 13, where: `(CAST(elevation AS INTEGER) % 20) != 0 AND (CAST(elevation AS INTEGER) % 50) != 0` },
];

// --- Variant matrix ---

type Bbox = [number, number, number, number];

interface Variant {
  name: string;
  description: string;
  /** Relative to PROJECT_ROOT; defaults to --dem-dir. */
  demDir?: string;
  /** 1 | 2 | 3 — multiplies the 1 arc-second sample density (tr = 0.000278 / warpScale). */
  warpScale: 1 | 2 | 3;
  resampling: 'cubicspline' | 'cubic' | 'lanczos' | 'near';
  simplification: number;
  minimumDetail: number;
  simplifyOnlyLowZooms: boolean;
  /** tippecanoe --maximum-tile-bytes; undefined = tippecanoe default (500 KB). */
  maxTileBytes?: number;
}

/** Mirrors the tippecanoe flags in build-contours-world.ts (decision gate 2026-08-22). */
const BASELINE: Omit<Variant, 'name' | 'description'> = {
  warpScale: 2,
  resampling: 'cubicspline',
  simplification: 2,
  minimumDetail: 7,
  simplifyOnlyLowZooms: true,
  maxTileBytes: 1_000_000,
};

const VARIANTS: Variant[] = [
  {
    name: 'baseline',
    description: 'Current world-build settings (build-contours-world.ts)',
    ...BASELINE,
  },
  {
    name: 'legacy-simp-14',
    description: 'Pre-2026-08-22 production settings (australia.pmtiles as deployed): polygonal at z12–14',
    ...BASELINE,
    simplification: 14,
    minimumDetail: 4,
    maxTileBytes: undefined,
  },
  {
    name: 'no-oversample',
    description: 'Warp at native 1" density — smoothing without extra samples',
    ...BASELINE,
    warpScale: 1,
  },
  {
    name: 'oversample-3x',
    description: '3x sample density — 9x the pixels of native, 2.25x of baseline',
    ...BASELINE,
    warpScale: 3,
  },
  {
    name: 'lanczos-2x',
    description: 'Lanczos resampling instead of cubicspline (sharper, can ring)',
    ...BASELINE,
    resampling: 'lanczos',
  },
  {
    name: 'cubic-2x',
    description: 'Cubic resampling instead of cubicspline (interpolates, less smoothing)',
    ...BASELINE,
    resampling: 'cubic',
  },
  {
    name: 'no-smooth',
    description: 'Nearest-neighbour at native density — raw DEM lattice, the "before" picture',
    ...BASELINE,
    warpScale: 1,
    resampling: 'near',
  },
  {
    name: 'heavy-simplify',
    description: 'Aggressive tippecanoe simplification at every zoom — smallest output',
    ...BASELINE,
    simplification: 30,
    simplifyOnlyLowZooms: false,
  },
  // --- tippecanoe-only variants bracketing the chosen simplification. Same
  // contour geometry as baseline; only the merge flags differ.
  {
    name: 'simp-8',
    description: 'simplification 8 at z9–14 (z15 untouched)',
    ...BASELINE,
    simplification: 8,
  },
  {
    name: 'simp-4',
    description: 'simplification 4 at z9–14 (z15 untouched)',
    ...BASELINE,
    simplification: 4,
  },
  {
    name: 'simp-1',
    description: 'simplification 1 at z9–14 — tippecanoe\'s own default; effectively unsimplified',
    ...BASELINE,
    simplification: 1,
  },
  {
    name: 'glo30-baseline',
    description: 'Baseline settings on Copernicus GLO-30 instead of SRTM',
    ...BASELINE,
    demDir: 'data/dem-glo30',
  },
];

// --- CLI argument parsing ---

interface CliArgs {
  bbox: Bbox;
  run: string;
  demDir: string;
  variants: string[] | null;
  list: boolean;
  keepWork: boolean;
  verbose: boolean;
  /** Regenerate index.html from an existing run's results.json — no builds. */
  htmlOnly: boolean;
}

function defaultRunName(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const result: CliArgs = {
    bbox: DEFAULT_BBOX,
    run: defaultRunName(),
    demDir: DEM_CACHE_DIR,
    variants: null,
    list: false,
    keepWork: false,
    verbose: false,
    htmlOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--bbox': {
        const parts = argv.slice(i + 1, i + 5).map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
          console.error('--bbox needs four numbers: W S E N');
          process.exit(1);
        }
        result.bbox = parts as Bbox;
        i += 4;
        break;
      }
      case '--run':
        result.run = argv[++i];
        break;
      case '--dem-dir':
        result.demDir = path.resolve(PROJECT_ROOT, argv[++i]);
        break;
      case '--variants':
        result.variants = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--list':
        result.list = true;
        break;
      case '--keep-work':
        result.keepWork = true;
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--html-only':
        result.htmlOnly = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }

  const [west, south, east, north] = result.bbox;
  if (west >= east || south >= north) {
    console.error(`Invalid bbox: ${result.bbox.join(' ')} (expected W < E and S < N)`);
    process.exit(1);
  }

  if (result.variants) {
    const unknown = result.variants.filter(n => !VARIANTS.some(v => v.name === n));
    if (unknown.length > 0) {
      console.error(`Unknown variant(s): ${unknown.join(', ')}`);
      console.error(`Known: ${VARIANTS.map(v => v.name).join(', ')}`);
      process.exit(1);
    }
  }

  return result;
}

function printUsage(): void {
  console.log('Usage: npx tsx scripts/contour-experiment.ts [options]');
  console.log('  --bbox W S E N     Area to build (default: Mt Sonder, ' + DEFAULT_BBOX.join(' ') + ')');
  console.log('  --run <name>       Output dir name under data/experiments (default: date-based)');
  console.log('  --dem-dir <dir>    DEM cache for variants that do not override it (default: data/dem)');
  console.log('  --variants a,b,c   Only build these variants');
  console.log('  --list             Print the variant matrix and exit');
  console.log('  --keep-work        Keep per-variant intermediates');
  console.log('  --verbose          Stream GDAL/tippecanoe output');
  console.log('  --html-only        Rewrite --run\'s index.html from its results.json (no builds)');
}

// --- DEM selection ---

const DEM_EXTENSIONS = ['.tif', '.tiff', '.hgt'];

/**
 * SW corner of a 1° DEM tile from its filename, for both the SRTM cache naming
 * (`S24E132.hgt`) and the GLO-30 local naming (`N46E006.tif`).
 */
function demTileCorner(fileName: string): { lat: number; lon: number } | null {
  const m = fileName.match(/([NS])(\d{2})([EW])(\d{3})/i);
  if (!m) return null;
  const lat = parseInt(m[2], 10) * (m[1].toUpperCase() === 'S' ? -1 : 1);
  const lon = parseInt(m[4], 10) * (m[3].toUpperCase() === 'W' ? -1 : 1);
  return { lat, lon };
}

/**
 * DEM files overlapping the (buffered) bbox. Restricting the mosaic to the
 * relevant tiles keeps gdalbuildvrt cheap when the cache holds hundreds of
 * continent-wide tiles; gdalwarp windows to `-te` either way, so the contours
 * are identical. Filenames that don't parse are kept as a fallback so an
 * unfamiliar naming scheme degrades to "mosaic everything" rather than "no
 * coverage".
 */
function demFilesForBbox(demDir: string, bbox: Bbox): string[] {
  if (!fs.existsSync(demDir)) return [];
  const [west, south, east, north] = bbox;
  const all = fs.readdirSync(demDir).filter(f =>
    DEM_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext))
  );

  const unparsed = all.filter(f => demTileCorner(f) === null);
  const overlapping = all.filter(f => {
    const corner = demTileCorner(f);
    if (!corner) return false;
    return (
      corner.lon <= east + CELL_BUFFER_DEG &&
      corner.lon + 1 >= west - CELL_BUFFER_DEG &&
      corner.lat <= north + CELL_BUFFER_DEG &&
      corner.lat + 1 >= south - CELL_BUFFER_DEG
    );
  });

  if (overlapping.length === 0 && unparsed.length > 0 && unparsed.length === all.length) {
    return all;
  }
  return overlapping;
}

// --- Result types ---

interface StageTimings {
  mosaicMs: number;
  warpMs: number;
  contourMs: number;
  tiersMs: number;
  tippecanoeMs: number;
  totalMs: number;
}

interface TierResult {
  suffix: string;
  minZoom: number;
  bytes: number;
  features: number;
}

interface VariantResult {
  name: string;
  description: string;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
  settings: {
    demDir: string;
    warpScale: number;
    trDeg: number;
    resampling: string;
    simplification: number;
    minimumDetail: number;
    simplifyOnlyLowZooms: boolean;
    maxTileBytes?: number;
  };
  pmtiles?: string;
  pmtilesBytes?: number;
  demBytes?: number;
  rawBytes?: number;
  featureCount?: number;
  tiers?: TierResult[];
  timings?: StageTimings;
}

interface RunResults {
  run: string;
  generatedAt: string;
  bbox: Bbox;
  bufferDeg: number;
  contourInterval: number;
  indexContourInterval: number;
  minZoom: number;
  maxZoom: number;
  variants: VariantResult[];
}

// --- Pipeline ---

function trForScale(warpScale: number): number {
  return DEM_TR_DEG / warpScale;
}

/** Milliseconds elapsed while running `fn`. */
function timed<T>(fn: () => T): [T, number] {
  const start = Date.now();
  const value = fn();
  return [value, Date.now() - start];
}

/** Feature count from `ogrinfo -al -so`; -1 when GDAL reports it as unknown. */
function featureCount(filePath: string): number {
  const out = run(`ogrinfo -al -so "${filePath}"`);
  const m = out.match(/Feature Count:\s*(-?\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Build one variant end to end. Mirrors processCell() in
 * build-contours-australia.ts: buffered warp from a VRT mosaic, 10 m contours,
 * per-tier classify+clip, then tippecanoe — here writing PMTiles directly
 * instead of merging hundreds of cells.
 */
function buildVariant(
  variant: Variant,
  args: CliArgs,
  runDir: string
): VariantResult {
  const demDir = variant.demDir
    ? path.resolve(PROJECT_ROOT, variant.demDir)
    : args.demDir;
  const tr = trForScale(variant.warpScale);
  const result: VariantResult = {
    name: variant.name,
    description: variant.description,
    status: 'failed',
    settings: {
      demDir: path.relative(PROJECT_ROOT, demDir),
      warpScale: variant.warpScale,
      trDeg: tr,
      resampling: variant.resampling,
      simplification: variant.simplification,
      minimumDetail: variant.minimumDetail,
      simplifyOnlyLowZooms: variant.simplifyOnlyLowZooms,
      maxTileBytes: variant.maxTileBytes,
    },
  };

  const demFiles = demFilesForBbox(demDir, args.bbox);
  if (demFiles.length === 0) {
    result.status = 'skipped';
    result.note = fs.existsSync(demDir)
      ? `No DEM tiles covering the bbox in ${result.settings.demDir}`
      : `DEM directory not found: ${result.settings.demDir}`;
    console.log(`  ⊘ skipped — ${result.note}`);
    return result;
  }

  const workDir = path.join(runDir, 'work', variant.name);
  ensureDir(workDir);
  const vrtPath = path.join(workDir, 'dem_mosaic.vrt');
  const demPath = path.join(workDir, 'dem.tif');
  const rawPath = path.join(workDir, 'raw.fgb');
  const tmpDir = path.join(workDir, 'tmp');
  const pmtilesPath = path.join(runDir, `${variant.name}.pmtiles`);

  const [west, south, east, north] = args.bbox;
  const totalStart = Date.now();

  // 1: VRT mosaic over the DEM tiles that cover the bbox.
  const [, mosaicMs] = timed(() => {
    const listPath = path.join(workDir, 'dem_files.txt');
    fs.writeFileSync(listPath, demFiles.map(f => path.join(demDir, f)).join('\n'));
    run(`gdalbuildvrt -vrtnodata -9999 -input_file_list "${listPath}" "${vrtPath}"`, { verbose: args.verbose });
    fs.unlinkSync(listPath);
  });
  console.log(`    mosaic: ${demFiles.length} DEM tile(s) (${(mosaicMs / 1000).toFixed(1)}s)`);

  // 2: Clip + resample in one warp. Buffered extent so the resampling kernel
  //    sees the same neighbourhood the production cell build gives it.
  const [, warpMs] = timed(() => {
    run([
      'gdalwarp',
      '-overwrite',
      `-te ${west - CELL_BUFFER_DEG} ${south - CELL_BUFFER_DEG} ${east + CELL_BUFFER_DEG} ${north + CELL_BUFFER_DEG}`,
      `-r ${variant.resampling}`,
      `-tr ${tr} ${tr}`,
      // -tap keeps every warp on the same global -tr lattice, so variants that
      // share a warpScale sample the DEM at identical points and differences on
      // the compare page are the settings, not a sub-pixel grid offset.
      '-tap',
      '-dstnodata -9999',
      '-co COMPRESS=LZW',
      '-co TILED=YES',
      '-co BIGTIFF=YES',
      `"${vrtPath}"`,
      `"${demPath}"`,
    ].join(' '), { verbose: args.verbose });
  });
  console.log(`    warp:   ${formatBytes(fs.statSync(demPath).size)} @ tr=${tr} ${variant.resampling} (${(warpMs / 1000).toFixed(1)}s)`);

  // 3: Contours
  const [, contourMs] = timed(() => {
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
    run([
      'gdal_contour',
      '-a elevation',
      `-i ${CONTOUR_INTERVAL}`,
      '-snodata -9999',
      '-f FlatGeobuf',
      `"${demPath}"`,
      `"${rawPath}"`,
    ].join(' '), { verbose: args.verbose });
  });
  const features = featureCount(rawPath);
  console.log(`    contour: ${features} features (${(contourMs / 1000).toFixed(1)}s)`);

  // 4: Per tier: classify (is_index), filter, clip back to the exact bbox.
  const tiers: TierResult[] = [];
  const [, tiersMs] = timed(() => {
    for (const tier of TIERS) {
      const tierPath = path.join(workDir, `${tier.suffix}.fgb`);
      if (fs.existsSync(tierPath)) fs.unlinkSync(tierPath);
      run([
        'ogr2ogr',
        '-f FlatGeobuf',
        `"${tierPath}"`,
        `"${rawPath}"`,
        `-nln ${CLASSIFIED_LAYER}`,
        // Clipping can split a contour into a MultiLineString; promote the
        // layer type so mixed geometries write cleanly.
        '-nlt PROMOTE_TO_MULTI',
        `-clipsrc ${west} ${south} ${east} ${north}`,
        '-dialect sqlite',
        '-sql',
        `"SELECT geometry, elevation, CAST(CASE WHEN (CAST(elevation AS INTEGER) % ${INDEX_CONTOUR_INTERVAL}) = 0 THEN 1 ELSE 0 END AS INTEGER) AS is_index FROM 'contour' WHERE ${tier.where}"`,
      ].join(' '), { verbose: args.verbose });
      tiers.push({
        suffix: tier.suffix,
        minZoom: tier.minZoom,
        bytes: fs.existsSync(tierPath) ? fs.statSync(tierPath).size : 0,
        features: fs.existsSync(tierPath) ? featureCount(tierPath) : 0,
      });
    }
  });
  console.log(`    tiers:  ${tiers.map(t => `${t.suffix}=${t.features}`).join(' ')} (${(tiersMs / 1000).toFixed(1)}s)`);

  // 5: tippecanoe straight to PMTiles. Same flags as the Australia merge except
  //    the variant knobs; argv form (not a shell string) to match that script.
  ensureDir(tmpDir);
  const layerArgs: string[] = [];
  for (const tier of TIERS) {
    const tierPath = path.join(workDir, `${tier.suffix}.fgb`);
    if (!fs.existsSync(tierPath) || fs.statSync(tierPath).size === 0) continue;
    layerArgs.push('-L', JSON.stringify({ file: tierPath, layer: CLASSIFIED_LAYER, minzoom: tier.minZoom }));
  }
  if (layerArgs.length === 0) {
    throw new Error('no tier files were produced — the bbox may be entirely nodata');
  }

  const [, tippecanoeMs] = timed(() => {
    if (fs.existsSync(pmtilesPath)) fs.unlinkSync(pmtilesPath);
    execFileSync('tippecanoe', [
      '-t', tmpDir,
      '-o', pmtilesPath,
      ...(args.verbose ? [] : ['-q']),
      `-Z${CONTOUR_MIN_ZOOM}`,
      `-z${MAX_ZOOM}`,
      '-P',
      '-y', 'elevation',
      '-y', 'is_index',
      '--drop-smallest-as-needed',
      `--simplification=${variant.simplification}`,
      `--minimum-detail=${variant.minimumDetail}`,
      ...(variant.simplifyOnlyLowZooms ? ['--simplify-only-low-zooms'] : []),
      ...(variant.maxTileBytes ? [`--maximum-tile-bytes=${variant.maxTileBytes}`] : []),
      '--force',
      ...layerArgs,
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  });

  result.status = 'ok';
  result.pmtiles = `${variant.name}.pmtiles`;
  result.pmtilesBytes = fs.statSync(pmtilesPath).size;
  result.demBytes = fs.statSync(demPath).size;
  result.rawBytes = fs.statSync(rawPath).size;
  result.featureCount = features;
  result.tiers = tiers;
  result.timings = {
    mosaicMs,
    warpMs,
    contourMs,
    tiersMs,
    tippecanoeMs,
    totalMs: Date.now() - totalStart,
  };
  console.log(`    ✓ ${result.pmtiles} — ${formatBytes(result.pmtilesBytes)} in ${(result.timings.totalMs / 1000).toFixed(1)}s`);
  return result;
}

// --- Compare page ---

const TOPO_STYLE_PATH = path.join(PROJECT_ROOT, 'scripts', 'topo-style.json');

/**
 * The production contour layers from scripts/topo-style.json, retargeted at
 * the viewer's `contours` source and given round joins. Reading the real
 * style (rather than copying it) keeps the compare page honest when the app
 * style changes.
 */
function prodContourLayers(): Record<string, unknown>[] {
  const style = JSON.parse(fs.readFileSync(TOPO_STYLE_PATH, 'utf8')) as {
    layers: Record<string, unknown>[];
  };
  return style.layers
    .filter(l => l.source === 'contour' && l.type === 'line')
    .map(l => ({
      ...l,
      source: 'contours',
      layout: { ...((l.layout as Record<string, unknown>) ?? {}), 'line-join': 'round', 'line-cap': 'round' },
    }));
}

function settingsLabel(v: VariantResult): string {
  return [
    `${v.settings.warpScale}× ${v.settings.resampling}`,
    `simp ${v.settings.simplification}`,
    `detail ${v.settings.minimumDetail}`,
    v.settings.simplifyOnlyLowZooms ? 'low-zooms only' : 'all zooms',
    v.settings.maxTileBytes ? `tile ≤${formatBytes(v.settings.maxTileBytes)}` : 'tile ≤500 KB',
    v.settings.demDir,
  ].join(' · ');
}

/**
 * Static compare viewer: one MapLibre pane per successful variant, cameras
 * synchronized, each reading its own PMTiles over HTTP range requests.
 * CDN deps are fine — this page never leaves the machine that built the run.
 */
function writeIndexHtml(results: RunResults, runDir: string): void {
  const built = results.variants.filter(v => v.status === 'ok');
  const [west, south, east, north] = results.bbox;
  const center = [(west + east) / 2, (south + north) / 2];

  const panes = built.map(v => ({
    name: v.name,
    file: v.pmtiles,
    label: settingsLabel(v),
    size: formatBytes(v.pmtilesBytes ?? 0),
    features: v.featureCount ?? 0,
    seconds: ((v.timings?.totalMs ?? 0) / 1000).toFixed(1),
  }));

  const skipped = results.variants.filter(v => v.status !== 'ok');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contour experiment — ${results.run}</title>
<!-- maplibre-gl v6+ ships ESM only; the v5 UMD build works from a plain script tag. -->
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.css">
<script src="https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/pmtiles@4.3.0/dist/pmtiles.js"></script>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #1b1b1b; color: #eee; }
  header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 8px 12px; background: #262626; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header .meta { color: #aaa; }
  header label { color: #aaa; }
  #grid { display: grid; gap: 4px; padding: 4px; }
  .pane { position: relative; background: #fff; min-height: 240px; }
  .map { position: absolute; inset: 0; }
  .caption { position: absolute; z-index: 2; left: 0; right: 0; top: 0; padding: 5px 8px;
             background: rgba(20,20,20,.78); color: #fff; pointer-events: none; }
  .caption b { font-size: 13px; }
  .caption span { display: block; color: #cfcfcf; font-size: 11px; }
  .skipped { padding: 6px 12px; color: #e0b070; background: #2b2418; }
</style>
</head>
<body>
<header>
  <h1>Contour experiment — ${results.run}</h1>
  <span class="meta">bbox ${results.bbox.join(', ')} · ${CONTOUR_INTERVAL} m interval · z${results.minZoom}–${results.maxZoom}</span>
  <label>columns <select id="cols"><option>1</option><option selected>2</option><option>3</option></select></label>
  <label>style <select id="style"><option value="prod" selected>production (topo-style.json)</option><option value="raw">raw (every contour, fixed width)</option></select></label>
  <span class="meta" id="camera"></span>
</header>
${skipped.map(v => `<div class="skipped">⊘ ${v.name}: ${v.status}${v.note ? ' — ' + v.note : ''}</div>`).join('\n')}
<div id="grid"></div>
<script>
const PANES = ${JSON.stringify(panes, null, 2)};
// ?z=13.5&lng=132.57&lat=-23.58&style=raw&cols=3 pins the camera/style, e.g.
// for headless screenshots (google-chrome --headless --screenshot <url>).
const QS = new URLSearchParams(window.location.search);
const CENTER = [
  parseFloat(QS.get('lng') ?? ${center[0]}),
  parseFloat(QS.get('lat') ?? ${center[1]})
];
const START_ZOOM = parseFloat(QS.get('z') ?? '13');
if (QS.get('style')) document.getElementById('style').value = QS.get('style');
if (QS.get('cols')) document.getElementById('cols').value = QS.get('cols');

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Production contour layers (scripts/topo-style.json), retargeted at this
// pane's source — so what you judge here is what the app draws: regular
// contours hidden below z12, zoom-ramped widths/opacities. 'raw' draws every
// contour at a fixed width so you can see the geometry itself.
const PROD_LAYERS = ${JSON.stringify(prodContourLayers(), null, 2)};

function styleFor(file, mode) {
  // Absolute URL so the pmtiles protocol handler (which does not resolve
  // relative paths against the document) still finds the sibling file.
  const url = 'pmtiles://' + new URL(file, window.location.href).href;
  // is_index arrives as a STRING from the vector tiles — comparing it to
  // the number 1 silently matches nothing. Coerce before comparing.
  const rawLayers = [
    {
      id: 'contour',
      type: 'line',
      source: 'contours',
      'source-layer': 'contour',
      filter: ['!=', ['to-number', ['get', 'is_index']], 1],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#a2704a', 'line-width': 0.7 }
    },
    {
      id: 'contour-index',
      type: 'line',
      source: 'contours',
      'source-layer': 'contour',
      filter: ['==', ['to-number', ['get', 'is_index']], 1],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#7a4a24', 'line-width': 1.5 }
    }
  ];
  return {
    version: 8,
    sources: { contours: { type: 'vector', url: url } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
      ...(mode === 'raw' ? rawLayers : PROD_LAYERS)
    ]
  };
}

const grid = document.getElementById('grid');
const maps = [];
let syncing = false;

function resize() {
  const cols = parseInt(document.getElementById('cols').value, 10);
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  const rows = Math.ceil(PANES.length / cols);
  const available = window.innerHeight - grid.getBoundingClientRect().top - 8;
  const height = Math.max(240, Math.floor(available / rows) - 4);
  for (const pane of grid.children) pane.style.height = height + 'px';
  for (const map of maps) map.resize();
}

for (const pane of PANES) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.innerHTML = '<div class="caption"><b>' + pane.name + '</b>' +
    '<span>' + pane.label + '</span>' +
    '<span>' + pane.size + ' · ' + pane.features + ' contours · ' + pane.seconds + 's</span></div>' +
    '<div class="map"></div>';
  grid.appendChild(el);

  const map = new maplibregl.Map({
    container: el.querySelector('.map'),
    style: styleFor(pane.file, document.getElementById('style').value),
    center: CENTER,
    zoom: START_ZOOM,
    hash: false,
    attributionControl: false
  });
  map.on('move', () => {
    if (syncing) return;
    syncing = true;
    const camera = {
      center: map.getCenter(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch()
    };
    for (const other of maps) if (other !== map) other.jumpTo(camera);
    document.getElementById('camera').textContent =
      'z' + camera.zoom.toFixed(2) + ' · ' + camera.center.lng.toFixed(4) + ', ' + camera.center.lat.toFixed(4);
    syncing = false;
  });
  maps.push(map);
}

maps[0] && maps[0].addControl(new maplibregl.NavigationControl(), 'bottom-right');
document.getElementById('cols').addEventListener('change', resize);
document.getElementById('style').addEventListener('change', () => {
  const mode = document.getElementById('style').value;
  maps.forEach((map, i) => map.setStyle(styleFor(PANES[i].file, mode)));
});
window.addEventListener('resize', resize);
resize();
</script>
</body>
</html>
`;

  fs.writeFileSync(path.join(runDir, 'index.html'), html);
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.list) {
    console.log('Variants:');
    for (const v of VARIANTS) {
      const tr = trForScale(v.warpScale);
      console.log(`  ${v.name.padEnd(16)} ${v.description}`);
      console.log(`  ${''.padEnd(16)} warp ${v.warpScale}x (tr=${tr}) ${v.resampling}, ` +
        `simplification=${v.simplification}, minimum-detail=${v.minimumDetail}, ` +
        `simplify-only-low-zooms=${v.simplifyOnlyLowZooms}, ` +
        `maximum-tile-bytes=${v.maxTileBytes ?? 'default'}, dem=${v.demDir ?? '--dem-dir'}`);
    }
    return;
  }

  const selected = args.variants
    ? VARIANTS.filter(v => args.variants!.includes(v.name))
    : VARIANTS;

  const runDir = path.join(EXPERIMENTS_DIR, args.run);

  if (args.htmlOnly) {
    const resultsPath = path.join(runDir, 'results.json');
    if (!fs.existsSync(resultsPath)) {
      console.error(`--html-only: no results.json in ${path.relative(PROJECT_ROOT, runDir)} (pass --run <name>)`);
      process.exit(1);
    }
    writeIndexHtml(JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as RunResults, runDir);
    console.log(`Rewrote ${path.relative(PROJECT_ROOT, path.join(runDir, 'index.html'))}`);
    return;
  }

  ensureDir(runDir);

  console.log('Contour Quality Experiment');
  console.log('==========================\n');
  console.log(`  Run:      ${args.run}`);
  console.log(`  Bbox:     ${args.bbox.join(' ')}`);
  console.log(`  DEM dir:  ${path.relative(PROJECT_ROOT, args.demDir)}`);
  console.log(`  Variants: ${selected.map(v => v.name).join(', ')}`);
  console.log(`  Output:   ${path.relative(PROJECT_ROOT, runDir)}\n`);

  const results: RunResults = {
    run: args.run,
    generatedAt: new Date().toISOString(),
    bbox: args.bbox,
    bufferDeg: CELL_BUFFER_DEG,
    contourInterval: CONTOUR_INTERVAL,
    indexContourInterval: INDEX_CONTOUR_INTERVAL,
    minZoom: CONTOUR_MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    variants: [],
  };

  const writeResults = (): void => {
    fs.writeFileSync(
      path.join(runDir, 'results.json'),
      JSON.stringify(results, null, 2)
    );
  };

  for (let i = 0; i < selected.length; i++) {
    const variant = selected[i];
    console.log(`[${i + 1}/${selected.length}] ${variant.name} — ${variant.description}`);
    let result: VariantResult;
    try {
      result = buildVariant(variant, args, runDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ✗ failed: ${message.split('\n')[0]}`);
      result = {
        name: variant.name,
        description: variant.description,
        status: 'failed',
        note: message.split('\n')[0],
        settings: {
          demDir: path.relative(PROJECT_ROOT, variant.demDir
            ? path.resolve(PROJECT_ROOT, variant.demDir)
            : args.demDir),
          warpScale: variant.warpScale,
          trDeg: trForScale(variant.warpScale),
          resampling: variant.resampling,
          simplification: variant.simplification,
          minimumDetail: variant.minimumDetail,
          simplifyOnlyLowZooms: variant.simplifyOnlyLowZooms,
        },
      };
    }

    results.variants.push(result);
    // Written after every variant so a crash (or a Ctrl-C mid-matrix) still
    // leaves the completed variants comparable.
    writeResults();
    writeIndexHtml(results, runDir);

    const workDir = path.join(runDir, 'work', variant.name);
    if (!args.keepWork && result.status === 'ok' && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  const workRoot = path.join(runDir, 'work');
  if (fs.existsSync(workRoot) && fs.readdirSync(workRoot).length === 0) {
    fs.rmdirSync(workRoot);
  }

  const ok = results.variants.filter(v => v.status === 'ok');
  console.log('\n' + '═'.repeat(60));
  console.log(`Built ${ok.length}/${results.variants.length} variants`);
  console.log('═'.repeat(60));
  for (const v of results.variants) {
    if (v.status === 'ok') {
      console.log(`  ${v.name.padEnd(16)} ${formatBytes(v.pmtilesBytes ?? 0).padStart(10)}  ` +
        `${((v.timings?.totalMs ?? 0) / 1000).toFixed(1)}s  ${v.featureCount} contours`);
    } else {
      console.log(`  ${v.name.padEnd(16)} ${v.status}${v.note ? ' — ' + v.note : ''}`);
    }
  }
  console.log(`\n  Results: ${path.relative(PROJECT_ROOT, path.join(runDir, 'results.json'))}`);
  console.log(`  Compare: npx serve ${path.relative(PROJECT_ROOT, runDir)}`);

  if (ok.length === 0) process.exit(1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
