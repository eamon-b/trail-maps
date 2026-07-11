import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import {
  downloadTrailTiles,
  deleteTrailTiles,
  getTrailTileStatus,
  type TrailTileStatus,
  type DownloadProgress,
} from '../services/tile-service';
import {
  fetchGridIndex,
  resolveGridCells,
  downloadGridTiles,
  type GridProgressCallback,
} from '../services/grid-tile-service';
import { calculateTrailBounds } from '../services/trail-bounds';
import { trailJsonToTrail } from '../lib/trail-utils';
import { TrailDataService } from '../services/trail-data-service';

// Set via EXPO_PUBLIC_TILE_BASE_URL env var (e.g. https://tiles.trailcompanion.app)
// For local dev, use the dev screen (Dev Catalog > Map Tiles) which prompts for a server IP.
const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

export interface TileDownloadProgress {
  fileName: string;
  fileIndex: number;
  totalFiles: number;
}

export interface TileDownloadError {
  trailId: string;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shared offline-tile download workflow (extracted from the Plan tab — WS4;
 * reused by the hike screen's offline-readiness line and the map viewer's
 * download affordance in WS5).
 *
 * Owns the in-flight download state, error state, and the built-in vs
 * custom-trail (grid) download paths. Callers pass `onStatusChanged` to
 * refresh their own tile-status views as files land.
 */
export function useTileDownloads(onStatusChanged?: (trailId: string) => void) {
  const [downloadingTrailId, setDownloadingTrailId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<TileDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<TileDownloadError | null>(null);

  const clearError = useCallback(() => setDownloadError(null), []);

  const downloadBuiltIn = useCallback(async (trailId: string) => {
    setDownloadingTrailId(trailId);
    setDownloadError(null);
    let filesDone = 0;
    try {
      await downloadTrailTiles(trailId, TILE_BASE_URL, (progress: DownloadProgress) => {
        filesDone++;
        setDownloadProgress({
          fileName: progress.fileName,
          fileIndex: filesDone,
          totalFiles: 2,
        });
        onStatusChanged?.(trailId);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDownloadError({ trailId, message: msg });
    }
    setDownloadingTrailId(null);
    setDownloadProgress(null);
    onStatusChanged?.(trailId);
  }, [onStatusChanged]);

  const downloadCustom = useCallback(async (trailId: string) => {
    try {
      // Load trail track data to calculate bounding box
      const service = await TrailDataService.create();
      const json = await service.getTrailTrackData(trailId);
      if (!json) {
        Alert.alert('Error', 'Could not load trail data');
        return;
      }

      const trail = trailJsonToTrail(json);
      const bounds = calculateTrailBounds(trail.track.points);

      // Fetch grid index and resolve cells
      const gridIndex = await fetchGridIndex(TILE_BASE_URL);
      const cells = resolveGridCells(bounds, gridIndex);

      if (cells.length === 0) {
        Alert.alert('No Tiles Available', "No map tiles are available for this trail's region yet.");
        return;
      }

      // Show the real download size (sum of cell sizes from the grid index).
      // Guard against cells missing/NaN totalSize so the dialog never renders
      // "approximately NaN MB"; fall back to a generic phrase if unknown.
      let anySizeMissing = false;
      const downloadSize = cells.reduce((sum, cell) => {
        if (Number.isFinite(cell.totalSize)) return sum + cell.totalSize;
        anySizeMissing = true;
        return sum;
      }, 0);
      const sizeStr =
        downloadSize > 0 && !anySizeMissing ? `approximately ${formatBytes(downloadSize)} of ` : '';

      await new Promise<void>((resolve, reject) => {
        Alert.alert(
          'Download Offline Maps',
          `This will download ${sizeStr}map tiles (${cells.length} grid cell${cells.length > 1 ? 's' : ''}).`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => reject(new Error('Cancelled')) },
            { text: 'Download', onPress: () => resolve() },
          ],
        );
      });

      setDownloadingTrailId(trailId);

      const onProgress: GridProgressCallback = (progress) => {
        if (progress.phase === 'downloading') {
          setDownloadProgress({
            fileName: progress.currentCell ?? 'tiles',
            fileIndex: progress.cellsComplete,
            totalFiles: progress.cellsTotal,
          });
        } else {
          setDownloadProgress({
            fileName: 'Merging tiles...',
            fileIndex: progress.cellsTotal,
            totalFiles: progress.cellsTotal,
          });
        }
      };

      await downloadGridTiles(trailId, cells, TILE_BASE_URL, onProgress);
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') {
        // User cancelled — no alert needed
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setDownloadError({ trailId, message: msg });
      }
    }
    setDownloadingTrailId(null);
    setDownloadProgress(null);
    onStatusChanged?.(trailId);
  }, [onStatusChanged]);

  /** Start a download after validating the tile server configuration. */
  const download = useCallback(async (trailId: string, isCustom: boolean) => {
    if (!TILE_BASE_URL) {
      Alert.alert(
        'Tile server not configured',
        'Set EXPO_PUBLIC_TILE_BASE_URL in your environment.\n\nFor local development, add it to .env. For EAS builds, add it to eas.json under the build profile\'s "env" key.',
      );
      return;
    }
    if (!/^https?:\/\/.+/.test(TILE_BASE_URL)) {
      Alert.alert(
        'Invalid tile server URL',
        `EXPO_PUBLIC_TILE_BASE_URL must be a valid URL starting with http:// or https://.\n\nCurrent value: "${TILE_BASE_URL}"`,
      );
      return;
    }

    if (isCustom) {
      await downloadCustom(trailId);
    } else {
      await downloadBuiltIn(trailId);
    }
  }, [downloadBuiltIn, downloadCustom]);

  /** Confirm + delete a trail's offline tiles. */
  const removeTiles = useCallback((trailId: string, trailName: string) => {
    Alert.alert(
      'Delete Offline Maps',
      `Remove downloaded map tiles for ${trailName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteTrailTiles(trailId);
            onStatusChanged?.(trailId);
          },
        },
      ],
    );
  }, [onStatusChanged]);

  /** Fresh tile status lookup (thin passthrough for convenience). */
  const getStatus = useCallback((trailId: string): TrailTileStatus => {
    return getTrailTileStatus(trailId);
  }, []);

  return {
    downloadingTrailId,
    downloadProgress,
    downloadError,
    clearError,
    download,
    removeTiles,
    getStatus,
  };
}

export { formatBytes };
