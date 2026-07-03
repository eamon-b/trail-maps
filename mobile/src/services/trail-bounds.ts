/**
 * Calculate bounding box and corridor from trail track geometry.
 *
 * Used for resolving grid tile cells for custom trail offline maps.
 */

import type { TrackPoint } from '../lib/trail-utils';

export interface TrailBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Buffer distance in degrees to add around the trail track.
 * ~10 km at mid-latitudes (~0.09 degrees of latitude).
 */
const CORRIDOR_BUFFER_DEG = 0.1;

/**
 * Calculate the bounding box of a trail's track points,
 * with a buffer to create a corridor around the trail.
 */
export function calculateTrailBounds(
  trackPoints: TrackPoint[],
  bufferDeg = CORRIDOR_BUFFER_DEG,
): TrailBounds {
  if (trackPoints.length === 0) {
    throw new Error('Cannot calculate bounds for empty track');
  }

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const p of trackPoints) {
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }

  return {
    west: west - bufferDeg,
    south: south - bufferDeg,
    east: east + bufferDeg,
    north: north + bufferDeg,
  };
}

/**
 * Estimate the download size for grid tiles covering a bounding box.
 * Returns an estimate in bytes based on area coverage.
 *
 * Rough estimate: ~15 MB per 2x2 degree cell (base + contours).
 */
export function estimateGridDownloadSize(cellCount: number): number {
  const BYTES_PER_CELL = 15 * 1024 * 1024; // ~15 MB per cell
  return cellCount * BYTES_PER_CELL;
}
