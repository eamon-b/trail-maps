import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { JSDOM } from 'jsdom';
import { haversineDistance as haversineDistanceMeters } from '../src/lib/distance.js';
import { douglasPeucker } from '../src/lib/gpx-optimizer.js';
import { classifyTracks, combineTracksGeographically } from '../src/lib/track-classification.js';
import { classifyWaypoint } from '../src/lib/waypoint-classifier.js';
import type { TrackClassificationConfig, GpxPoint as LibGpxPoint } from '../src/lib/types.js';

/** Calculate haversine distance in km */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

// Simplification tolerance constants (in meters)
// These were empirically tuned to balance visual fidelity vs rendering performance:
// - MIN_TOLERANCE_METERS: Minimum perpendicular distance for point removal.
//   Below 5m, removed points are imperceptible at typical map zoom levels.
// - DISTANCE_SCALE_FACTOR_KM: Longer trails can tolerate larger tolerances since
//   users zoom out more. 500km normalizes so a 500km trail gets ~2x base tolerance.
// - TOLERANCE_MULTIPLIER: Scales the logarithmic reduction factor. Higher values
//   remove more points but may lose detail on sharp switchbacks.
const MIN_TOLERANCE_METERS = 5;
const DISTANCE_SCALE_FACTOR_KM = 500;
const TOLERANCE_MULTIPLIER = 5;

/**
 * Calculate an adaptive simplification tolerance based on point count.
 * Returns tolerance in meters that should result in approximately `targetPoints` points.
 *
 * Uses a heuristic based on trail length and point density:
 * - More points relative to distance = higher tolerance needed
 * - Starts with a baseline and scales logarithmically
 */
function calculateAdaptiveTolerance(
  points: { lat: number; lon: number }[],
  targetPoints: number,
  totalDistanceKm: number
): number {
  if (points.length <= targetPoints) return 0;

  // Ratio of how much we need to reduce
  const reductionRatio = points.length / targetPoints;

  // Base tolerance scales with trail length (longer trails can have larger tolerance)
  // and reduction ratio (more points to remove = higher tolerance)
  const scaleFactor = Math.log2(reductionRatio) * (1 + totalDistanceKm / DISTANCE_SCALE_FACTOR_KM);

  return MIN_TOLERANCE_METERS + scaleFactor * TOLERANCE_MULTIPLIER;
}

interface ClimateLocationConfig {
  name: string;
  waypointName?: string;
  lat: number;
  lon: number;
}

interface DirectionConfig {
  default: string;
  reversed: string;
}

interface TrailConfig {
  id: string;
  name: string;
  shortName: string;
  region: string;
  lengthKm: number;
  gpxFile: string;
  geojsonFile?: string;  // CalTopo GeoJSON file for alternates/side trips
  trackClassification?: TrackClassificationConfig;  // Patterns for multi-track GPX classification
  waypointMaxDistance?: number;  // Max distance (meters) from track to match waypoints (default 500)
  waypointsFile?: string;  // Now optional - can extract from GPX
  climateFile?: string;
  climateLocations?: ClimateLocationConfig[];
  description?: string;
  direction?: DirectionConfig;
}

interface GpxPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string | null;
}

interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  type: string;
  description?: string;
}

interface EnrichedWaypoint extends Waypoint {
  elevation: number;
  distance: number;        // segment distance from previous waypoint (km)
  totalDistance: number;   // cumulative distance along route (km)
  ascent: number;          // segment ascent from previous waypoint (m)
  descent: number;         // segment descent from previous waypoint (m)
  totalAscent: number;     // cumulative ascent (m)
  totalDescent: number;    // cumulative descent (m)
  trackIndex: number;      // index in track points array
}

interface WaypointVisit {
  waypoint: Waypoint;
  trackIndex: number;
  distanceFromTrack: number;
}

interface VariantWaypoint {
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation: number;
  distance: number;        // segment distance from previous waypoint
  totalDistance: number;   // cumulative distance along variant
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
  description?: string;
}

interface RouteVariant {
  name: string;
  type: 'alternate' | 'side-trip';
  points: { lat: number; lon: number; ele: number }[];
  distance: number;
  elevation: { ascent: number; descent: number };
  // Junction point data - where variant connects to main route
  startDistance?: number;     // km along main route where it branches
  startTrackIndex?: number;   // index in track points array
  endDistance?: number;       // km where alternate rejoins (alternates only)
  endTrackIndex?: number;     // track index where it rejoins
  waypoints?: VariantWaypoint[];
}

interface OffTrailWaypoint extends Waypoint {
  distanceFromTrail: number;  // meters
}

interface ProcessedTrail {
  config: TrailConfig;
  track: {
    points: { lat: number; lon: number; ele: number; dist: number }[];
    displayPoints: { lat: number; lon: number; ele: number; dist: number }[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: EnrichedWaypoint[];
  offTrailWaypoints: OffTrailWaypoint[];
  alternates: RouteVariant[];
  sideTrips: RouteVariant[];
  climate: Record<string, unknown> | null;
  climateLocations: ClimateLocationConfig[] | null;
  direction: DirectionConfig | null;
}

interface CaltopoData {
  waypointCategories: Map<string, string>;
  waypointDescriptions: Map<string, string>;
  alternates: RouteVariant[];
  sideTrips: RouteVariant[];
}


// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
const TRAIL_PAGES_DIR = path.join(PROJECT_ROOT, 'src/web/trails');
const TRAIL_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'trail-template.html');
const CLIMATE_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'climate-template.html');

interface ParsedGpxTrack {
  name: string;
  points: GpxPoint[];
}

interface ParsedGpxResult {
  tracks: ParsedGpxTrack[];
  waypoints: Waypoint[];
  name: string | null;
}

/**
 * Parse GPX XML content using jsdom (for Node.js environment)
 * Extracts all tracks and waypoints for later classification
 */
function parseGpxNode(xml: string): ParsedGpxResult {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // Extract GPX name from metadata
  const gpxName = doc.querySelector('metadata name')?.textContent || null;

  // Get all tracks with their points
  const trkElements = doc.querySelectorAll('trk');
  const tracks: ParsedGpxTrack[] = [];

  for (const track of Array.from(trkElements) as Element[]) {
    const trackName = track.querySelector('name')?.textContent || 'Unnamed';
    const trackPoints = track.querySelectorAll('trkseg trkpt');
    const points = (Array.from(trackPoints) as Element[]).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null,
    }));
    tracks.push({ name: trackName, points });
  }

  // If no tracks found, try route points as a single "track"
  if (tracks.length === 0) {
    const routePoints = doc.querySelectorAll('rte rtept');
    if (routePoints.length > 0) {
      const points = (Array.from(routePoints) as Element[]).map(pt => ({
        lat: parseFloat(pt.getAttribute('lat') || '0'),
        lon: parseFloat(pt.getAttribute('lon') || '0'),
        ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
        time: pt.querySelector('time')?.textContent || null,
      }));
      tracks.push({ name: 'Route', points });
    }
  }

  // Extract waypoints from <wpt> elements
  const wptElements = doc.querySelectorAll('wpt');
  const waypoints: Waypoint[] = (Array.from(wptElements) as Element[]).map(wpt => {
    const rawName = wpt.querySelector('name')?.textContent || 'Unnamed';
    const classification = classifyWaypoint(rawName);
    return {
      name: classification.cleanedName,
      lat: parseFloat(wpt.getAttribute('lat') || '0'),
      lon: parseFloat(wpt.getAttribute('lon') || '0'),
      type: classification.type,
      description: wpt.querySelector('desc')?.textContent || undefined,
    };
  });

  return {
    tracks,
    waypoints,
    name: gpxName,
  };
}

/**
 * Select and combine main route tracks using classification.
 * Falls back to longest track if no classification config provided.
 */
function selectMainRoute(
  gpxData: ParsedGpxResult,
  config: TrailConfig
): { points: GpxPoint[]; classificationSummary: string; alternateTracks: ParsedGpxTrack[]; sideTripTracks: ParsedGpxTrack[] } {
  const classification = classifyTracks(
    gpxData.tracks.map(t => ({
      name: t.name,
      points: t.points.map(p => ({ ...p, time: p.time })) as LibGpxPoint[],
    })),
    config.trackClassification || {}
  );

  // Log classification results
  const parts: string[] = [];
  if (classification.mainTracks.length > 0) parts.push(`${classification.mainTracks.length} main`);
  if (classification.alternateTracks.length > 0) parts.push(`${classification.alternateTracks.length} alternates`);
  if (classification.sideTripTracks.length > 0) parts.push(`${classification.sideTripTracks.length} side trips`);
  if (classification.ignoredTracks.length > 0) parts.push(`${classification.ignoredTracks.length} ignored`);
  if (classification.unclassifiedTracks.length > 0) parts.push(`${classification.unclassifiedTracks.length} unclassified`);
  const classificationSummary = parts.length > 0 ? parts.join(', ') : 'no tracks';

  const alternateTracks: ParsedGpxTrack[] = classification.alternateTracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  }));
  const sideTripTracks: ParsedGpxTrack[] = classification.sideTripTracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  }));

  // No main tracks found
  if (classification.mainTracks.length === 0) {
    return { points: [], classificationSummary, alternateTracks, sideTripTracks };
  }

  // Single main track - return directly
  if (classification.mainTracks.length === 1) {
    return {
      points: classification.mainTracks[0].points,
      classificationSummary,
      alternateTracks,
      sideTripTracks,
    };
  }

  // Multiple main tracks - combine geographically
  const { combinedPoints, orderedNames, warnings } = combineTracksGeographically(
    classification.mainTracks.map(t => ({ name: t.name, points: t.points }))
  );

  // Log warnings about gaps
  for (const warning of warnings) {
    console.log(`  Warning: ${warning.gapMeters.toFixed(0)}m gap between "${warning.fromTrack}" and "${warning.toTrack}"`);
  }

  console.log(`  Combined ${orderedNames.length} tracks: ${orderedNames.slice(0, 3).join(', ')}${orderedNames.length > 3 ? '...' : ''}`);

  return { points: combinedPoints, classificationSummary, alternateTracks, sideTripTracks };
}

/**
 * Calculate distance and elevation for a set of points
 */
function calculateRouteStats(points: { lat: number; lon: number; ele: number }[]): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    distance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);

    const elevDiff = curr.ele - prev.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  return { distance, ascent, descent };
}

/**
 * Find the nearest point on the main track to a given point.
 * Returns the track index and distance from track.
 */
function findNearestTrackPoint(
  point: { lat: number; lon: number },
  trackPoints: { lat: number; lon: number; ele: number; dist?: number }[]
): { trackIndex: number; distanceFromTrack: number } {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < trackPoints.length; i++) {
    const trackPoint = trackPoints[i];
    const distance = haversineDistanceMeters(point.lat, point.lon, trackPoint.lat, trackPoint.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return { trackIndex: bestIndex, distanceFromTrack: bestDistance };
}

/**
 * Enrich route variants with junction point data.
 * Finds where each variant branches from and rejoins the main track.
 */
function findVariantJunctions(
  variants: RouteVariant[],
  trackPoints: { lat: number; lon: number; ele: number; dist: number }[],
  maxJunctionDistance: number = 500 // meters - variants should start/end within this distance of track
): RouteVariant[] {
  return variants.map(variant => {
    if (variant.points.length === 0) {
      return variant;
    }

    // Find where variant starts (branches from main track)
    const startPoint = variant.points[0];
    const startJunction = findNearestTrackPoint(startPoint, trackPoints);

    // Find where variant ends (rejoins main track for alternates)
    const endPoint = variant.points[variant.points.length - 1];
    const endJunction = findNearestTrackPoint(endPoint, trackPoints);

    // Only set junction data if within reasonable distance of track
    const enriched: RouteVariant = { ...variant };

    if (startJunction.distanceFromTrack <= maxJunctionDistance) {
      enriched.startTrackIndex = startJunction.trackIndex;
      enriched.startDistance = Math.round(trackPoints[startJunction.trackIndex].dist * 100) / 100;
    }

    // For alternates, also record where they rejoin
    // For side trips, only record end if it's a different point (loop back)
    if (endJunction.distanceFromTrack <= maxJunctionDistance) {
      const isSameAsStart = Math.abs(endJunction.trackIndex - startJunction.trackIndex) < 10;

      if (variant.type === 'alternate' || !isSameAsStart) {
        enriched.endTrackIndex = endJunction.trackIndex;
        enriched.endDistance = Math.round(trackPoints[endJunction.trackIndex].dist * 100) / 100;
      }
    }

    return enriched;
  });
}

/**
 * Find all waypoint visits along the route.
 * Walks through track points and records a "visit" when the route passes near a waypoint.
 *
 * Uses hysteresis to prevent "flickering" - the exit threshold is larger than
 * the entry threshold, so the track must move significantly away before a new
 * visit can be recorded for the same waypoint.
 */
function findWaypointVisits(
  waypoints: Waypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number = 200
): WaypointVisit[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits: WaypointVisit[] = [];

  // Hysteresis: exit threshold is 200% larger (3x) than entry threshold
  // This prevents flickering when the track oscillates around the threshold boundary
  // E.g., with 200m entry threshold, must exit past 600m before a new visit can start
  const exitThreshold = maxDistanceMeters * 3.0;

  const activeProximity: Map<number, { bestDistance: number; bestTrackIndex: number }> = new Map();

  for (let trackIdx = 0; trackIdx < trackPoints.length; trackIdx++) {
    const trackPoint = trackPoints[trackIdx];

    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
      const waypoint = waypoints[wpIdx];
      const distance = haversineDistanceMeters(waypoint.lat, waypoint.lon, trackPoint.lat, trackPoint.lon);

      const existing = activeProximity.get(wpIdx);

      if (existing) {
        // Already tracking this waypoint
        if (distance < existing.bestDistance) {
          // Update if this is closer
          existing.bestDistance = distance;
          existing.bestTrackIndex = trackIdx;
        }
        // Use exit threshold (with hysteresis) to determine when to record visit
        if (distance > exitThreshold) {
          // Exited the hysteresis zone - record the visit at the best point
          visits.push({
            waypoint: waypoints[wpIdx],
            trackIndex: existing.bestTrackIndex,
            distanceFromTrack: existing.bestDistance,
          });
          activeProximity.delete(wpIdx);
        }
      } else if (distance <= maxDistanceMeters) {
        // Not tracking yet and within entry threshold - start tracking
        activeProximity.set(wpIdx, { bestDistance: distance, bestTrackIndex: trackIdx });
      }
    }
  }

  // Handle waypoints still inside at end of track
  for (const [wpIdx, data] of activeProximity.entries()) {
    visits.push({
      waypoint: waypoints[wpIdx],
      trackIndex: data.bestTrackIndex,
      distanceFromTrack: data.bestDistance,
    });
  }

  visits.sort((a, b) => a.trackIndex - b.trackIndex);
  return visits;
}

/**
 * Calculate segment statistics between two track indices
 */
function calculateSegmentStats(
  points: { lat: number; lon: number; ele: number }[],
  fromIndex: number,
  toIndex: number
): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = fromIndex; i < toIndex && i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    distance += haversineDistanceKm(p1.lat, p1.lon, p2.lat, p2.lon);

    const elevDiff = p2.ele - p1.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  return { distance, ascent, descent };
}

/**
 * Enrich waypoints with distance and elevation data by matching to track
 */
function enrichWaypoints(
  waypoints: Waypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number = 500
): EnrichedWaypoint[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits = findWaypointVisits(waypoints, trackPoints, maxDistanceMeters);

  if (visits.length === 0) {
    return [];
  }

  const enriched: EnrichedWaypoint[] = [];
  let prevTrackIndex = 0;
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  for (const visit of visits) {
    const segmentStats = calculateSegmentStats(trackPoints, prevTrackIndex, visit.trackIndex);

    runningDistance += segmentStats.distance;
    runningAscent += segmentStats.ascent;
    runningDescent += segmentStats.descent;

    const trackPoint = trackPoints[visit.trackIndex];

    enriched.push({
      ...visit.waypoint,
      elevation: Math.round(trackPoint.ele),
      distance: Math.round(segmentStats.distance * 100) / 100,
      totalDistance: Math.round(runningDistance * 100) / 100,
      ascent: Math.round(segmentStats.ascent),
      descent: Math.round(segmentStats.descent),
      totalAscent: Math.round(runningAscent),
      totalDescent: Math.round(runningDescent),
      trackIndex: visit.trackIndex,
    });

    prevTrackIndex = visit.trackIndex;
  }

  return enriched;
}

/**
 * Enrich route variants with waypoint data.
 * For each variant, walks along its track points and matches nearby waypoints
 * using the same hysteresis approach as the main route.
 */
function enrichVariantWaypoints(
  variants: RouteVariant[],
  waypoints: Waypoint[]
): RouteVariant[] {
  if (waypoints.length === 0) return variants;

  return variants.map(variant => {
    if (variant.points.length === 0) return variant;

    const visits = findWaypointVisits(waypoints, variant.points);
    if (visits.length === 0) return variant;

    const variantWaypoints: VariantWaypoint[] = [];
    let prevTrackIndex = 0;
    let runningDistance = 0;
    let runningAscent = 0;
    let runningDescent = 0;

    for (const visit of visits) {
      const segmentStats = calculateSegmentStats(variant.points, prevTrackIndex, visit.trackIndex);

      runningDistance += segmentStats.distance;
      runningAscent += segmentStats.ascent;
      runningDescent += segmentStats.descent;

      const trackPoint = variant.points[visit.trackIndex];

      variantWaypoints.push({
        name: visit.waypoint.name,
        type: visit.waypoint.type,
        lat: visit.waypoint.lat,
        lon: visit.waypoint.lon,
        elevation: Math.round(trackPoint.ele),
        distance: Math.round(segmentStats.distance * 100) / 100,
        totalDistance: Math.round(runningDistance * 100) / 100,
        ascent: Math.round(segmentStats.ascent),
        descent: Math.round(segmentStats.descent),
        totalAscent: Math.round(runningAscent),
        totalDescent: Math.round(runningDescent),
        variantTrackIndex: visit.trackIndex,
        description: visit.waypoint.description,
      });

      prevTrackIndex = visit.trackIndex;
    }

    return { ...variant, waypoints: variantWaypoints };
  });
}

/**
 * Parse CalTopo GeoJSON for waypoint categorization, descriptions, and route variants
 */
function parseCaltopoGeojson(jsonPath: string): CaltopoData {
  const result: CaltopoData = {
    waypointCategories: new Map<string, string>(),
    waypointDescriptions: new Map<string, string>(),
    alternates: [],
    sideTrips: [],
  };

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const geojson = JSON.parse(content);

    // Build folder ID -> name map
    const folderNames = new Map<string, string>();
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Folder') {
        folderNames.set(feature.id, feature.properties.title?.toLowerCase() || '');
      }
    }

    // Process markers (waypoints)
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Marker') {
        const rawName = feature.properties.title || '';
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Use classifyWaypoint with folder info to get type and cleaned name
        const classification = classifyWaypoint(rawName, { folderName });

        // Key by cleaned name for easier matching with GPX waypoints
        result.waypointCategories.set(classification.cleanedName, classification.type);

        // Extract description if available (also keyed by cleaned name)
        if (feature.properties.description) {
          result.waypointDescriptions.set(classification.cleanedName, feature.properties.description);
        }
      }
    }

    // Process shapes (lines) for alternates and side trips
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Shape' &&
          feature.geometry?.type === 'LineString' &&
          feature.geometry?.coordinates?.length > 0) {

        const title = feature.properties.title || 'Unnamed';
        const titleLower = title.toLowerCase();
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Determine if this is an alternate or side trip
        const isAlternate = titleLower.includes('alt') || folderName.includes('alternate');
        const isSideTrip = titleLower.startsWith('st ') || titleLower.startsWith('st:') ||
                          folderName.includes('side trip');

        if (isAlternate || isSideTrip) {
          // Convert coordinates [lon, lat, ele, ?] to points
          const points = feature.geometry.coordinates.map((coord: number[]) => ({
            lat: coord[1],
            lon: coord[0],
            ele: coord[2] || 0,
          }));

          const stats = calculateRouteStats(points);

          const variant: RouteVariant = {
            name: title,
            type: isAlternate ? 'alternate' : 'side-trip',
            points,
            distance: Math.round(stats.distance * 10) / 10,
            elevation: {
              ascent: Math.round(stats.ascent),
              descent: Math.round(stats.descent),
            },
          };

          if (isAlternate) {
            result.alternates.push(variant);
          } else {
            result.sideTrips.push(variant);
          }
        }
      }
    }
  } catch (e) {
    // GeoJSON parsing failed, fall back to GPX-only
    console.log(`  Warning: Could not parse GeoJSON: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  return result;
}

/**
 * Find the first GPX file in a directory
 */
function findGpxFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  const gpxFile = files.find(f => f.toLowerCase().endsWith('.gpx'));
  return gpxFile || null;
}

/**
 * Find a CalTopo GeoJSON file in a directory.
 * If explicitFile is provided, use that. Otherwise, auto-detect by finding
 * JSON files with a features array (excluding trail.json and climate.json).
 */
function findGeojsonFile(trailDir: string, explicitFile?: string): string | null {
  // If explicitly specified, use that
  if (explicitFile) {
    const filePath = path.join(trailDir, explicitFile);
    if (fs.existsSync(filePath)) {
      return explicitFile;
    }
    console.log(`  Warning: Specified geojsonFile not found: ${explicitFile}`);
  }

  // Auto-detect: find JSON files that look like GeoJSON (have features array)
  const files = fs.readdirSync(trailDir);
  const jsonFiles = files.filter(f =>
    f.toLowerCase().endsWith('.json') &&
    f !== 'trail.json' &&
    f !== 'climate.json'
  );

  for (const file of jsonFiles) {
    try {
      const content = fs.readFileSync(path.join(trailDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.features)) {
        return file;  // This is a GeoJSON file
      }
    } catch {
      // Not valid JSON or can't read, skip
    }
  }

  return null;
}

/**
 * Generate trail.json config from GPX file analysis
 */
function generateTrailConfig(trailDir: string, gpxFile: string, gpxData: ParsedGpxResult, mainRoutePoints: GpxPoint[]): TrailConfig {
  const trailId = path.basename(trailDir).toLowerCase();

  // Calculate total distance from main route points
  let totalDistance = 0;
  for (let i = 1; i < mainRoutePoints.length; i++) {
    const prev = mainRoutePoints[i - 1];
    const curr = mainRoutePoints[i];
    totalDistance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);
  }

  // Derive name from GPX metadata or directory name
  const gpxName = gpxData.name;
  const dirName = path.basename(trailDir);
  const name = gpxName || dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    id: trailId,
    name,
    shortName: dirName.toUpperCase(),
    region: 'Unknown',  // User should fill this in
    lengthKm: Math.round(totalDistance * 10) / 10,
    gpxFile,
    description: `Trail data auto-generated from ${gpxFile}. Edit trail.json to customize.`,
  };
}


function validateDataDirectory(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Note: Data directory does not exist: ${DATA_DIR}`);
    console.log('Creating directory structure...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('');
    console.log('To add trail data, create directories like:');
    console.log('  data/trails/');
    console.log('    └── trail-id/');
    console.log('        ├── trail.json');
    console.log('        ├── track.gpx');
    console.log('        └── waypoints.csv');
    console.log('');
  }

  const entries = fs.readdirSync(DATA_DIR);
  const trailDirs = entries.filter(name => {
    const fullPath = path.join(DATA_DIR, name);
    return fs.statSync(fullPath).isDirectory();
  });

  if (trailDirs.length === 0) {
    console.log('Note: No trail directories found in', DATA_DIR);
    console.log('The build will complete but no trail data will be generated.');
    console.log('');
  }
}

function validateTrailDirectory(trailDir: string): { errors: string[]; needsAutoConfig: boolean } {
  const errors: string[] = [];
  const trailId = path.basename(trailDir);
  let needsAutoConfig = false;

  const configPath = path.join(trailDir, 'trail.json');
  if (!fs.existsSync(configPath)) {
    // Check if we can auto-generate config from GPX
    const gpxFile = findGpxFile(trailDir);
    if (gpxFile) {
      needsAutoConfig = true;
      console.log(`  ${trailId}: No trail.json found, will auto-generate from ${gpxFile}`);
    } else {
      errors.push(`${trailId}: Missing trail.json and no GPX file found for auto-generation`);
    }
    return { errors, needsAutoConfig };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.gpxFile) {
      // Try to find GPX file automatically
      const gpxFile = findGpxFile(trailDir);
      if (!gpxFile) {
        errors.push(`${trailId}: trail.json missing gpxFile and no GPX file found`);
      }
    } else if (!fs.existsSync(path.join(trailDir, config.gpxFile))) {
      errors.push(`${trailId}: GPX file not found: ${config.gpxFile}`);
    }

    // waypointsFile is now optional - waypoints can come from GPX

    if (!config.id || !config.name) {
      errors.push(`${trailId}: trail.json missing required id or name field`);
    }
  } catch (e) {
    errors.push(`${trailId}: Invalid trail.json - ${e instanceof Error ? e.message : 'parse error'}`);
  }

  return { errors, needsAutoConfig };
}

async function processTrail(trailDir: string, autoGenConfig: boolean = false): Promise<ProcessedTrail> {
  const configPath = path.join(trailDir, 'trail.json');

  // Find GPX file
  let gpxFile: string;
  if (autoGenConfig) {
    gpxFile = findGpxFile(trailDir)!;
  } else {
    const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    gpxFile = existingConfig.gpxFile || findGpxFile(trailDir)!;
  }

  // Parse GPX
  const gpxPath = path.join(trailDir, gpxFile);
  const gpxContent = fs.readFileSync(gpxPath, 'utf-8');
  const gpxData = parseGpxNode(gpxContent);

  // Load config first (needed for track classification patterns)
  let config: TrailConfig;
  if (autoGenConfig) {
    // For auto-gen, create a minimal config first, then update after classification
    config = {
      id: path.basename(trailDir).toLowerCase(),
      name: gpxData.name || path.basename(trailDir),
      shortName: path.basename(trailDir).toUpperCase(),
      region: 'Unknown',
      lengthKm: 0,
      gpxFile,
    };
  } else {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Fill in gpxFile if missing
    if (!config.gpxFile) {
      config.gpxFile = gpxFile;
    }
  }

  // Select and combine main route tracks using classification
  const { points: mainRoutePoints, classificationSummary, alternateTracks, sideTripTracks: classifiedSideTrips } = selectMainRoute(gpxData, config);
  console.log(`  Classified: ${classificationSummary}`);

  // For auto-gen config, now generate the full config with distance calculated
  if (autoGenConfig) {
    config = generateTrailConfig(trailDir, gpxFile, gpxData, mainRoutePoints);
    // Write generated config for user to customize later
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  ✓ Generated trail.json`);
  }

  // Calculate cumulative distance and elevation
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;

  const points = mainRoutePoints.map((p, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      const dist = haversineDistanceKm(prev.lat, prev.lon, p.lat, p.lon);
      totalDistance += dist;

      const elevDiff = (p.ele || 0) - (prev.ele || 0);
      if (elevDiff > 0) totalAscent += elevDiff;
      else totalDescent += Math.abs(elevDiff);
    }
    return {
      lat: p.lat,
      lon: p.lon,
      ele: p.ele || 0,
      dist: totalDistance,
    };
  });

  // Simplify for map display (target ~3000 points for smooth rendering)
  const targetDisplayPoints = 3000;
  let displayPoints = points;

  if (points.length > targetDisplayPoints) {
    const tolerance = calculateAdaptiveTolerance(points, targetDisplayPoints, totalDistance);
    // douglasPeucker expects GpxPoint format with lat, lon, ele
    const simplified = douglasPeucker(
      points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: null })),
      tolerance
    );
    // Build a Map for O(1) lookup of original points by lat/lon
    // Douglas-Peucker returns references to original points, so exact equality works
    const pointMap = new Map(points.map(p => [`${p.lat},${p.lon}`, p]));
    displayPoints = simplified.map(sp => {
      const original = pointMap.get(`${sp.lat},${sp.lon}`);
      return original || { lat: sp.lat, lon: sp.lon, ele: sp.ele, dist: 0 };
    });
    console.log(`  ✓ Simplified ${points.length} → ${displayPoints.length} points for display`);
  }

  // Get waypoints - prefer GPX waypoints, fall back to CSV if specified
  let waypoints: Waypoint[] = gpxData.waypoints;
  let alternates: RouteVariant[] = [];
  let sideTrips: RouteVariant[] = [];

  // If GeoJSON exists, use it to enhance data
  const geojsonFile = findGeojsonFile(trailDir, config.geojsonFile);
  if (geojsonFile) {
    const geojsonPath = path.join(trailDir, geojsonFile);
    const caltopoData = parseCaltopoGeojson(geojsonPath);

    if (caltopoData.waypointCategories.size > 0) {
      console.log(`  ✓ Using ${geojsonFile} for waypoint categorization`);
      // Update waypoint types and descriptions from GeoJSON
      // Both GPX waypoints and GeoJSON categories are now keyed by cleaned name
      waypoints = waypoints.map(wp => {
        if (caltopoData.waypointCategories.has(wp.name)) {
          const desc = caltopoData.waypointDescriptions.get(wp.name);
          return {
            ...wp,
            type: caltopoData.waypointCategories.get(wp.name)!,
            description: desc || wp.description,
          };
        }
        return wp;
      });
    }

    // Add alternates and side trips from GeoJSON
    if (caltopoData.alternates.length > 0) {
      alternates = caltopoData.alternates;
      console.log(`  ✓ Found ${alternates.length} alternate routes from GeoJSON`);
    }
    if (caltopoData.sideTrips.length > 0) {
      sideTrips = caltopoData.sideTrips;
      console.log(`  ✓ Found ${sideTrips.length} side trips from GeoJSON`);
    }
  }

  // Convert classified GPX alternate tracks to RouteVariant[], merging with GeoJSON variants
  // GeoJSON takes precedence if names overlap
  const geojsonAlternateNames = new Set(alternates.map(a => a.name.toLowerCase()));
  for (const track of alternateTracks) {
    if (!geojsonAlternateNames.has(track.name.toLowerCase())) {
      const trackPoints3d = track.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
      const stats = calculateRouteStats(trackPoints3d);
      alternates.push({
        name: track.name,
        type: 'alternate',
        points: trackPoints3d,
        distance: Math.round(stats.distance * 10) / 10,
        elevation: {
          ascent: Math.round(stats.ascent),
          descent: Math.round(stats.descent),
        },
      });
    }
  }

  // Convert classified GPX side-trip tracks to RouteVariant[]
  const geojsonSideTripNames = new Set(sideTrips.map(s => s.name.toLowerCase()));
  for (const track of classifiedSideTrips) {
    if (!geojsonSideTripNames.has(track.name.toLowerCase())) {
      const trackPoints3d = track.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
      const stats = calculateRouteStats(trackPoints3d);
      sideTrips.push({
        name: track.name,
        type: 'side-trip',
        points: trackPoints3d,
        distance: Math.round(stats.distance * 10) / 10,
        elevation: {
          ascent: Math.round(stats.ascent),
          descent: Math.round(stats.descent),
        },
      });
    }
  }

  if (alternateTracks.length > 0 || classifiedSideTrips.length > 0) {
    const gpxAlts = alternates.length - (geojsonAlternateNames.size);
    const gpxSides = sideTrips.length - (geojsonSideTripNames.size);
    if (gpxAlts > 0) console.log(`  ✓ Added ${gpxAlts} alternate routes from GPX tracks`);
    if (gpxSides > 0) console.log(`  ✓ Added ${gpxSides} side trips from GPX tracks`);
  }

  // Fall back to CSV waypoints if no GPX waypoints and CSV exists
  if (waypoints.length === 0 && config.waypointsFile) {
    const waypointsPath = path.join(trailDir, config.waypointsFile);
    if (fs.existsSync(waypointsPath)) {
      const waypointsContent = fs.readFileSync(waypointsPath, 'utf-8');
      const waypointsResult = Papa.parse(waypointsContent, { header: true });
      waypoints = (waypointsResult.data as Record<string, unknown>[])
        .filter(row => row.name && row.lat && row.lon)
        .map(row => ({
          name: String(row.name),
          lat: parseFloat(String(row.lat)),
          lon: parseFloat(String(row.lon)),
          type: String(row.type || 'waypoint'),
          description: row.description ? String(row.description) : undefined,
        }));
    }
  }

  // Parse climate if exists (check config.climateFile or default climate.json)
  let climate: Record<string, unknown> | null = null;
  const climateFile = config.climateFile || 'climate.json';
  const climatePath = path.join(trailDir, climateFile);
  if (fs.existsSync(climatePath)) {
    climate = JSON.parse(fs.readFileSync(climatePath, 'utf-8'));
  }

  // Update config with calculated distance
  config.lengthKm = Math.round(totalDistance * 10) / 10;

  // Enrich waypoints with distance and elevation data
  const waypointMaxDist = config.waypointMaxDistance ?? 500;
  const enrichedWaypoints = enrichWaypoints(waypoints, mainRoutePoints, waypointMaxDist);

  // Enrich variants with junction point data (where they connect to main track)
  const enrichedAlternates = findVariantJunctions(alternates, points);
  const enrichedSideTrips = findVariantJunctions(sideTrips, points);

  // Enrich variants with waypoint data (which waypoints they pass through)
  const alternatesWithWaypoints = enrichVariantWaypoints(enrichedAlternates, waypoints);
  const sideTripsWithWaypoints = enrichVariantWaypoints(enrichedSideTrips, waypoints);

  // Identify off-trail waypoints (not matched even at the increased threshold)
  const matchedNames = new Set(enrichedWaypoints.map(ew => `${ew.name}|${ew.lat}|${ew.lon}`));
  const offTrailWaypoints: OffTrailWaypoint[] = waypoints
    .filter(wp => !matchedNames.has(`${wp.name}|${wp.lat}|${wp.lon}`))
    .map(wp => {
      const { distanceFromTrack } = findNearestTrackPoint(wp, points);
      return { ...wp, distanceFromTrail: Math.round(distanceFromTrack) };
    });

  if (offTrailWaypoints.length > 0) {
    console.log(`  ✓ ${offTrailWaypoints.length} off-trail waypoints (beyond ${waypointMaxDist}m threshold)`);
  }

  return {
    config,
    track: {
      points,
      displayPoints,
      totalDistance,
      totalAscent,
      totalDescent,
    },
    waypoints: enrichedWaypoints,
    offTrailWaypoints,
    alternates: alternatesWithWaypoints,
    sideTrips: sideTripsWithWaypoints,
    climate,
    climateLocations: config.climateLocations || null,
    direction: config.direction || null,
  };
}

/**
 * Generate an HTML page for a trail from the template
 */
function generateTrailPage(trail: ProcessedTrail): void {
  if (!fs.existsSync(TRAIL_TEMPLATE_PATH)) {
    console.log('  Note: Trail template not found, skipping HTML generation');
    return;
  }

  const template = fs.readFileSync(TRAIL_TEMPLATE_PATH, 'utf-8');

  // Replace placeholders
  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, trail.config.id)
    .replace(/\{\{TRAIL_NAME\}\}/g, trail.config.name)
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, trail.config.shortName || trail.config.name)
    .replace(/\{\{TRAIL_REGION\}\}/g, trail.config.region || 'Unknown');

  // Create trail directory and write HTML
  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

/**
 * Generate a climate page for a trail from the template
 */
function generateClimatePage(trail: ProcessedTrail): void {
  if (!fs.existsSync(CLIMATE_TEMPLATE_PATH)) {
    console.log('  Note: Climate template not found, skipping climate page generation');
    return;
  }

  const template = fs.readFileSync(CLIMATE_TEMPLATE_PATH, 'utf-8');

  // Replace placeholders
  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, trail.config.id)
    .replace(/\{\{TRAIL_NAME\}\}/g, trail.config.name)
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, trail.config.shortName || trail.config.name);

  // Create trail directory if it doesn't exist
  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'climate.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

async function main() {
  console.log('Trail Build Script');
  console.log('==================\n');

  // Validate data directory exists and has content
  validateDataDirectory();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Find all trail directories
  if (!fs.existsSync(DATA_DIR)) {
    console.log('No data directory found. Skipping trail processing.');
    // Write empty index
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  const trailDirs = fs.readdirSync(DATA_DIR)
    .map(name => path.join(DATA_DIR, name))
    .filter(p => fs.statSync(p).isDirectory());

  if (trailDirs.length === 0) {
    console.log('No trail directories found. Writing empty index.');
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  // Validate all trails before processing
  console.log(`Found ${trailDirs.length} trail directories\n`);
  console.log('Validating trail data...');

  const allErrors: string[] = [];
  const autoGenTrails = new Set<string>();

  for (const trailDir of trailDirs) {
    const { errors, needsAutoConfig } = validateTrailDirectory(trailDir);
    allErrors.push(...errors);
    if (needsAutoConfig) {
      autoGenTrails.add(trailDir);
    }
  }

  if (allErrors.length > 0) {
    console.error('\nValidation errors found:');
    allErrors.forEach(err => console.error(`  - ${err}`));
    console.error('\nFix these errors before building.');
    process.exit(1);
  }

  console.log('All trails validated successfully.\n');

  const trailIndex: { id: string; name: string; shortName: string; lengthKm: number }[] = [];

  for (const trailDir of trailDirs) {
    const trailId = path.basename(trailDir);
    const needsAutoGen = autoGenTrails.has(trailDir);
    console.log(`Processing: ${trailId}${needsAutoGen ? ' (auto-generating config)' : ''}`);

    try {
      const processed = await processTrail(trailDir, needsAutoGen);

      // Write processed data
      const outputPath = path.join(OUTPUT_DIR, `${processed.config.id}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(processed, null, 2));
      console.log(`  ✓ Written to ${outputPath}`);
      console.log(`    Distance: ${processed.track.totalDistance.toFixed(1)} km`);
      console.log(`    Elevation: +${Math.round(processed.track.totalAscent)}m / -${Math.round(processed.track.totalDescent)}m`);
      console.log(`    Waypoints: ${processed.waypoints.length} on-trail, ${processed.offTrailWaypoints.length} off-trail`);

      // Generate HTML pages for this trail
      generateTrailPage(processed);
      generateClimatePage(processed);

      trailIndex.push({
        id: processed.config.id,
        name: processed.config.name,
        shortName: processed.config.shortName,
        lengthKm: processed.config.lengthKm,
      });
    } catch (error) {
      console.error(`  ✗ Error processing ${trailId}:`, error);
    }
  }

  // Write trail index
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(trailIndex, null, 2));
  console.log(`\nTrail index written to ${indexPath}`);
}

main().catch(console.error);
