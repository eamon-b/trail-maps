/**
 * GPX Processing Engine for React Native
 *
 * Ports the build-time GPX processing pipeline to work at runtime in React
 * Native. Takes raw GPX content and produces a ProcessedTrail compatible with
 * the Trail type used by the mobile app.
 *
 * Pipeline:
 * 1. Parse GPX XML (via fast-xml-parser based parser)
 * 2. Merge track segments into a single continuous route (MVP: all as main)
 * 3. Douglas-Peucker simplification for display points
 * 4. Elevation spike removal and smoothing
 * 5. Waypoint-to-track snapping with hysteresis
 * 6. Waypoint classification and enrichment
 * 7. Distance and elevation calculation
 */

import type { GpxData, GpxPoint, GpxWaypoint } from '@lib/types';
import { haversineDistance, haversineDistance3D } from '@lib/distance';
import { classifyWaypoint } from '@lib/waypoint-classifier';
import { parseGpx, validateFileSize, GpxParseError } from './gpx-parser';
import type { Trail, TrackPoint, TrailWaypoint } from './trail-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the processing pipeline. */
export interface ProcessingOptions {
  /** Douglas-Peucker tolerance in meters (default: 10) */
  simplificationTolerance?: number;
  /** Whether to smooth elevation data (default: true) */
  elevationSmoothing?: boolean;
  /** Moving average window for elevation smoothing (default: 7) */
  elevationSmoothingWindow?: number;
  /** Max elevation change in meters to consider a spike (default: 50) */
  spikeThreshold?: number;
  /** Coordinate decimal places (default: 6) */
  coordinatePrecision?: number;
  /** Max target display points for simplification (default: 3000) */
  targetDisplayPoints?: number;
  /** Max distance in meters from track to snap a waypoint (default: 500) */
  waypointMaxDistance?: number;
  /** Trail name override (default: extracted from GPX metadata) */
  trailName?: string;
  /** Trail ID override (default: generated from name) */
  trailId?: string;
  /** Progress callback */
  onProgress?: (stage: string, percent: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<ProcessingOptions, 'onProgress' | 'trailName' | 'trailId'>> = {
  simplificationTolerance: 10,
  elevationSmoothing: true,
  elevationSmoothingWindow: 7,
  spikeThreshold: 50,
  coordinatePrecision: 6,
  targetDisplayPoints: 3000,
  waypointMaxDistance: 500,
};

/** A warning or informational flag about the processed data. */
export interface ProcessingWarning {
  type:
    | 'no_elevation'
    | 'elevation_spikes_smoothed'
    | 'invalid_coordinates_skipped'
    | 'duplicate_points_removed'
    | 'track_gaps'
    | 'no_waypoints'
    | 'orphaned_waypoints'
    | 'no_tracks';
  message: string;
  count?: number;
}

/** Result of the processing pipeline. */
export interface ProcessingResult {
  trail: Trail;
  warnings: ProcessingWarning[];
}

// ---------------------------------------------------------------------------
// Track processing algorithms (ported from src/lib/gpx-optimizer.ts)
// These are pure math — copied here to avoid importing the browser-dependent
// gpx-optimizer module.
// ---------------------------------------------------------------------------

const EARTH_RADIUS_METERS = 6371000;

/**
 * Perpendicular distance from a point to a line segment.
 * Uses equirectangular approximation (accurate for short distances).
 */
function perpendicularDistance(
  point: GpxPoint,
  lineStart: GpxPoint,
  lineEnd: GpxPoint,
): number {
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const lat1 = toRadians(lineStart.lat);
  const lat2 = toRadians(lineEnd.lat);
  const latP = toRadians(point.lat);
  const lon1 = toRadians(lineStart.lon);
  const lon2 = toRadians(lineEnd.lon);
  const lonP = toRadians(point.lon);

  const cosAvg = Math.cos((lat1 + lat2) / 2);
  const x1 = lon1 * cosAvg * EARTH_RADIUS_METERS;
  const y1 = lat1 * EARTH_RADIUS_METERS;
  const x2 = lon2 * cosAvg * EARTH_RADIUS_METERS;
  const y2 = lat2 * EARTH_RADIUS_METERS;
  const xP = lonP * cosAvg * EARTH_RADIUS_METERS;
  const yP = latP * EARTH_RADIUS_METERS;

  const lineLengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lineLengthSq === 0) {
    return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  }

  const t = Math.max(
    0,
    Math.min(1, ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lineLengthSq),
  );
  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);

  return Math.sqrt((xP - projX) ** 2 + (yP - projY) ** 2);
}

/** Douglas-Peucker line simplification (iterative to avoid stack overflow). */
export function douglasPeucker(points: GpxPoint[], tolerance: number): GpxPoint[] {
  if (points.length <= 2) return points;

  const keep: boolean[] = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

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

/** Remove elevation spikes (points that deviate sharply from both neighbors). */
export function removeElevationSpikes(
  points: GpxPoint[],
  spikeThreshold: number,
): { points: GpxPoint[]; spikeCount: number } {
  if (points.length < 3) return { points, spikeCount: 0 };

  const isSpike: boolean[] = new Array(points.length).fill(false);
  let spikeCount = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const diffFromPrev = points[i].ele - points[i - 1].ele;
    const diffFromNext = points[i].ele - points[i + 1].ele;

    const sameDirection =
      (diffFromPrev > 0 && diffFromNext > 0) || (diffFromPrev < 0 && diffFromNext < 0);
    const exceedsThreshold =
      Math.abs(diffFromPrev) > spikeThreshold && Math.abs(diffFromNext) > spikeThreshold;

    if (sameDirection && exceedsThreshold) {
      isSpike[i] = true;
      spikeCount++;
    }
  }

  if (spikeCount === 0) return { points, spikeCount: 0 };

  const result: GpxPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!isSpike[i]) {
      result.push({ ...points[i] });
    } else {
      let prevIdx = i - 1;
      while (prevIdx >= 0 && isSpike[prevIdx]) prevIdx--;
      let nextIdx = i + 1;
      while (nextIdx < points.length && isSpike[nextIdx]) nextIdx++;

      let interpolatedEle: number;
      if (prevIdx >= 0 && nextIdx < points.length) {
        const weight = (i - prevIdx) / (nextIdx - prevIdx);
        interpolatedEle = points[prevIdx].ele + weight * (points[nextIdx].ele - points[prevIdx].ele);
      } else if (prevIdx >= 0) {
        interpolatedEle = points[prevIdx].ele;
      } else if (nextIdx < points.length) {
        interpolatedEle = points[nextIdx].ele;
      } else {
        interpolatedEle = points[i].ele;
      }

      result.push({ ...points[i], ele: interpolatedEle });
    }
  }

  return { points: result, spikeCount };
}

/** Apply moving average smoothing to elevation data. */
export function smoothElevation(points: GpxPoint[], windowSize: number): GpxPoint[] {
  if (points.length < windowSize) return points;

  const halfWindow = Math.floor(windowSize / 2);
  const result: GpxPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(points.length - 1, i + halfWindow);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= end; j++) {
      sum += points[j].ele;
      count++;
    }
    result.push({ ...points[i], ele: sum / count });
  }

  return result;
}

/** Round coordinates to specified precision. */
function roundCoordinates(points: GpxPoint[], precision: number): GpxPoint[] {
  const factor = Math.pow(10, precision);
  return points.map((p) => ({
    ...p,
    lat: Math.round(p.lat * factor) / factor,
    lon: Math.round(p.lon * factor) / factor,
    ele: Math.round(p.ele * 10) / 10,
  }));
}

// ---------------------------------------------------------------------------
// Coordinate validation
// ---------------------------------------------------------------------------

/** Check if a coordinate is within valid ranges. Rejects null island (0,0) as a common GPS error sentinel. */
function isValidCoordinate(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
}

/** Filter out invalid coordinates from a points array. */
function filterInvalidCoordinates(points: GpxPoint[]): { points: GpxPoint[]; removed: number } {
  const filtered = points.filter((p) => isValidCoordinate(p.lat, p.lon));
  return { points: filtered, removed: points.length - filtered.length };
}

// ---------------------------------------------------------------------------
// Duplicate point removal
// ---------------------------------------------------------------------------

/** Remove consecutive duplicate points. */
function deduplicateConsecutive(points: GpxPoint[]): { points: GpxPoint[]; removed: number } {
  if (points.length < 2) return { points, removed: 0 };

  const result: GpxPoint[] = [points[0]];
  let removed = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    if (points[i].lat !== prev.lat || points[i].lon !== prev.lon) {
      result.push(points[i]);
    } else {
      removed++;
    }
  }

  return { points: result, removed };
}

// ---------------------------------------------------------------------------
// Track merging with gap detection
// ---------------------------------------------------------------------------

const GAP_THRESHOLD_METERS = 500;

interface MergeResult {
  points: GpxPoint[];
  gaps: { afterIndex: number; distanceMeters: number }[];
}

/** Merge all track segments into a single point array, detecting gaps. */
function mergeTrackSegments(gpxData: GpxData): MergeResult {
  const allPoints: GpxPoint[] = [];
  const gaps: { afterIndex: number; distanceMeters: number }[] = [];

  // Collect all segments from all tracks (MVP: treat all as main route)
  const segments: GpxPoint[][] = [];
  for (const track of gpxData.tracks) {
    for (const segment of track.segments) {
      if (segment.points.length > 0) {
        segments.push(segment.points);
      }
    }
  }

  // Also include route points as a segment
  for (const route of gpxData.routes) {
    if (route.points.length > 0) {
      segments.push(route.points);
    }
  }

  for (const segPoints of segments) {
    if (allPoints.length > 0 && segPoints.length > 0) {
      const lastPoint = allPoints[allPoints.length - 1];
      const firstPoint = segPoints[0];
      const gap = haversineDistance(
        lastPoint.lat,
        lastPoint.lon,
        firstPoint.lat,
        firstPoint.lon,
      );

      if (gap > GAP_THRESHOLD_METERS) {
        gaps.push({
          afterIndex: allPoints.length - 1,
          distanceMeters: gap,
        });
      }
    }
    allPoints.push(...segPoints);
  }

  return { points: allPoints, gaps };
}

// ---------------------------------------------------------------------------
// Elevation analysis
// ---------------------------------------------------------------------------

/** Check if the track has any meaningful elevation data. */
function hasElevationData(points: GpxPoint[]): boolean {
  if (points.length === 0) return false;
  // Check if there's any non-zero elevation and if there's variation
  const firstEle = points[0].ele;
  return points.some((p) => p.ele !== 0 && p.ele !== firstEle);
}

// ---------------------------------------------------------------------------
// Waypoint processing
// ---------------------------------------------------------------------------

interface WaypointVisit {
  waypoint: GpxWaypoint;
  classifiedType: string;
  cleanedName: string;
  trackIndex: number;
  distanceFromTrack: number;
}

/**
 * Find waypoint visits along the route using hysteresis-based snapping.
 * Walks through track points and records a "visit" when the route passes
 * near a waypoint. Exit threshold is 3x entry threshold to prevent flickering.
 */
function findWaypointVisits(
  waypoints: GpxWaypoint[],
  trackPoints: GpxPoint[],
  maxDistanceMeters: number,
): WaypointVisit[] {
  if (trackPoints.length === 0 || waypoints.length === 0) return [];

  const visits: WaypointVisit[] = [];
  const exitThreshold = maxDistanceMeters * 3.0;

  const activeProximity: Map<number, { bestDistance: number; bestTrackIndex: number }> =
    new Map();

  for (let trackIdx = 0; trackIdx < trackPoints.length; trackIdx++) {
    const tp = trackPoints[trackIdx];

    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
      const wp = waypoints[wpIdx];
      const distance = haversineDistance(wp.lat, wp.lon, tp.lat, tp.lon);

      const existing = activeProximity.get(wpIdx);
      if (existing) {
        if (distance < existing.bestDistance) {
          existing.bestDistance = distance;
          existing.bestTrackIndex = trackIdx;
        }
        if (distance > exitThreshold) {
          const classification = classifyWaypoint(wp.name);
          visits.push({
            waypoint: wp,
            classifiedType: classification.type,
            cleanedName: classification.cleanedName,
            trackIndex: existing.bestTrackIndex,
            distanceFromTrack: existing.bestDistance,
          });
          activeProximity.delete(wpIdx);
        }
      } else if (distance <= maxDistanceMeters) {
        activeProximity.set(wpIdx, { bestDistance: distance, bestTrackIndex: trackIdx });
      }
    }
  }

  // Handle waypoints still inside at end of track
  for (const [wpIdx, data] of activeProximity.entries()) {
    const wp = waypoints[wpIdx];
    const classification = classifyWaypoint(wp.name);
    visits.push({
      waypoint: wp,
      classifiedType: classification.type,
      cleanedName: classification.cleanedName,
      trackIndex: data.bestTrackIndex,
      distanceFromTrack: data.bestDistance,
    });
  }

  visits.sort((a, b) => a.trackIndex - b.trackIndex);
  return visits;
}

/**
 * Calculate segment distance and elevation between two track point indices.
 */
function calculateSegmentStats(
  points: GpxPoint[],
  fromIndex: number,
  toIndex: number,
): { distanceKm: number; ascent: number; descent: number } {
  let distanceKm = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = fromIndex; i < toIndex && i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    distanceKm += haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon) / 1000;
    const elevDiff = p2.ele - p1.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  return { distanceKm, ascent, descent };
}

/**
 * Enrich waypoint visits with cumulative distance and elevation data.
 */
function enrichWaypoints(
  visits: WaypointVisit[],
  trackPoints: GpxPoint[],
): TrailWaypoint[] {
  const enriched: TrailWaypoint[] = [];
  let prevTrackIndex = 0;
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  for (const visit of visits) {
    const stats = calculateSegmentStats(trackPoints, prevTrackIndex, visit.trackIndex);
    runningDistance += stats.distanceKm;
    runningAscent += stats.ascent;
    runningDescent += stats.descent;

    const trackPoint = trackPoints[visit.trackIndex];

    enriched.push({
      name: visit.cleanedName,
      lat: visit.waypoint.lat,
      lon: visit.waypoint.lon,
      type: visit.classifiedType,
      description: visit.waypoint.desc || undefined,
      elevation: Math.round(trackPoint.ele),
      distance: Math.round(stats.distanceKm * 100) / 100,
      totalDistance: Math.round(runningDistance * 100) / 100,
      ascent: Math.round(stats.ascent),
      descent: Math.round(stats.descent),
      totalAscent: Math.round(runningAscent),
      totalDescent: Math.round(runningDescent),
      trackIndex: visit.trackIndex,
    });

    prevTrackIndex = visit.trackIndex;
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Adaptive simplification tolerance
// ---------------------------------------------------------------------------

const MIN_TOLERANCE_METERS = 5;
const DISTANCE_SCALE_FACTOR_KM = 500;
const TOLERANCE_MULTIPLIER = 5;

function calculateAdaptiveTolerance(
  pointCount: number,
  targetPoints: number,
  totalDistanceKm: number,
): number {
  if (pointCount <= targetPoints) return 0;
  const reductionRatio = pointCount / targetPoints;
  const scaleFactor =
    Math.log2(reductionRatio) * (1 + totalDistanceKm / DISTANCE_SCALE_FACTOR_KM);
  return MIN_TOLERANCE_METERS + scaleFactor * TOLERANCE_MULTIPLIER;
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

/**
 * Process a GPX string into a Trail object ready for display in the app.
 *
 * @param gpxContent - Raw GPX file content as a string
 * @param options - Processing options
 * @returns Processed trail and any warnings
 * @throws GpxParseError for invalid input
 */
export function processGpx(
  gpxContent: string,
  options?: ProcessingOptions,
): ProcessingResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: ProcessingWarning[] = [];
  const progress = opts.onProgress ?? (() => {});

  // --- Stage 1: Parse ---
  progress('Parsing GPX', 0);
  const gpxData = parseGpx(gpxContent);

  // --- Stage 2: Merge track segments ---
  progress('Merging tracks', 10);
  const { points: rawPoints, gaps } = mergeTrackSegments(gpxData);

  if (rawPoints.length === 0) {
    throw new GpxParseError('GPX file has no track data');
  }

  if (gaps.length > 0) {
    warnings.push({
      type: 'track_gaps',
      message: `Found ${gaps.length} gap(s) >500m between track segments`,
      count: gaps.length,
    });
  }

  // --- Stage 3: Validate and clean points ---
  progress('Validating points', 20);
  let points = rawPoints;

  // Filter invalid coordinates
  const coordResult = filterInvalidCoordinates(points);
  if (coordResult.removed > 0) {
    warnings.push({
      type: 'invalid_coordinates_skipped',
      message: `Skipped ${coordResult.removed} point(s) with invalid coordinates`,
      count: coordResult.removed,
    });
    points = coordResult.points;
  }

  // Remove consecutive duplicates
  const dedupResult = deduplicateConsecutive(points);
  if (dedupResult.removed > 0) {
    warnings.push({
      type: 'duplicate_points_removed',
      message: `Removed ${dedupResult.removed} duplicate consecutive point(s)`,
      count: dedupResult.removed,
    });
    points = dedupResult.points;
  }

  if (points.length < 2) {
    throw new GpxParseError('GPX file has fewer than 2 valid track points after cleaning');
  }

  // --- Stage 4: Elevation processing ---
  progress('Processing elevation', 30);
  const hasElevation = hasElevationData(points);

  if (!hasElevation) {
    warnings.push({
      type: 'no_elevation',
      message: 'No elevation data found - elevation profile will be flat',
    });
  }

  if (hasElevation && opts.elevationSmoothing) {
    // Remove spikes first
    const spikeResult = removeElevationSpikes(points, opts.spikeThreshold);
    if (spikeResult.spikeCount > 0) {
      warnings.push({
        type: 'elevation_spikes_smoothed',
        message: `Smoothed ${spikeResult.spikeCount} elevation spike(s)`,
        count: spikeResult.spikeCount,
      });
      points = spikeResult.points;
    }

    // Then smooth
    if (opts.elevationSmoothingWindow > 1) {
      points = smoothElevation(points, opts.elevationSmoothingWindow);
    }
  }

  // --- Stage 5: Round coordinates ---
  progress('Rounding coordinates', 40);
  points = roundCoordinates(points, opts.coordinatePrecision);

  // --- Stage 6: Calculate cumulative distance and elevation ---
  progress('Calculating distances', 50);
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;

  const trackPoints: TrackPoint[] = points.map((p, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      totalDistance += haversineDistance(prev.lat, prev.lon, p.lat, p.lon) / 1000;
      const elevDiff = p.ele - prev.ele;
      if (elevDiff > 0) totalAscent += elevDiff;
      else totalDescent += Math.abs(elevDiff);
    }
    return {
      lat: p.lat,
      lon: p.lon,
      ele: p.ele,
      dist: totalDistance,
    };
  });

  // --- Stage 7: Simplify for display ---
  progress('Simplifying track', 60);
  let displayPoints: TrackPoint[] = trackPoints;

  if (trackPoints.length > opts.targetDisplayPoints) {
    const tolerance = calculateAdaptiveTolerance(
      trackPoints.length,
      opts.targetDisplayPoints,
      totalDistance,
    );
    const simplified = douglasPeucker(
      trackPoints.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: null })),
      tolerance,
    );
    // Map simplified points back to TrackPoints with cumulative distances
    const pointMap = new Map(trackPoints.map((p) => [`${p.lat},${p.lon}`, p]));
    displayPoints = simplified.map((sp) => {
      const original = pointMap.get(`${sp.lat},${sp.lon}`);
      return original || { lat: sp.lat, lon: sp.lon, ele: sp.ele, dist: 0 };
    });
  }

  // --- Stage 8: Process waypoints ---
  progress('Processing waypoints', 75);
  const gpxWaypoints = gpxData.waypoints;

  if (gpxWaypoints.length === 0) {
    warnings.push({
      type: 'no_waypoints',
      message: 'No waypoints found in GPX file',
    });
  }

  const visits = findWaypointVisits(gpxWaypoints, points, opts.waypointMaxDistance);
  const enrichedWaypoints = enrichWaypoints(visits, points);

  // Find orphaned waypoints (not matched to track)
  const matchedKeys = new Set(
    visits.map((v) => `${v.waypoint.lat},${v.waypoint.lon}`),
  );
  const orphanedCount = gpxWaypoints.filter(
    (wp) => !matchedKeys.has(`${wp.lat},${wp.lon}`),
  ).length;

  if (orphanedCount > 0) {
    warnings.push({
      type: 'orphaned_waypoints',
      message: `${orphanedCount} waypoint(s) too far from track (>${opts.waypointMaxDistance}m)`,
      count: orphanedCount,
    });
  }

  // --- Stage 9: Build result ---
  progress('Finalizing', 95);

  // Derive trail name and ID
  const firstTrackName = gpxData.tracks[0]?.name || gpxData.routes[0]?.name || '';
  const trailName = opts.trailName || firstTrackName || 'Custom Trail';
  const trailId =
    opts.trailId ||
    trailName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const trail: Trail = {
    config: {
      id: trailId,
      name: trailName,
      shortName: trailName.length > 10 ? trailName.substring(0, 10).toUpperCase() : trailName.toUpperCase(),
      region: 'Custom',
      lengthKm: Math.round(totalDistance * 10) / 10,
      direction: { default: 'Start to End', reversed: 'End to Start' },
    },
    track: {
      points: trackPoints,
      displayPoints,
      totalDistance,
      totalAscent,
      totalDescent,
    },
    waypoints: enrichedWaypoints,
    alternates: [],
    sideTrips: [],
  };

  progress('Complete', 100);

  return { trail, warnings };
}

/**
 * Process a GPX file from an ArrayBuffer (e.g., from file picker).
 * Validates file size before parsing.
 *
 * @param gpxBytes - Raw file bytes
 * @param options - Processing options
 * @returns Processed trail and warnings
 * @throws GpxParseError for invalid input or file too large
 */
export function processGpxBytes(
  gpxBytes: ArrayBuffer,
  options?: ProcessingOptions,
): ProcessingResult {
  validateFileSize(gpxBytes.byteLength);

  // Decode bytes to string
  const decoder = new TextDecoder('utf-8');
  const gpxContent = decoder.decode(gpxBytes);

  return processGpx(gpxContent, options);
}

/**
 * Async wrapper around processGpx that yields to the JS event loop between
 * processing stages. Prevents blocking the UI thread for large files.
 *
 * Use this from UI code instead of processGpx directly.
 */
export async function processGpxAsync(
  gpxContent: string,
  options?: ProcessingOptions,
): Promise<ProcessingResult> {
  // Yield before starting to let any pending UI updates flush
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return processGpx(gpxContent, options);
}

/**
 * Async variant of processGpxBytes.
 */
export async function processGpxBytesAsync(
  gpxBytes: ArrayBuffer,
  options?: ProcessingOptions,
): Promise<ProcessingResult> {
  validateFileSize(gpxBytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const gpxContent = decoder.decode(gpxBytes);
  return processGpxAsync(gpxContent, options);
}

export { GpxParseError };
