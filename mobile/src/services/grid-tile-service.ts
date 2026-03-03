/**
 * Grid tile service for custom/uploaded trail maps.
 *
 * When a user uploads a GPX for a trail not in the built-in set, this service
 * resolves which pre-generated 2°×2° grid cells cover the track, downloads
 * them from R2, and merges them into a single pair of MBTiles files that the
 * existing MapLibre tile infrastructure can render unchanged.
 */
import { File, Directory, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import type { GridIndex, GridCell } from '@lib/types';
import { TILE_FILES, tilesRoot, trailTilesDir, uriToPath } from './tile-paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID_INDEX_CACHE_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/** Temporary directory for grid cell downloads */
function gridTempDir(): Directory {
  return new Directory(Paths.cache, 'grid-tiles-temp');
}

// ---------------------------------------------------------------------------
// Grid index
// ---------------------------------------------------------------------------

let _cachedIndex: GridIndex | null = null;
let _cachedIndexTime = 0;

/**
 * Fetch and cache the grid index from R2.
 * Caches in memory for 1 hour; always fetches from network on first call.
 */
export async function fetchGridIndex(baseUrl: string): Promise<GridIndex> {
  const now = Date.now();
  if (_cachedIndex && now - _cachedIndexTime < GRID_INDEX_CACHE_MS) {
    return _cachedIndex;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/grid/index.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch grid index: HTTP ${response.status}`);
  }

  _cachedIndex = (await response.json()) as GridIndex;
  _cachedIndexTime = now;
  return _cachedIndex;
}

/** Clear the cached grid index (for testing or manual refresh). */
export function clearGridIndexCache(): void {
  _cachedIndex = null;
  _cachedIndexTime = 0;
}

// ---------------------------------------------------------------------------
// Cell resolution
// ---------------------------------------------------------------------------

/**
 * Given a bounding box (in WGS84), return which grid cells are needed.
 * Filters against the grid index to skip ocean cells.
 */
export function resolveGridCells(
  bounds: { west: number; south: number; east: number; north: number },
  gridIndex: GridIndex
): GridCell[] {
  const [cellLonDeg, cellLatDeg] = gridIndex.cellSizeDeg;

  // Convert to positive latitudes for cell math (grid uses positive S values internally)
  // bounds.south/north are negative (WGS84), grid cell IDs use positive S values
  const absSouth = Math.abs(bounds.south);
  const absNorth = Math.abs(bounds.north);
  const latMin = Math.min(absSouth, absNorth);
  const latMax = Math.max(absSouth, absNorth);

  // Compute cell ranges
  const westCell = Math.floor(bounds.west / cellLonDeg) * cellLonDeg;
  const eastCell = Math.floor(bounds.east / cellLonDeg) * cellLonDeg;
  const southCell = Math.floor(latMin / cellLatDeg) * cellLatDeg;
  const northCell = Math.floor(latMax / cellLatDeg) * cellLatDeg;

  // Build set of needed cell IDs
  const neededIds = new Set<string>();
  for (let lon = westCell; lon <= eastCell; lon += cellLonDeg) {
    for (let lat = southCell; lat <= northCell; lat += cellLatDeg) {
      neededIds.add(`E${lon}_S${lat}`);
    }
  }

  // Filter against available cells in the index
  return gridIndex.cells.filter((cell) => neededIds.has(cell.id));
}

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------

export interface GridDownloadProgress {
  phase: 'downloading' | 'merging';
  cellsTotal: number;
  cellsComplete: number;
  currentCell?: string;
  /** Bytes downloaded so far across all cells */
  bytesDownloaded: number;
  /** Total bytes expected (from grid index cell sizes) */
  bytesTotal: number;
}

export type GridProgressCallback = (progress: GridDownloadProgress) => void;

/** Options for downloadGridTiles */
export interface GridDownloadOptions {
  onProgress?: GridProgressCallback;
  /** Set to true to cancel the download between cells */
  signal?: { cancelled: boolean };
}

// ---------------------------------------------------------------------------
// Download and merge
// ---------------------------------------------------------------------------

/**
 * Download grid cells for a custom trail and merge into trail tile format.
 *
 * Result: tiles/{trailId}/base.mbtiles + tiles/{trailId}/contours.mbtiles
 * — the exact same structure as built-in trail tiles, so the existing
 * MapLibre rendering code works unchanged.
 */
export async function downloadGridTiles(
  trailId: string,
  cells: GridCell[],
  baseUrl: string,
  optionsOrCallback?: GridDownloadOptions | GridProgressCallback,
): Promise<void> {
  if (cells.length === 0) {
    throw new Error('No grid cells to download');
  }

  // Support both new options object and legacy callback signature
  const opts: GridDownloadOptions =
    typeof optionsOrCallback === 'function'
      ? { onProgress: optionsOrCallback }
      : optionsOrCallback ?? {};

  const { onProgress, signal } = opts;

  const url = baseUrl.replace(/\/$/, '');
  const tempDir = gridTempDir();
  const root = tilesRoot();
  const destDir = trailTilesDir(trailId);

  // Compute total expected bytes from grid index
  const bytesTotal = cells.reduce((sum, c) => sum + c.totalSize, 0);
  let bytesDownloaded = 0;

  // Ensure directories
  if (!root.exists) root.create();
  if (!destDir.exists) destDir.create();
  if (!tempDir.exists) tempDir.create();

  try {
    // Phase 1: Download all cell tile files
    const downloadedBase: string[] = [];
    const downloadedContours: string[] = [];

    for (let i = 0; i < cells.length; i++) {
      // Check cancellation
      if (signal?.cancelled) {
        throw new Error('Cancelled');
      }

      const cell = cells[i];
      onProgress?.({
        phase: 'downloading',
        cellsTotal: cells.length,
        cellsComplete: i,
        currentCell: cell.id,
        bytesDownloaded,
        bytesTotal,
      });

      const cellTempDir = new Directory(tempDir, cell.id);
      if (!cellTempDir.exists) cellTempDir.create();

      for (const fileName of TILE_FILES) {
        const dest = new File(cellTempDir, fileName);
        const fileUrl = `${url}/grid/${cell.id}/${fileName}`;

        try {
          await File.downloadFileAsync(fileUrl, dest, { idempotent: true });
          const downloadedSize = dest.exists ? (dest.size ?? 0) : 0;
          if (downloadedSize > 100) {
            bytesDownloaded += downloadedSize;
            if (fileName === 'base.mbtiles') {
              downloadedBase.push(dest.uri);
            } else {
              downloadedContours.push(dest.uri);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[grid-tile-service]', `Failed to download ${fileUrl}: ${msg}`);
          // Some cells may not have contours (flat terrain) — that's OK
          if (fileName === 'base.mbtiles') {
            throw new Error(`Failed to download base tiles for cell ${cell.id} from ${fileUrl}: ${msg}`);
          }
        }
      }
    }

    // Phase 2: Merge downloaded tiles
    onProgress?.({
      phase: 'merging',
      cellsTotal: cells.length,
      cellsComplete: cells.length,
      bytesDownloaded,
      bytesTotal,
    });

    const destBasePath = uriToPath(new File(destDir, 'base.mbtiles').uri);
    const destContoursPath = uriToPath(new File(destDir, 'contours.mbtiles').uri);

    if (downloadedBase.length > 0) {
      await mergeMbtiles(destBasePath, downloadedBase.map(uriToPath));
    }
    if (downloadedContours.length > 0) {
      await mergeMbtiles(destContoursPath, downloadedContours.map(uriToPath));
    }
  } finally {
    // Clean up temp directory
    if (tempDir.exists) tempDir.delete();
  }
}

// ---------------------------------------------------------------------------
// MBTiles merge via SQLite
// ---------------------------------------------------------------------------

/**
 * Merge multiple MBTiles files into a single target file.
 *
 * MBTiles is SQLite with a `tiles` table (zoom_level, tile_column, tile_row, tile_data).
 * Merging is a pure SQL operation using ATTACH + INSERT OR IGNORE.
 * Boundary overlaps are handled by keeping whichever tile was inserted first
 * (both have valid data due to the 1km DEM buffer during grid generation).
 */
export async function mergeMbtiles(
  targetPath: string,
  sourcePaths: string[],
): Promise<void> {
  if (sourcePaths.length === 0) return;

  // If only one source, just copy it
  if (sourcePaths.length === 1) {
    const src = new File(sourcePaths[0]);
    const dest = new File(targetPath);
    if (dest.exists) dest.delete();
    src.copy(dest);
    return;
  }

  // Open/create target database
  const db = await openDatabaseAsync(targetPath);

  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS tiles (
        zoom_level INTEGER,
        tile_column INTEGER,
        tile_row INTEGER,
        tile_data BLOB
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tile_index
        ON tiles (zoom_level, tile_column, tile_row);
      CREATE TABLE IF NOT EXISTS metadata (
        name TEXT,
        value TEXT
      );
    `);

    for (let i = 0; i < sourcePaths.length; i++) {
      const srcPath = sourcePaths[i];
      const alias = `src${i}`;

      await db.execAsync(`ATTACH DATABASE '${srcPath}' AS ${alias}`);
      await db.execAsync(`
        INSERT OR IGNORE INTO tiles
        SELECT * FROM ${alias}.tiles
      `);

      // Copy metadata from first source only
      if (i === 0) {
        await db.execAsync(`
          INSERT OR IGNORE INTO metadata
          SELECT * FROM ${alias}.metadata
        `);
      }

      await db.execAsync(`DETACH DATABASE ${alias}`);
    }
  } finally {
    await db.closeAsync();
  }
}

