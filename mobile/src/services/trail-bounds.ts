/**
 * Calculate the bounding box (with a buffer corridor) of a trail's track.
 */

/** A single point along a trail track. */
export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance along the trail in km */
  dist: number;
}

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
