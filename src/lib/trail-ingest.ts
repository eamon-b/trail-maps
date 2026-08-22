/**
 * The trail ingestion pipeline: parsed GPX in, {@link ProcessedTrail} out.
 *
 * This is the code that used to live inside `scripts/build-trails.ts`'s
 * `processTrail`, lifted out so the build script, the web upload page and the
 * mobile importer all produce byte-identical trail objects from the same GPX.
 * Everything file-system-, CalTopo-, climate- and registry-shaped stayed in the
 * build script and reaches this module through the hooks on
 * {@link BuildTrailOptions}.
 *
 * Platform-neutral: no Node or DOM imports.
 */

import { haversineDistance as haversineDistanceMeters } from './distance';
import {
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  calculateElevationStats,
} from './gpx-optimizer';
import { classifyTracks, combineTracksGeographically } from './track-classification';
import { classifyWaypoint } from './waypoint-classifier';
import { cumulativeKm, detectSelfRetraces, extractSpur } from './track-spurs';
import {
  dedupeNearDuplicateWaypoints,
  WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS,
  type DedupableWaypoint,
} from './waypoint-dedupe';
import type { CombineTracksWarning, GpxData, GpxPoint } from './types';
import type {
  EnrichedWaypoint,
  OffTrailWaypoint,
  ProcessedTrail,
  RouteVariant,
  TrackPoint,
  TrailConfig,
  TrailWaypoint,
  VariantWaypoint,
  WaypointVisit,
} from './trail-types';

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

// Report main-route sections that double back on themselves for at least this
// many km. Purely advisory: most are the official route (e.g. the Bibbulmun's
// walk-ins to Collie and Denmark), so extraction is opt-in via `extractSpurs`.
// 2 km is low enough to surface Collie's 2.8 km walk-in and still silent on the
// five trails that have no retrace at all.
const SELF_RETRACE_WARN_KM = 2;

// Distance (metres) from a variant's track within which a waypoint counts as
// being on that variant. Deliberately tighter than the main route's
// `waypointMaxDistance`: variants are short and run close to the main route, so
// a loose threshold pulls in waypoints that belong to the through-route.
const VARIANT_WAYPOINT_MAX_DISTANCE_METERS = 200;

/** Target point count for the map-display copy of the main track. */
export const DEFAULT_TARGET_DISPLAY_POINTS = 3000;

/** Default match radius (meters) between a waypoint and the main route. */
export const DEFAULT_WAYPOINT_MAX_DISTANCE_METERS = 500;

/** Calculate haversine distance in km */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

// ---------------------------------------------------------------------------
// Parsed-GPX flattening
// ---------------------------------------------------------------------------

/** A source track flattened across its segments. */
export interface ParsedGpxTrack {
  name: string;
  points: GpxPoint[];
}

/** The ingestion pipeline's view of a GPX file. */
export interface ParsedGpxResult {
  tracks: ParsedGpxTrack[];
  waypoints: TrailWaypoint[];
  /** `<metadata><name>`, or null. */
  name: string | null;
}

/**
 * Flatten a parsed {@link GpxData} into the shape {@link buildTrail} consumes.
 *
 * Semantics match the historical build-script parser:
 * - `<trk>` segments are concatenated into one point list per track.
 * - A file with no `<trk>` falls back to its `<rte>` points as a single track
 *   named "Route".
 * - Track names default to "Unnamed"; waypoint names are classified, and the
 *   *cleaned* name is what downstream code sees.
 *
 * On top of that it honours an explicit `<wpt><type>` when the source file
 * carries one (files exported by this project do), so an export → import round
 * trip keeps the classified type instead of re-deriving it from a name whose
 * prefix has already been stripped.
 */
export function flattenGpx(data: GpxData): ParsedGpxResult {
  const tracks: ParsedGpxTrack[] = data.tracks.map(track => ({
    name: track.name || 'Unnamed',
    points: track.segments.flatMap(segment => segment.points),
  }));

  // If no tracks found, try route points as a single "track"
  if (tracks.length === 0) {
    const routePoints = data.routes.flatMap(route => route.points);
    if (routePoints.length > 0) {
      tracks.push({ name: 'Route', points: routePoints });
    }
  }

  const waypoints: TrailWaypoint[] = data.waypoints.map(wpt => {
    const classification = classifyWaypoint(wpt.name || 'Unnamed');
    return {
      name: classification.cleanedName,
      lat: wpt.lat,
      lon: wpt.lon,
      type: wpt.type || classification.type,
      description: wpt.desc || undefined,
    };
  });

  return { tracks, waypoints, name: data.metadataName ?? null };
}

// ---------------------------------------------------------------------------
// Route selection and geometry
// ---------------------------------------------------------------------------

interface MainRouteSelection {
  points: GpxPoint[];
  classificationSummary: string;
  alternateTracks: ParsedGpxTrack[];
  sideTripTracks: ParsedGpxTrack[];
  mainTrackCount: number;
  gapWarnings: CombineTracksWarning[];
  combinedNames: string[];
}

/**
 * Select and combine main route tracks using classification.
 * Falls back to longest track if no classification config provided.
 */
function selectMainRoute(
  gpxData: ParsedGpxResult,
  config: TrailConfig,
  combineUnclassified = false
): MainRouteSelection {
  const classification = classifyTracks(
    gpxData.tracks.map(t => ({
      name: t.name,
      points: t.points.map(p => ({ ...p, time: p.time })),
    })),
    config.trackClassification || {}
  );

  // A user's GPX is often one <trk> per day/leg with no naming convention at
  // all, and `fallbackToLongest` would keep only the longest of them. For
  // imports every unclassified track is part of the route; the build script
  // leaves this off, where an unclassified track means "not configured yet".
  if (combineUnclassified && classification.unclassifiedTracks.length > 0) {
    for (const track of classification.unclassifiedTracks) track.type = 'main';
    classification.mainTracks.push(...classification.unclassifiedTracks);
    classification.unclassifiedTracks = [];
  }

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

  const base = {
    classificationSummary,
    alternateTracks,
    sideTripTracks,
    mainTrackCount: classification.mainTracks.length,
  };

  // No main tracks found
  if (classification.mainTracks.length === 0) {
    return { ...base, points: [], gapWarnings: [], combinedNames: [] };
  }

  // Single main track - return directly
  if (classification.mainTracks.length === 1) {
    return {
      ...base,
      points: classification.mainTracks[0].points,
      gapWarnings: [],
      combinedNames: [classification.mainTracks[0].name],
    };
  }

  // Multiple main tracks - combine geographically
  const { combinedPoints, orderedNames, warnings } = combineTracksGeographically(
    classification.mainTracks.map(t => ({ name: t.name, points: t.points }))
  );

  return { ...base, points: combinedPoints, gapWarnings: warnings, combinedNames: orderedNames };
}

/**
 * Calculate an adaptive simplification tolerance based on point count.
 * Returns tolerance in meters that should result in approximately `targetPoints` points.
 *
 * Uses a heuristic based on trail length and point density:
 * - More points relative to distance = higher tolerance needed
 * - Starts with a baseline and scales logarithmically
 */
export function calculateAdaptiveTolerance(
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
export function findVariantJunctions(
  variants: RouteVariant[],
  trackPoints: TrackPoint[],
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

    // A variant's stored point order follows its own source track, which need
    // not agree with the main route's direction (notably after a `reverseTrack`
    // build). Normalise so the junction range always reads forwards — the
    // viewer renders these as "Branches at: X km / Rejoins: Y km".
    if (
      enriched.startDistance !== undefined &&
      enriched.endDistance !== undefined &&
      enriched.startDistance > enriched.endDistance
    ) {
      [enriched.startDistance, enriched.endDistance] = [enriched.endDistance, enriched.startDistance];
      [enriched.startTrackIndex, enriched.endTrackIndex] = [enriched.endTrackIndex, enriched.startTrackIndex];
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
 *
 * A genuinely re-visited waypoint (the route passes it, leaves, and comes back)
 * still yields one visit per episode, so callers that key output rows by
 * waypoint identity must guard against the fan-out - see the duplicate-id check
 * in buildTrail. `maxDistanceMeters` is required: variants and the main route
 * use deliberately different thresholds.
 */
export function findWaypointVisits(
  waypoints: TrailWaypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number
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
export function calculateSegmentStats(
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
export function enrichWaypoints(
  waypoints: TrailWaypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number = DEFAULT_WAYPOINT_MAX_DISTANCE_METERS
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
 *
 * Waypoint `totalDistance` is on the TRAIL's absolute km scale: the junction
 * km where the variant leaves the main track (`startDistance`, set by
 * findVariantJunctions — call that first) plus the distance walked along the
 * variant. This keeps variant waypoints directly comparable with main-route
 * waypoints in datasheets. Falls back to variant-relative km when the variant
 * never attaches to the main track.
 */
export function enrichVariantWaypoints(
  variants: RouteVariant[],
  waypoints: TrailWaypoint[]
): RouteVariant[] {
  if (waypoints.length === 0) return variants;

  return variants.map(variant => {
    if (variant.points.length === 0) return variant;

    const visits = findWaypointVisits(waypoints, variant.points, VARIANT_WAYPOINT_MAX_DISTANCE_METERS);
    if (visits.length === 0) return variant;

    const junctionKm = variant.startDistance ?? 0;
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
        id: visit.waypoint.id,
        name: visit.waypoint.name,
        type: visit.waypoint.type,
        lat: visit.waypoint.lat,
        lon: visit.waypoint.lon,
        elevation: Math.round(trackPoint.ele),
        distance: Math.round(segmentStats.distance * 100) / 100,
        totalDistance: Math.round((junctionKm + runningDistance) * 100) / 100,
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

// ---------------------------------------------------------------------------
// buildTrail
// ---------------------------------------------------------------------------

/** Mints a stable id per source waypoint (registry-backed, or deterministic). */
export type WaypointIdMinter = (
  waypoints: TrailWaypoint[],
  config: TrailConfig
) => (string | undefined)[];

/** Opt-in elevation cleaning. Off for the build script (output must not move). */
export interface ElevationCleaningOptions {
  /** Interpolate barometric spikes before any ascent is accumulated. */
  removeSpikes?: boolean;
  /** Spike threshold in meters (default: GPX_OPTIMIZER_DEFAULTS.spikeThreshold). */
  spikeThreshold?: number;
  /** Moving-average smoothing of elevations. */
  smooth?: boolean;
  /** Smoothing window in points (default: GPX_OPTIMIZER_DEFAULTS.elevationSmoothingWindow). */
  smoothingWindow?: number;
  /**
   * When set, total ascent/descent are computed with `calculateElevationStats`
   * at this threshold (m) instead of summing every sample-to-sample delta.
   */
  ascentThreshold?: number;
}

export interface BuildTrailOptions {
  /** Trail config; `lengthKm` is overwritten with the built route's length. */
  config: TrailConfig;
  /** Target point count for `track.displayPoints` (default 3000). */
  targetDisplayPoints?: number;
  /**
   * Treat every unclassified track as part of the main route and chain them
   * geographically, instead of `fallbackToLongest` keeping only the longest.
   * On for user imports, off for the build script.
   */
  combineUnclassifiedTracks?: boolean;
  /** Elevation cleaning; entirely off by default. */
  elevation?: ElevationCleaningOptions;
  /** Mint stable ids for the source waypoints before enrichment. */
  mintWaypointIds?: WaypointIdMinter;
  /**
   * What to do when the route passes one waypoint twice, fanning a single
   * source waypoint into several output rows that share an id. The build script
   * throws (the fix is a trail.json change); imports disambiguate instead.
   */
  duplicateWaypointIds?: 'throw' | 'suffix';
  /**
   * Replace the source waypoint list once the config is final — the build
   * script's CalTopo categorisation and CSV fallback.
   */
  resolveWaypoints?(waypoints: TrailWaypoint[], config: TrailConfig): TrailWaypoint[];
  /**
   * Called after ids are minted, before enrichment. The build script applies
   * curated descriptions here (both mutate the same source objects that every
   * downstream view copies from).
   */
  afterWaypointIds?(waypoints: TrailWaypoint[], config: TrailConfig): void;
  /**
   * Re-derive the config once the main route is known (the build script's
   * auto-generated trail.json). Runs before cumulative distances are computed.
   */
  finalizeConfig?(config: TrailConfig, mainRoutePoints: GpxPoint[]): TrailConfig;
  /** Progress logging (the build script passes console.log). */
  log?(message: string): void;
  /** Advisory warnings (the build script passes console.warn). */
  warn?(message: string): void;
  /** Receives structured facts about the build (used by the import report). */
  onDiagnostics?(diagnostics: BuildTrailDiagnostics): void;
}

/** Structured facts about one `buildTrail` run. */
export interface BuildTrailDiagnostics {
  classificationSummary: string;
  /** Number of `<trk>` (or fallback `<rte>`) tracks in the source file. */
  tracksFound: number;
  /** How many tracks were classified as main route and chained together. */
  mainTracksCombined: number;
  /** Gaps found while chaining multiple main tracks. */
  gapWarnings: CombineTracksWarning[];
  /** Human-readable self-retrace advisories. */
  selfRetraceWarnings: string[];
  /** Points on the built main route. */
  pointCount: number;
  /** Points in the simplified display copy. */
  displayPointCount: number;
  alternateCount: number;
  sideTripCount: number;
  waypointCount: number;
  offTrailWaypointCount: number;
}

/**
 * Build a {@link ProcessedTrail} from parsed GPX.
 *
 * Order of operations is load-bearing and matches the original build script:
 * classify → optional reverse → spur extraction → config finalisation →
 * cumulative distance → display simplification → waypoint resolution →
 * variants → id minting → enrichment → duplicate check → dedupe → junctions →
 * variant waypoints → off-trail split.
 */
export function buildTrail(gpx: ParsedGpxResult, options: BuildTrailOptions): ProcessedTrail {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  let config = options.config;

  // Select and combine main route tracks using classification
  const selection = selectMainRoute(gpx, config, options.combineUnclassifiedTracks);
  log(`  Classified: ${selection.classificationSummary}`);
  for (const warning of selection.gapWarnings) {
    log(`  Warning: ${warning.gapMeters.toFixed(0)}m gap between "${warning.fromTrack}" and "${warning.toTrack}"`);
  }
  if (selection.mainTrackCount > 1) {
    const names = selection.combinedNames;
    log(`  Combined ${names.length} tracks: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '...' : ''}`);
  }

  const { alternateTracks, sideTripTracks: classifiedSideTrips } = selection;
  let mainRoutePoints = selection.points;

  // Reverse the source track when it runs opposite to the trail's canonical
  // direction (km 0 should be the terminus named by `direction.default`).
  // Variants are reversed too so they still describe a walk in the same
  // direction as the main route. Must run before the cumulative-distance pass
  // below, and before spur extraction, so every later km is in built space.
  if (config.reverseTrack) {
    mainRoutePoints = [...mainRoutePoints].reverse();
    for (const track of [...alternateTracks, ...classifiedSideTrips]) {
      track.points.reverse();
    }
    log('  ✓ Reversed track direction (reverseTrack)');
  }

  // Lift configured out-and-back spurs off the main route. Explicit config
  // only - detectSelfRetraces below finds every retrace, but most are the
  // official route, so this is never automatic.
  const extractedSpurs: ParsedGpxTrack[] = [];
  for (const spur of config.extractSpurs ?? []) {
    const km = cumulativeKm(mainRoutePoints);
    const toKm = spur.toKm ?? km[km.length - 1];
    const { trimmedMain, spurPoints } = extractSpur(mainRoutePoints, spur.fromKm, toKm);
    mainRoutePoints = trimmedMain;
    extractedSpurs.push({ name: spur.name, points: spurPoints });
    const spurKm = cumulativeKm(spurPoints);
    log(
      `  ✓ Extracted spur "${spur.name}" (${spurKm[spurKm.length - 1].toFixed(2)} km) ` +
        `from main route km ${spur.fromKm}-${toKm.toFixed(2)}`
    );
  }

  const selfRetraceWarnings: string[] = [];
  for (const retrace of detectSelfRetraces(mainRoutePoints, { minRetraceKm: SELF_RETRACE_WARN_KM })) {
    const message =
      `  Warning: main route retraces ${retrace.retraceLengthKm.toFixed(1)} km around km ` +
      `${retrace.turnaroundKm.toFixed(1)} (${retrace.terminal ? 'terminal spur' : 'mid-route'}). ` +
      `If it is not part of the route, add an extractSpurs entry to trail.json.`;
    selfRetraceWarnings.push(message);
    warn(message);
  }

  // Re-derive the config now that the main route is known (auto-generation).
  if (options.finalizeConfig) {
    config = options.finalizeConfig(config, mainRoutePoints);
  }

  // Optional elevation cleaning. Off for the build script: turning it on moves
  // every generated ascent figure, so it is opt-in for user imports only.
  mainRoutePoints = cleanElevation(mainRoutePoints, options.elevation);

  // Calculate cumulative distance and elevation
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;

  const points: TrackPoint[] = mainRoutePoints.map((p, i, arr) => {
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

  // Noise-thresholded totals, when asked for. Only the two totals change: the
  // per-point `dist` ladder and the per-segment waypoint stats stay as-is.
  if (options.elevation?.ascentThreshold !== undefined) {
    const stats = calculateElevationStats(mainRoutePoints, options.elevation.ascentThreshold);
    totalAscent = stats.gain;
    totalDescent = stats.loss;
  }

  // Simplify for map display (target ~3000 points for smooth rendering)
  const targetDisplayPoints = options.targetDisplayPoints ?? DEFAULT_TARGET_DISPLAY_POINTS;
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
    log(`  ✓ Simplified ${points.length} → ${displayPoints.length} points for display`);
  }

  // Get waypoints - GPX waypoints, plus whatever the caller layers on top
  // (CalTopo categories, CSV fallback).
  let waypoints: TrailWaypoint[] = gpx.waypoints;
  if (options.resolveWaypoints) {
    waypoints = options.resolveWaypoints(waypoints, config);
  }

  const alternates: RouteVariant[] = [];
  const sideTrips: RouteVariant[] = [];

  // Convert classified GPX alternate tracks to RouteVariant[]
  for (const track of alternateTracks) {
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

  // Convert classified GPX side-trip tracks (plus any extracted spurs) to RouteVariant[]
  for (const track of [...classifiedSideTrips, ...extractedSpurs]) {
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

  if (alternates.length > 0) log(`  ✓ Found ${alternates.length} alternate routes from GPX`);
  if (sideTrips.length > 0) log(`  ✓ Found ${sideTrips.length} side trips`);

  // Update config with calculated distance
  config.lengthKm = Math.round(totalDistance * 10) / 10;

  // Assign stable ids BEFORE splitting the waypoint list into on-trail /
  // off-trail / variant views. Enriched, off-trail, and variant waypoints all
  // spread or copy from these same source objects, so mutating `id` here
  // propagates the id to every place a waypoint surfaces in the generated JSON
  // (so a comment follows the waypoint regardless of which view a user is
  // looking at).
  if (options.mintWaypointIds) {
    const waypointIds = options.mintWaypointIds(waypoints, config);
    waypoints.forEach((wp, i) => {
      wp.id = waypointIds[i];
    });
  }

  // Curated descriptions and anything else keyed by the ids just assigned.
  options.afterWaypointIds?.(waypoints, config);

  // Enrich waypoints with distance and elevation data
  const waypointMaxDist = config.waypointMaxDistance ?? DEFAULT_WAYPOINT_MAX_DISTANCE_METERS;
  const enrichedWaypoints = enrichWaypoints(waypoints, mainRoutePoints, waypointMaxDist);

  // Output invariant: every enriched waypoint carries a distinct stable id.
  // enrichWaypoints emits one row per proximity episode, so a route that passes
  // the same waypoint twice (an out-and-back folded into the main track) fans
  // one source waypoint into several rows sharing an id — which breaks every
  // consumer that keys by id (React list keys, elevation-profile markers,
  // comment lookups). The minter cannot catch this: it runs on the source list,
  // before the fan-out happens.
  resolveDuplicateWaypointIds(
    enrichedWaypoints,
    config,
    waypointMaxDist,
    options.duplicateWaypointIds ?? 'throw'
  );

  // Merge near-duplicate waypoints: some sources mark one physical feature with
  // two <wpt>s — the AAWT has "Talbot Hut Site" twice ~60m apart, the Larapinta
  // pins a `WT:` tank and a `C:` campsite at the same site (Rocky Bar Gap) —
  // which, after the GeoJSON category overwrite gives both the same type, shows
  // up as two adjacent identical-looking rows. Opt in per trail via
  // `dedupeWaypoints`.
  //
  // Placement matters: this runs AFTER id minting (which still sees every
  // source waypoint, so data/waypoint-ids.json stays append-only and retired ids
  // keep their comments) and after the duplicate-id invariant above, but before
  // the waypoint lists are handed to the output. Dropped ids are recorded on the
  // survivor as `mergedIds`.
  const dedupeConfig = config.dedupeWaypoints;
  const dedupeEnabled = dedupeConfig === true || (typeof dedupeConfig === 'object' && dedupeConfig !== null);
  const dedupeRadiusMeters = typeof dedupeConfig === 'object' && dedupeConfig !== null
    ? dedupeConfig.radiusMeters
    : undefined;

  // Ids kept by an earlier view win survivor selection in later views, so one
  // feature never surfaces under two different ids across main/variant/off-trail.
  const canonicalIds = new Set<string>();
  const mergedAwayIds = new Set<string>();
  const mergeLog: string[] = [];
  let rowsBeforeDedupe = 0;
  let rowsAfterDedupe = 0;

  function applyWaypointDedupe<T extends DedupableWaypoint>(rows: T[], view: string): T[] {
    if (!dedupeEnabled || rows.length < 2) return rows;

    const result = dedupeNearDuplicateWaypoints(rows, {
      radiusMeters: dedupeRadiusMeters,
      preferIds: canonicalIds,
    });
    rowsBeforeDedupe += rows.length;
    rowsAfterDedupe += result.waypoints.length;

    for (const merge of result.merges) {
      if (merge.survivorId) canonicalIds.add(merge.survivorId);
      for (const id of merge.droppedIds) mergedAwayIds.add(id);
      mergeLog.push(
        `    - ${merge.name} (${merge.type}, ${view}): kept ${merge.survivorId ?? 'no id'}, ` +
          `merged ${merge.droppedIds.join(', ') || `${merge.droppedCount} row(s) with no id`} ` +
          `(${Math.round(merge.maxSeparationMeters)}m apart)`
      );
    }
    return result.waypoints;
  }

  const outputWaypoints = applyWaypointDedupe(enrichedWaypoints, 'main');
  // Ids merged away on the main route are already represented by an on-trail
  // row, so they must never resurface in the off-trail list below.
  const mainMergedAwayIds = new Set(mergedAwayIds);

  // Enrich variants with junction point data (where they connect to main track)
  const enrichedAlternates = findVariantJunctions(alternates, points);
  const enrichedSideTrips = findVariantJunctions(sideTrips, points);

  // Enrich variants with waypoint data (which waypoints they pass through).
  // Variants re-match the same source waypoints, so a near-duplicate pair shows
  // up twice here too and needs the same merge (preferring the main route's
  // survivor) to stay consistent with the main list.
  const dedupeVariants = (variants: RouteVariant[]): RouteVariant[] =>
    variants.map(variant => variant.waypoints === undefined
      ? variant
      : { ...variant, waypoints: applyWaypointDedupe(variant.waypoints, `variant "${variant.name}"`) });

  const alternatesWithWaypoints = dedupeVariants(enrichVariantWaypoints(enrichedAlternates, waypoints));
  const sideTripsWithWaypoints = dedupeVariants(enrichVariantWaypoints(enrichedSideTrips, waypoints));

  // Identify off-trail waypoints (not matched even at the increased threshold).
  // `matchedNames` is built from the pre-dedupe enriched list on purpose: a
  // waypoint that was matched and then merged away must not reappear here as an
  // off-trail waypoint. `mainMergedAwayIds` re-states that explicitly (the
  // name|lat|lon key would miss a merged-away twin only if two source waypoints
  // shared all three, but the guard costs nothing and states the intent).
  const matchedNames = new Set(enrichedWaypoints.map(ew => `${ew.name}|${ew.lat}|${ew.lon}`));
  const offTrailCandidates: OffTrailWaypoint[] = waypoints
    .filter(wp => !matchedNames.has(`${wp.name}|${wp.lat}|${wp.lon}`))
    .filter(wp => !(wp.id !== undefined && mainMergedAwayIds.has(wp.id)))
    .map(wp => {
      const { distanceFromTrack } = findNearestTrackPoint(wp, points);
      return { ...wp, distanceFromTrail: Math.round(distanceFromTrack) };
    });
  // Off-trail pairs are duplicates in the same way (the AAWT marks "Macalister
  // Springs" twice, 115m apart, both beyond the on-trail threshold).
  const offTrailWaypoints = applyWaypointDedupe(offTrailCandidates, 'off-trail');

  if (dedupeEnabled && rowsBeforeDedupe > rowsAfterDedupe) {
    log(
      `  ✓ Merged ${rowsBeforeDedupe - rowsAfterDedupe} near-duplicate waypoints ` +
        `(${rowsBeforeDedupe} → ${rowsAfterDedupe} rows, radius ` +
        `${dedupeRadiusMeters ?? WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS}m)`
    );
    for (const line of mergeLog) log(line);
  }

  if (offTrailWaypoints.length > 0) {
    log(`  ✓ ${offTrailWaypoints.length} off-trail waypoints (beyond ${waypointMaxDist}m threshold)`);
  }

  options.onDiagnostics?.({
    classificationSummary: selection.classificationSummary,
    tracksFound: gpx.tracks.length,
    mainTracksCombined: selection.mainTrackCount,
    gapWarnings: selection.gapWarnings,
    selfRetraceWarnings,
    pointCount: points.length,
    displayPointCount: displayPoints.length,
    alternateCount: alternatesWithWaypoints.length,
    sideTripCount: sideTripsWithWaypoints.length,
    waypointCount: outputWaypoints.length,
    offTrailWaypointCount: offTrailWaypoints.length,
  });

  return {
    config,
    track: {
      points,
      displayPoints,
      totalDistance,
      totalAscent,
      totalDescent,
    },
    waypoints: outputWaypoints,
    offTrailWaypoints,
    alternates: alternatesWithWaypoints,
    sideTrips: sideTripsWithWaypoints,
    climate: null,
    climateLocations: config.climateLocations || null,
    direction: config.direction || null,
  };
}

/**
 * Re-derive everything that depends on the main route's `ele` values, after
 * something replaced them wholesale (today: the Open-Elevation backfill in
 * `elevation-backfill.ts`).
 *
 * This is deliberately NOT a re-run of {@link buildTrail}: the trail has
 * already been classified, reversed, spur-extracted and waypoint-matched, and
 * redoing any of that on an already-built trail risks producing a *different*
 * trail rather than the same one with better elevation. Only the elevation-
 * derived quantities move:
 * - `track.points[].ele` (cleaned with the same passes an import uses),
 * - `track.totalAscent` / `track.totalDescent`,
 * - `track.displayPoints[].ele` (re-read from the cleaned full-resolution
 *   points by coordinate, the same way buildTrail derives them),
 * - each waypoint's `elevation`, `ascent`/`descent` and running totals, from
 *   its stored `trackIndex` via {@link calculateSegmentStats} — the identical
 *   accumulation {@link enrichWaypoints} performs.
 *
 * Distances (`dist`, `totalDistance`, per-waypoint `distance`) are untouched:
 * no lat/lon moved. Alternates, side trips and their waypoints are untouched
 * too — a backfill only covers the main route's points.
 *
 * Returns a new trail; the input is not mutated.
 */
export function recomputeTrailElevation(
  trail: ProcessedTrail,
  options?: ElevationCleaningOptions
): ProcessedTrail {
  const source = trail.track.points;
  if (source.length === 0) return trail;

  // `time` is the one GpxPoint field a TrackPoint lacks; the cleaning passes
  // spread their input, so `dist` survives the round trip regardless.
  const withTime = source.map(p => ({ ...p, time: null as string | null }));
  const cleaned = cleanElevation(withTime, options);

  const points: TrackPoint[] = cleaned.map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    ele: p.ele,
    dist: source[i]?.dist ?? 0,
  }));

  let totalAscent = 0;
  let totalDescent = 0;
  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i - 1].ele;
    if (diff > 0) totalAscent += diff;
    else totalDescent += Math.abs(diff);
  }
  if (options?.ascentThreshold !== undefined) {
    const stats = calculateElevationStats(cleaned, options.ascentThreshold);
    totalAscent = stats.gain;
    totalDescent = stats.loss;
  }

  // displayPoints are a coordinate-identical subset of points (Douglas-Peucker
  // returns references), so a coordinate key re-attaches the new elevations.
  const byCoord = new Map(points.map(p => [`${p.lat},${p.lon}`, p]));
  const displayPoints = trail.track.displayPoints.map(dp => {
    const updated = byCoord.get(`${dp.lat},${dp.lon}`);
    return updated ? { ...dp, ele: updated.ele } : dp;
  });

  let prevTrackIndex = 0;
  let runningAscent = 0;
  let runningDescent = 0;
  const waypoints: EnrichedWaypoint[] = trail.waypoints.map(wp => {
    const segment = calculateSegmentStats(points, prevTrackIndex, wp.trackIndex);
    runningAscent += segment.ascent;
    runningDescent += segment.descent;
    prevTrackIndex = wp.trackIndex;
    return {
      ...wp,
      elevation: Math.round(points[wp.trackIndex]?.ele ?? wp.elevation),
      ascent: Math.round(segment.ascent),
      descent: Math.round(segment.descent),
      totalAscent: Math.round(runningAscent),
      totalDescent: Math.round(runningDescent),
    };
  });

  return {
    ...trail,
    track: { ...trail.track, points, displayPoints, totalAscent, totalDescent },
    waypoints,
  };
}

/** Apply the opt-in elevation cleaning passes, in order. */
function cleanElevation(points: GpxPoint[], options?: ElevationCleaningOptions): GpxPoint[] {
  if (!options) return points;
  let cleaned = points;
  if (options.removeSpikes) {
    cleaned = removeElevationSpikes(cleaned, options.spikeThreshold ?? 50);
  }
  if (options.smooth) {
    cleaned = smoothElevation(cleaned, options.smoothingWindow ?? 7);
  }
  return cleaned;
}

function resolveDuplicateWaypointIds(
  enrichedWaypoints: EnrichedWaypoint[],
  config: TrailConfig,
  waypointMaxDist: number,
  policy: 'throw' | 'suffix'
): void {
  const seenWaypointIds = new Map<string, EnrichedWaypoint>();
  const counts = new Map<string, number>();

  for (const wp of enrichedWaypoints) {
    if (!wp.id) continue;
    const first = seenWaypointIds.get(wp.id);
    if (first) {
      if (policy === 'throw') {
        throw new Error(
          `Duplicate waypoint id "${wp.id}" ("${wp.name}") in trail "${config.id}": matched ` +
            `at km ${first.totalDistance} and km ${wp.totalDistance}. The route passes this ` +
            `waypoint twice — lift the out-and-back section out with an "extractSpurs" entry ` +
            `in trail.json, or lower "waypointMaxDistance" (currently ${waypointMaxDist}m) so ` +
            `the second pass falls outside the match threshold.`
        );
      }
      // Imports cannot ask the user to edit a trail.json, so the later passes
      // get a suffixed id and stay individually addressable.
      const next = (counts.get(wp.id) ?? 1) + 1;
      counts.set(wp.id, next);
      wp.id = `${wp.id}_${next}`;
      continue;
    }
    seenWaypointIds.set(wp.id, wp);
  }
}
