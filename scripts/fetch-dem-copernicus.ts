/**
 * Copernicus GLO-30 DEM downloader.
 *
 * The world contour build needs a global 1-arc-second DEM. SRTM stops at
 * 60°N/56°S and needs EarthData credentials; GLO-30 is global, float32 metres,
 * and anonymous on AWS Open Data. Tiles are 1°×1° COGs named by SW corner and
 * are stored locally as `data/dem-glo30/{N46E006}.tif` — a *separate* directory
 * from the SRTM cache so the two sources can never end up in one mosaic.
 *
 * Ocean tiles don't exist in the bucket at all, so the bucket's tileList.txt is
 * used as a land mask: absent from the list means ocean, not an error. The list
 * is cached at `{dem-dir}/.tileList.txt`.
 *
 * Downloads stream to a `.part` file and are renamed only after the TIFF magic
 * is verified, so a killed run leaves no truncated `.tif` for gdalbuildvrt to
 * choke on hours later.
 *
 * Usage:
 *   npx tsx scripts/fetch-dem-copernicus.ts --bbox 132 -26 134 -24
 *   npx tsx scripts/fetch-dem-copernicus.ts --cells S26E132,S26E134
 *   npx tsx scripts/fetch-dem-copernicus.ts --shard oceania --parallel 8
 *   npx tsx scripts/fetch-dem-copernicus.ts --shard oceania --dry-run
 *   npx tsx scripts/fetch-dem-copernicus.ts --bbox 5 45 7 47 --dem-dir /mnt/dem
 *   npx tsx scripts/fetch-dem-copernicus.ts --shard europe --refresh-tilelist
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { PROJECT_ROOT, ensureDir, formatBytes } from './tile-pipeline.js';
import {
  COPERNICUS_TILE_LIST_URL,
  cellsForShard,
  copernicusTileUrl,
  dem1DegTiles,
  demTileName,
  enumerateWorldCells,
  parseTileListNames,
  worldCellFromId,
  worldShardNames,
  type DemTile,
  type WorldCell,
} from './lib/world-grid.js';

export const DEFAULT_DEM_DIR = path.join(PROJECT_ROOT, 'data/dem-glo30');

/** Attempts per tile: the first try plus this many retries. */
const TILE_RETRIES = 2;

/** TIFF headers: little-endian `II*\0` and big-endian `MM\0*`. */
const TIFF_MAGICS = ['49492a00', '4d4d002a'];

export interface FetchArgs {
  bbox: { west: number; south: number; east: number; north: number } | null;
  cells: string[] | null;
  shard: string | null;
  demDir: string;
  parallel: number;
  dryRun: boolean;
  refreshTileList: boolean;
}

/**
 * Parse CLI argv (without node/script). Throws instead of exiting so the pure
 * parsing logic stays testable; `main` turns the throw into a usage error.
 */
export function parseFetchArgs(argv: string[]): FetchArgs {
  const args: FetchArgs = {
    bbox: null,
    cells: null,
    shard: null,
    demDir: DEFAULT_DEM_DIR,
    parallel: 4,
    dryRun: false,
    refreshTileList: false,
  };

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--bbox': {
        const parts = argv.slice(i + 1, i + 5);
        if (parts.length !== 4) throw new Error('--bbox requires W S E N');
        const [west, south, east, north] = parts.map(Number);
        if ([west, south, east, north].some(v => !Number.isFinite(v))) {
          throw new Error(`--bbox values must be numbers: ${parts.join(' ')}`);
        }
        args.bbox = { west, south, east, north };
        i += 4;
        break;
      }
      case '--cells':
        args.cells = requireValue('--cells', argv[++i])
          .split(',')
          .map(c => c.trim())
          .filter(c => c.length > 0);
        break;
      case '--shard':
        args.shard = requireValue('--shard', argv[++i]);
        break;
      case '--dem-dir':
        args.demDir = path.resolve(requireValue('--dem-dir', argv[++i]));
        break;
      case '--parallel': {
        const value = parseInt(requireValue('--parallel', argv[++i]), 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new Error('--parallel must be a positive integer');
        }
        args.parallel = value;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--refresh-tilelist':
        args.refreshTileList = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!args.bbox && !args.cells && !args.shard) {
    throw new Error('One of --bbox, --cells or --shard is required');
  }

  return args;
}

/** Cells named by the selection flags. Throws on an unusable cell id/shard. */
export function resolveCells(args: FetchArgs): WorldCell[] {
  const byId = new Map<string, WorldCell>();
  const add = (cell: WorldCell): void => {
    byId.set(cell.id, cell);
  };

  if (args.bbox) enumerateWorldCells(args.bbox).forEach(add);
  if (args.shard) cellsForShard(args.shard).forEach(add);
  if (args.cells) {
    for (const id of args.cells) {
      const cell = worldCellFromId(id);
      if (!cell) {
        throw new Error(
          `Invalid cell id "${id}" — expected an even-degree world cell like S26E132`
        );
      }
      add(cell);
    }
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The distinct 1° DEM tiles the cells need. Adjacent cells share edge tiles, so
 * dedupe before deciding what to download.
 */
export function neededTiles(cells: WorldCell[]): DemTile[] {
  const byName = new Map<string, DemTile>();
  for (const cell of cells) {
    for (const tile of dem1DegTiles(cell)) {
      byName.set(demTileName(tile), tile);
    }
  }
  return [...byName.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, tile]) => tile);
}

export function demTilePath(demDir: string, tile: DemTile): string {
  return path.join(demDir, `${demTileName(tile)}.tif`);
}

export function tileListCachePath(demDir: string): string {
  return path.join(demDir, '.tileList.txt');
}

export interface TilePlan {
  /** Tiles to fetch. */
  toDownload: DemTile[];
  /** Tiles absent from the bucket manifest — ocean, nothing to fetch. */
  ocean: DemTile[];
  /** Tiles already on disk with content. */
  present: DemTile[];
}

/**
 * Split the needed tiles into download / ocean / already-present.
 *
 * A zero-byte file counts as missing: that's what a failed or interrupted
 * pre-`.part` download used to leave behind, and gdalbuildvrt would fail on it.
 */
export function planTiles(opts: {
  tiles: DemTile[];
  demDir: string;
  available: Set<string>;
  exists?: (filePath: string) => boolean;
}): TilePlan {
  const exists =
    opts.exists ??
    ((filePath: string): boolean => fs.existsSync(filePath) && fs.statSync(filePath).size > 0);

  const plan: TilePlan = { toDownload: [], ocean: [], present: [] };
  for (const tile of opts.tiles) {
    if (!opts.available.has(demTileName(tile))) {
      plan.ocean.push(tile);
    } else if (exists(demTilePath(opts.demDir, tile))) {
      plan.present.push(tile);
    } else {
      plan.toDownload.push(tile);
    }
  }
  return plan;
}

/** True if the first bytes of a downloaded file are a TIFF header. */
export function isTiffMagic(head: Buffer): boolean {
  return TIFF_MAGICS.includes(head.subarray(0, 4).toString('hex'));
}

// --- Network ---

async function loadTileList(demDir: string, refresh: boolean): Promise<Set<string>> {
  const cachePath = tileListCachePath(demDir);
  if (!refresh && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return parseTileListNames(fs.readFileSync(cachePath, 'utf-8'));
  }

  console.log(`  Fetching tile list: ${COPERNICUS_TILE_LIST_URL}`);
  const response = await fetch(COPERNICUS_TILE_LIST_URL);
  if (!response.ok) {
    throw new Error(`tileList.txt fetch failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const names = parseTileListNames(text);
  if (names.size === 0) {
    throw new Error('tileList.txt contained no recognisable tile names');
  }
  // Write via .part so an interrupted fetch can't leave a half list that would
  // silently mask thousands of land tiles as ocean on the next run.
  const partPath = `${cachePath}.part`;
  fs.writeFileSync(partPath, text);
  fs.renameSync(partPath, cachePath);
  return names;
}

function readFileHead(filePath: string, bytes: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

async function downloadTile(tile: DemTile, demDir: string): Promise<number> {
  const url = copernicusTileUrl(tile);
  const finalPath = demTilePath(demDir, tile);
  const partPath = `${finalPath}.part`;

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  try {
    // `lib.dom` and `stream/web` declare separate ReadableStream types; the
    // runtime object is the Node one, so the cast is a type-level bridge only.
    const body = response.body as unknown as NodeReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(body), fs.createWriteStream(partPath));

    const head = readFileHead(partPath, 4);
    if (!isTiffMagic(head)) {
      throw new Error(`not a TIFF (first bytes ${head.toString('hex')}) — S3 error page?`);
    }

    const size = fs.statSync(partPath).size;
    fs.renameSync(partPath, finalPath);
    return size;
  } catch (error) {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    throw error;
  }
}

interface DownloadResult {
  downloaded: number;
  bytes: number;
  failures: { name: string; error: string }[];
}

async function downloadAll(
  tiles: DemTile[],
  demDir: string,
  parallel: number
): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: 0, bytes: 0, failures: [] };
  const queue = [...tiles];
  let started = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const tile = queue.shift();
      if (!tile) return;
      const name = demTileName(tile);
      const index = ++started;

      let lastError = '';
      for (let attempt = 0; attempt <= TILE_RETRIES; attempt++) {
        try {
          const size = await downloadTile(tile, demDir);
          result.downloaded++;
          result.bytes += size;
          console.log(`  [${index}/${tiles.length}] ${name} OK (${formatBytes(size)})`);
          lastError = '';
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (lastError) {
        console.error(`  [${index}/${tiles.length}] ${name} FAILED: ${lastError}`);
        result.failures.push({ name, error: lastError });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(parallel, tiles.length) }, () => worker())
  );
  return result;
}

// --- Main ---

async function main(): Promise<void> {
  let args: FetchArgs;
  try {
    args = parseFetchArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      '\nUsage: npx tsx scripts/fetch-dem-copernicus.ts ' +
      '(--bbox W S E N | --cells id,id | --shard name) [--dem-dir DIR] ' +
      '[--parallel N] [--dry-run] [--refresh-tilelist]'
    );
    console.error(`Shards: ${worldShardNames().join(', ')}`);
    process.exit(1);
  }

  console.log('Copernicus GLO-30 DEM Downloader');
  console.log('================================\n');

  const cells = resolveCells(args);
  const tiles = neededTiles(cells);
  console.log(`  Cells:      ${cells.length}`);
  console.log(`  1° tiles:   ${tiles.length}`);
  console.log(`  DEM dir:    ${args.demDir}\n`);

  ensureDir(args.demDir);
  const available = await loadTileList(args.demDir, args.refreshTileList);
  console.log(`  Tile list:  ${available.size} land tiles worldwide\n`);

  const plan = planTiles({ tiles, demDir: args.demDir, available });

  if (args.dryRun) {
    console.log(`Dry run — would download ${plan.toDownload.length} tiles:`);
    for (const tile of plan.toDownload) console.log(`  ${demTileName(tile)}`);
    console.log(`\n  Already present: ${plan.present.length}`);
    console.log(`  Ocean (absent):  ${plan.ocean.length}`);
    return;
  }

  const startTime = Date.now();
  const result =
    plan.toDownload.length > 0
      ? await downloadAll(plan.toDownload, args.demDir, args.parallel)
      : { downloaded: 0, bytes: 0, failures: [] };

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n' + '='.repeat(32));
  console.log(`Downloaded:      ${result.downloaded} (${formatBytes(result.bytes)})`);
  console.log(`Already present: ${plan.present.length}`);
  console.log(`Ocean (absent):  ${plan.ocean.length}`);
  console.log(`Failed:          ${result.failures.length}`);
  console.log(`Time:            ${elapsed} minutes`);
  console.log(`DEM dir:         ${args.demDir}`);

  if (result.failures.length > 0) {
    console.error('\nFailed tiles:');
    for (const failure of result.failures) {
      console.error(`  ${failure.name}: ${failure.error}`);
    }
    console.error('\nRe-run to retry — tiles already downloaded are skipped.');
    process.exit(1);
  }
}

// Only run as a CLI. Tests import the pure helpers above, and importing a
// module must never kick off a multi-gigabyte download.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
