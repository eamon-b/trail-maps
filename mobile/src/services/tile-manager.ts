/**
 * High-level tile management service.
 *
 * Wraps the lower-level tile-service functions with convenience methods
 * for checking download status, available space, and listing downloaded trails.
 */

import { Directory, Paths } from 'expo-file-system';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  checkForTileUpdate,
  provisionGlyphs,
  buildTopoStyle,
  validateMbtilesCached,
  type TrailTileStatus,
  type DownloadOptions,
  type ProgressCallback,
} from './tile-service';
import { tilesRoot } from './tile-paths';

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
  getAvailableSpace(): number {
    return Paths.availableDiskSpace;
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

  /** Download tiles for a trail (supports options object or legacy callback) */
  async downloadTrail(
    trailId: string,
    baseUrl: string,
    optionsOrCallback?: DownloadOptions | ProgressCallback,
  ): Promise<void> {
    return downloadTrailTiles(trailId, baseUrl, optionsOrCallback);
  }

  /** Check if newer tiles are available on the server */
  async checkForUpdate(trailId: string, baseUrl: string) {
    return checkForTileUpdate(trailId, baseUrl);
  }

  /** Delete downloaded tiles for a trail */
  deleteTrail(trailId: string): void {
    deleteTrailTiles(trailId);
  }

  /**
   * Build a MapLibre style for offline rendering if tiles are available.
   * Returns the style object, or null if tiles aren't downloaded.
   * Provisions glyph fonts as a side effect.
   *
   * Both mbtiles files are structurally validated before being referenced:
   * handing MapLibre a corrupt or empty mbtiles source aborts the process
   * natively (std::stoi in MBTilesFileSource), which no JS error boundary
   * can catch. An invalid basemap falls back to the online style (null);
   * invalid contours degrade to a style without contour layers.
   */
  async getOfflineStyle(trailId: string): Promise<object | null> {
    if (!this.isTrailDownloaded(trailId)) return null;

    const base = await validateMbtilesCached(trailId, 'base.mbtiles');
    if (!base.ok) {
      console.warn(
        `[tile-manager] base.mbtiles for "${trailId}" failed validation (${base.reason}); ` +
          'falling back to online style. Re-download the offline maps for this trail.',
      );
      return null;
    }

    const contours = await validateMbtilesCached(trailId, 'contours.mbtiles');
    if (!contours.ok) {
      console.warn(
        `[tile-manager] contours.mbtiles for "${trailId}" failed validation (${contours.reason}); ` +
          'rendering offline map without contours. Re-download the offline maps for this trail.',
      );
    }

    const glyphsPath = await provisionGlyphs();
    return buildTopoStyle(trailId, glyphsPath, { includeContours: contours.ok });
  }
}

/** Singleton instance */
export const tileManager = new TileManager();
