/**
 * High-level tile management service.
 *
 * Wraps the lower-level tile-service functions with convenience methods
 * for checking download status, available space, and listing downloaded trails.
 */

import { Directory, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  provisionGlyphs,
  buildTopoStyle,
  type TrailTileStatus,
  type ProgressCallback,
} from './tile-service';

/** Root directory for all downloaded tiles: {documentDir}/tiles/ */
function tilesRoot(): Directory {
  return new Directory(Paths.document, 'tiles');
}

export class TileManager {
  /** Check if a trail's tiles have been downloaded for offline use */
  isTrailDownloaded(trailId: string): boolean {
    return getTrailTileStatus(trailId).complete;
  }

  /** Get the tile status for a specific trail */
  getTrailStatus(trailId: string): TrailTileStatus {
    return getTrailTileStatus(trailId);
  }

  /** Get available device storage in bytes */
  async getAvailableSpace(): Promise<number> {
    return FileSystem.getFreeDiskStorageAsync();
  }

  /** List trail IDs that have downloaded tile sets */
  getDownloadedTrails(): string[] {
    const root = tilesRoot();
    if (!root.exists) return [];
    try {
      // Each subdirectory in tiles/ is a trail ID
      return root.list()
        .filter((entry): entry is Directory => entry instanceof Directory)
        .map(dir => dir.name)
        .filter(id => getTrailTileStatus(id).complete);
    } catch {
      return [];
    }
  }

  /** Get total bytes used by all downloaded tiles */
  getTotalStorageUsed(): number {
    const trailIds = this.getDownloadedTrails();
    return trailIds.reduce((sum, id) => sum + getTrailTileStatus(id).totalSizeBytes, 0);
  }

  /** Download tiles for a trail */
  async downloadTrail(trailId: string, baseUrl: string, onProgress?: ProgressCallback): Promise<void> {
    return downloadTrailTiles(trailId, baseUrl, onProgress);
  }

  /** Delete downloaded tiles for a trail */
  deleteTrail(trailId: string): void {
    deleteTrailTiles(trailId);
  }

  /**
   * Build a MapLibre style for offline rendering if tiles are available.
   * Returns the style object, or null if tiles aren't downloaded.
   * Provisions glyph fonts as a side effect.
   */
  async getOfflineStyle(trailId: string): Promise<object | null> {
    if (!this.isTrailDownloaded(trailId)) return null;
    const glyphsPath = await provisionGlyphs();
    return buildTopoStyle(trailId, glyphsPath);
  }
}

/** Singleton instance */
export const tileManager = new TileManager();
