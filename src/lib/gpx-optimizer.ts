import type {
  GpxPoint,
  GpxData,
  GpxTrack,
  GpxSegment,
  OptimizationOptions,
  OptimizationResult,
  OptimizationStats
} from './types';
import { parseGpx } from './gpx-parser';
import { haversineDistance3D } from './distance';

// Constants
const EARTH_RADIUS_METERS = 6371000;

// Default optimization options
export const GPX_OPTIMIZER_DEFAULTS: OptimizationOptions = {
  simplificationTolerance: 10,      // 10 meters - good balance for web display
  elevationSmoothing: true,
  elevationSmoothingWindow: 7,      // 7 points moving average
  spikeThreshold: 50,               // 50 meters - max valid elevation change between points
  truncateStart: 0,                 // disabled by default
  truncateEnd: 0,                   // disabled by default
  stripExtensions: true,
  preserveTimestamps: true,
  coordinatePrecision: 6,           // ~0.11 meter precision
  maxDistanceChangeRatio: 0.05,     // 5% - warn if distance changes by more than this
  maxElevationChangeRatio: 0.15,    // 15% - warn if elevation gain changes by more than this
  maxPointCount: 100000,            // 100k points maximum (0 = unlimited)
  maxFileSize: 50 * 1024 * 1024     // 50MB maximum input file size (0 = unlimited)
}

/**
 * Calculate perpendicular distance from a point to a line segment
 * Used by Douglas-Peucker algorithm
 *
 * Note: Uses equirectangular approximation which works well for short distances
 * but may be inaccurate for:
 * - Points near poles (latitude > 80°)
 * - Very long segments (>100km)
 * - Tracks crossing the 180° meridian
 *
 * @param point - The point to measure distance from
 * @param lineStart - Start of the line segment
 * @param lineEnd - End of the line segment
 * @returns Perpendicular distance in meters
 */
function perpendicularDistance(
  point: GpxPoint,
  lineStart: GpxPoint,
  lineEnd: GpxPoint
): number {
  // Convert to cartesian coordinates for calculation
  const toRadians = (deg: number) => deg * Math.PI / 180;

  // Use equirectangular approximation for short distances
  const lat1 = toRadians(lineStart.lat);
  const lat2 = toRadians(lineEnd.lat);
  const latP = toRadians(point.lat);

  const lon1 = toRadians(lineStart.lon);
  const lon2 = toRadians(lineEnd.lon);
  const lonP = toRadians(point.lon);

  // Project to flat surface (equirectangular approximation)
  const x1 = lon1 * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const y1 = lat1 * EARTH_RADIUS_METERS;
  const x2 = lon2 * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const y2 = lat2 * EARTH_RADIUS_METERS;
  const xP = lonP * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const yP = latP * EARTH_RADIUS_METERS;

  // Line length squared
  const lineLengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  if (lineLengthSquared === 0) {
    // Line start and end are the same point
    return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  }

  // Project point onto line
  const t = Math.max(0, Math.min(1,
    ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lineLengthSquared
  ));

  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);

  return Math.sqrt((xP - projX) ** 2 + (yP - projY) ** 2);
}

/**
 * Douglas-Peucker line simplification algorithm (iterative implementation)
 * Reduces number of points while preserving shape within tolerance
 *
 * Uses an explicit stack instead of recursion to avoid stack overflow
 * on very long trails (>50k points).
 *
 * @param points - Array of GPS points to simplify
 * @param tolerance - Maximum perpendicular distance in meters for point removal
 * @returns Simplified array of points
 */
export function douglasPeucker(points: GpxPoint[], tolerance: number): GpxPoint[] {
  if (points.length <= 2) {
    return points;
  }

  // Track which points to keep
  const keep: boolean[] = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Use explicit stack instead of recursion to avoid stack overflow
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;

    let maxDist = 0;
    let maxIndex = start;

    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    if (maxDist > tolerance) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Remove elevation spikes that exceed physical possibility
 * Uses linear interpolation between valid points when spikes are detected
 *
 * A spike is identified when a point deviates significantly from BOTH its
 * neighbors - i.e., it goes up (or down) sharply and then returns. This
 * distinguishes true spikes from legitimate elevation changes.
 *
 * @param points - Array of GPS points with elevation data
 * @param spikeThreshold - Maximum valid elevation change in meters between consecutive points
 * @returns Array of points with spikes interpolated
 */
export function removeElevationSpikes(
  points: GpxPoint[],
  spikeThreshold: number
): GpxPoint[] {
  if (points.length < 3) return points;

  // Identify spike points: a point is a spike if it deviates significantly
  // from BOTH neighbors in the same direction (up from both or down from both)
  const isSpike: boolean[] = new Array(points.length).fill(false);

  for (let i = 1; i < points.length - 1; i++) {
    const prevEle = points[i - 1].ele;
    const currEle = points[i].ele;
    const nextEle = points[i + 1].ele;

    const diffFromPrev = currEle - prevEle;
    const diffFromNext = currEle - nextEle;

    // It's a spike if:
    // 1. The point is significantly higher (or lower) than BOTH neighbors
    // 2. Both differences exceed the threshold
    // 3. Both differences are in the same direction (both positive or both negative)
    const sameDirection = (diffFromPrev > 0 && diffFromNext > 0) ||
                          (diffFromPrev < 0 && diffFromNext < 0);
    const exceedsThreshold = Math.abs(diffFromPrev) > spikeThreshold &&
                             Math.abs(diffFromNext) > spikeThreshold;

    if (sameDirection && exceedsThreshold) {
      isSpike[i] = true;
    }
  }

  // Second pass: interpolate spikes
  const result: GpxPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!isSpike[i]) {
      result.push({ ...points[i] });
    } else {
      // Find previous valid point
      let prevIdx = i - 1;
      while (prevIdx >= 0 && isSpike[prevIdx]) {
        prevIdx--;
      }

      // Find next valid point
      let nextIdx = i + 1;
      while (nextIdx < points.length && isSpike[nextIdx]) {
        nextIdx++;
      }

      let interpolatedEle: number;
      if (prevIdx >= 0 && nextIdx < points.length) {
        // Interpolate between previous and next valid points
        const prevEle = points[prevIdx].ele;
        const nextEle = points[nextIdx].ele;
        const weight = (i - prevIdx) / (nextIdx - prevIdx);
        interpolatedEle = prevEle + weight * (nextEle - prevEle);
      } else if (prevIdx >= 0) {
        // No valid point ahead, use previous
        interpolatedEle = points[prevIdx].ele;
      } else if (nextIdx < points.length) {
        // No valid point before, use next
        interpolatedEle = points[nextIdx].ele;
      } else {
        // All points are spikes (shouldn't happen), keep original
        interpolatedEle = points[i].ele;
      }

      result.push({
        ...points[i],
        ele: interpolatedEle
      });
    }
  }

  return result;
}

/**
 * Apply moving average smoothing to elevation data
 *
 * @param points - Array of GPS points with elevation data
 * @param windowSize - Number of points to include in moving average window
 * @returns Array of points with smoothed elevations
 */
export function smoothElevation(
  points: GpxPoint[],
  windowSize: number
): GpxPoint[] {
  if (points.length < windowSize) return points;

  const halfWindow = Math.floor(windowSize / 2);
  const result: GpxPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(points.length - 1, i + halfWindow);

    let elevationSum = 0;
    let count = 0;

    for (let j = start; j <= end; j++) {
      elevationSum += points[j].ele;
      count++;
    }

    result.push({
      ...points[i],
      ele: elevationSum / count
    });
  }

  return result;
}

/**
 * Calculate total distance of a track in meters
 *
 * @param points - Array of GPS points
 * @returns Total distance in meters using 3D Haversine formula
 */
export function calculateTrackDistance(points: GpxPoint[]): number {
  if (points.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversineDistance3D(
      points[i - 1].lat, points[i - 1].lon, points[i - 1].ele,
      points[i].lat, points[i].lon, points[i].ele
    );
  }

  return totalDistance;
}

/**
 * Calculate elevation gain and loss for a track
 * Uses threshold to filter out noise
 *
 * @param points - Array of GPS points with elevation data
 * @param threshold - Minimum elevation change in meters to count (default: 3m)
 * @returns Object containing total gain and loss in meters
 */
export function calculateElevationStats(
  points: GpxPoint[],
  threshold: number = 3 // 3 meter threshold for counting elevation changes
): { gain: number; loss: number } {
  if (points.length < 2) return { gain: 0, loss: 0 };

  let gain = 0;
  let loss = 0;

  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i - 1].ele;
    if (Math.abs(diff) >= threshold) {
      if (diff > 0) {
        gain += diff;
      } else {
        loss += Math.abs(diff);
      }
    }
  }

  return { gain, loss };
}

/**
 * Truncate track by distance from start and/or end
 * Returns truncated points array
 *
 * @param points - Array of GPS points
 * @param truncateStartMeters - Distance in meters to remove from start (0 = disabled)
 * @param truncateEndMeters - Distance in meters to remove from end (0 = disabled)
 * @returns Truncated array preserving at least 2 points from the remaining segment
 */
export function truncateTrack(
  points: GpxPoint[],
  truncateStartMeters: number,
  truncateEndMeters: number
): GpxPoint[] {
  if (points.length < 2) return points;

  let startIndex = 0;
  let endIndex = points.length - 1;

  // Find start index
  if (truncateStartMeters > 0) {
    let accumulatedDistance = 0;
    for (let i = 1; i < points.length; i++) {
      accumulatedDistance += haversineDistance3D(
        points[i - 1].lat, points[i - 1].lon, points[i - 1].ele,
        points[i].lat, points[i].lon, points[i].ele
      );
      if (accumulatedDistance >= truncateStartMeters) {
        startIndex = i;
        break;
      }
    }
  }

  // Find end index
  if (truncateEndMeters > 0) {
    let accumulatedDistance = 0;
    for (let i = points.length - 1; i > startIndex; i--) {
      accumulatedDistance += haversineDistance3D(
        points[i].lat, points[i].lon, points[i].ele,
        points[i - 1].lat, points[i - 1].lon, points[i - 1].ele
      );
      if (accumulatedDistance >= truncateEndMeters) {
        endIndex = i;
        break;
      }
    }
  }

  // Ensure we have at least 2 points from the remaining segment
  if (endIndex - startIndex < 1) {
    // Truncation too aggressive - preserve what's left
    if (startIndex < points.length - 1) {
      // Keep from startIndex to end
      endIndex = Math.min(startIndex + 1, points.length - 1);
    } else {
      // Start truncation consumed everything - keep last 2 points
      startIndex = Math.max(0, points.length - 2);
      endIndex = points.length - 1;
    }
  }

  return points.slice(startIndex, endIndex + 1);
}

/**
 * Round coordinates to specified precision
 */
export function roundCoordinates(points: GpxPoint[], precision: number): GpxPoint[] {
  const factor = Math.pow(10, precision);
  return points.map(p => ({
    ...p,
    lat: Math.round(p.lat * factor) / factor,
    lon: Math.round(p.lon * factor) / factor,
    ele: Math.round(p.ele * 10) / 10 // 1 decimal for elevation
  }));
}

/**
 * Generate optimized GPX XML from processed data
 */
export function generateOptimizedGpx(
  tracks: GpxTrack[],
  options: OptimizationOptions
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools - Optimizer"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`;

  for (const track of tracks) {
    const escapedName = track.name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    xml += `  <trk>
    <name>${escapedName}</name>
`;

    for (const segment of track.segments) {
      xml += `    <trkseg>
`;
      for (const pt of segment.points) {
        xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
`;
        // Include elevation if it's defined (0 is valid for sea level)
        if (pt.ele !== undefined && pt.ele !== null) {
          xml += `        <ele>${pt.ele}</ele>
`;
        }
        if (options.preserveTimestamps && pt.time) {
          xml += `        <time>${pt.time}</time>
`;
        }
        xml += `      </trkpt>
`;
      }
      xml += `    </trkseg>
`;
    }

    xml += `  </trk>
`;
  }

  xml += `</gpx>`;
  return xml;
}

/**
 * Get all points from a GPX data structure (from all tracks and segments)
 */
function getAllPoints(gpxData: GpxData): GpxPoint[] {
  const points: GpxPoint[] = [];

  for (const track of gpxData.tracks) {
    for (const segment of track.segments) {
      points.push(...segment.points);
    }
  }

  // Also include route points
  for (const route of gpxData.routes) {
    points.push(...route.points);
  }

  return points;
}

/**
 * Calculate statistics for a set of points
 */
function calculateStats(points: GpxPoint[], content: string): OptimizationStats {
  const { gain, loss } = calculateElevationStats(points);

  return {
    pointCount: points.length,
    fileSize: new TextEncoder().encode(content).length,
    distance: calculateTrackDistance(points),
    elevationGain: gain,
    elevationLoss: loss
  };
}

/**
 * Process a single GPX track segment
 */
function processSegment(
  segment: GpxSegment,
  options: OptimizationOptions
): GpxSegment {
  let points = [...segment.points];

  // 1. Truncate start/end for privacy
  if (options.truncateStart > 0 || options.truncateEnd > 0) {
    points = truncateTrack(points, options.truncateStart, options.truncateEnd);
  }

  // 2. Remove elevation spikes
  if (options.elevationSmoothing) {
    points = removeElevationSpikes(points, options.spikeThreshold);
  }

  // 3. Apply elevation smoothing
  if (options.elevationSmoothing && options.elevationSmoothingWindow > 1) {
    points = smoothElevation(points, options.elevationSmoothingWindow);
  }

  // 4. Simplify track with Douglas-Peucker
  points = douglasPeucker(points, options.simplificationTolerance);

  // 5. Round coordinates
  points = roundCoordinates(points, options.coordinatePrecision);

  return { points };
}

/**
 * Main optimization function - optimize a GPX file
 *
 * @param gpxContent - GPX file content as string
 * @param filename - Original filename (used for generating output filename)
 * @param options - Optimization options (merged with defaults)
 * @returns Optimization result with statistics and warnings
 * @throws Error if input validation fails
 */
export function optimizeGpx(
  gpxContent: string,
  filename: string,
  options: Partial<OptimizationOptions> = {}
): OptimizationResult {
  const opts: OptimizationOptions = { ...GPX_OPTIMIZER_DEFAULTS, ...options };
  const warnings: string[] = [];

  // Input validation
  if (!gpxContent || gpxContent.trim().length === 0) {
    throw new Error('GPX content cannot be empty');
  }

  const inputSizeBytes = new TextEncoder().encode(gpxContent).length;
  if (opts.maxFileSize > 0 && inputSizeBytes > opts.maxFileSize) {
    throw new Error(
      `Input file size (${(inputSizeBytes / 1024 / 1024).toFixed(1)} MB) exceeds maximum allowed size (${(opts.maxFileSize / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  // Parse GPX
  const gpxData = parseGpx(gpxContent);

  // Get original stats
  const originalPoints = getAllPoints(gpxData);
  const originalStats = calculateStats(originalPoints, gpxContent);

  // Validate point count
  if (opts.maxPointCount > 0 && originalStats.pointCount > opts.maxPointCount) {
    throw new Error(
      `Point count (${originalStats.pointCount.toLocaleString()}) exceeds maximum allowed (${opts.maxPointCount.toLocaleString()})`
    );
  }

  // Convert routes to tracks if present
  const allTracks: GpxTrack[] = [...gpxData.tracks];
  for (const route of gpxData.routes) {
    allTracks.push({
      name: route.name || 'Converted Route',
      segments: [{ points: route.points }]
    });
  }

  // Process each track
  const optimizedTracks: GpxTrack[] = allTracks.map(track => ({
    name: track.name,
    segments: track.segments.map(segment => processSegment(segment, opts))
  }));

  // Generate optimized GPX
  const optimizedContent = generateOptimizedGpx(optimizedTracks, opts);

  // Get optimized stats
  const optimizedPoints: GpxPoint[] = [];
  for (const track of optimizedTracks) {
    for (const segment of track.segments) {
      optimizedPoints.push(...segment.points);
    }
  }
  const optimizedStats = calculateStats(optimizedPoints, optimizedContent);

  // Validation checks
  if (originalStats.distance > 0) {
    const distanceChange = (optimizedStats.distance - originalStats.distance) / originalStats.distance;
    if (Math.abs(distanceChange) > opts.maxDistanceChangeRatio) {
      const direction = distanceChange > 0 ? 'increased' : 'decreased';
      warnings.push(`Distance ${direction} by ${(Math.abs(distanceChange) * 100).toFixed(1)}% (threshold: ${(opts.maxDistanceChangeRatio * 100).toFixed(1)}%)`);
    }
  }

  if (originalStats.elevationGain > 0) {
    const elevationChange = (optimizedStats.elevationGain - originalStats.elevationGain) / originalStats.elevationGain;
    if (Math.abs(elevationChange) > opts.maxElevationChangeRatio) {
      const direction = elevationChange > 0 ? 'increased' : 'decreased';
      warnings.push(`Elevation gain ${direction} by ${(Math.abs(elevationChange) * 100).toFixed(1)}% (threshold: ${(opts.maxElevationChangeRatio * 100).toFixed(1)}%)`);
    }
  }


  if (optimizedStats.pointCount < 2) {
    warnings.push('Warning: Less than 2 points after optimization');
  }

  // Generate output filename
  const outputFilename = filename.replace(/\.gpx$/i, '-optimized.gpx');

  return {
    filename: outputFilename,
    content: optimizedContent,
    original: originalStats,
    optimized: optimizedStats,
    warnings,
    passed: warnings.length === 0
  };
}

/**
 * Batch process multiple GPX files
 */
export function optimizeGpxBatch(
  files: Array<{ name: string; content: string }>,
  options: Partial<OptimizationOptions> = {}
): OptimizationResult[] {
  return files.map(file => optimizeGpx(file.content, file.name, options));
}
