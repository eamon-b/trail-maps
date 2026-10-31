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
import { snapToTrail } from './position-on-trail';
import {
  douglasPeuckerIndices,
  removeElevationSpikes,
  smoothElevation,
  cumulativeElevationChange,
} from './gpx-optimizer';
import { classifyTracks, combineTracksGeographically, concatenateStretches } from './track-classification';
import { classifyWaypoint, inferWaypointTypeFromKeywords } from './waypoint-classifier';
import { cumulativeKm, detectSelfRetraces, extractSpur, type SelfRetrace } from './track-spurs';
import {
  dedupeNearDuplicateWaypoints,
  WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS,
  type DedupableWaypoint,
} from './waypoint-dedupe';
import type { CombineTracksWarning, GpxData, GpxPoint, StoreKind, TrackBreak, WaypointAccess } from './types';
import type {
  EnrichedWaypoint,
  KnownRetraceConfig,
  OffTrailWaypoint,
  ProcessedTrail,
  RouteBreak,
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
// - MAX_TOLERANCE_METERS: Ceiling on the result. Without one the formula above
//   keeps raising the tolerance until a fixed 3,000-point target is met however
//   long the trail is, which on the 4,827 km CDT meant a ~263 m tolerance and a
//   display line at 1.5 km per point — visibly straight chords next to the
//   alternates, which are drawn from their full points. 25 m is below what is
//   perceptible at any zoom the map offers and leaves the shorter trails'
//   display copies byte-identical (they never reach the ceiling); the long ones
//   simply keep more points than the target, which is the intent.
const MIN_TOLERANCE_METERS = 5;
const DISTANCE_SCALE_FACTOR_KM = 500;
const TOLERANCE_MULTIPLIER = 5;
const MAX_TOLERANCE_METERS = 25;

// Report main-route sections that double back on themselves for at least this
// many km. Purely advisory: a retrace may be a walk into town that belongs off
// the route (the Bibbulmun's 2.8 km into Collie, lifted out by `extractSpurs`)
// or the route as drawn (its 6.9 km into Denmark and back out to the Wilson
// Inlet mouth, recorded in `knownRetraces`), so neither is automatic. 2 km is
// low enough to surface the Collie walk-in and still silent on the five trails
// that have no retrace at all.
const SELF_RETRACE_WARN_KM = 2;

// How near a `knownRetraces` entry's km and length must be to the retrace it
// names: loose enough that a small edit upstream of it does not re-raise the
// warning, tight enough that a different retrace turning nearby is not taken
// for it.
const KNOWN_RETRACE_MATCH_KM = 1;
const KNOWN_RETRACE_LENGTH_TOLERANCE = 0.15;
const KNOWN_RETRACE_MIN_LENGTH_TOLERANCE_KM = 0.5;

/**
 * Pair the retraces the route has with the `knownRetraces` entries that name
 * them, one to one: an entry matches a retrace turning within
 * `KNOWN_RETRACE_MATCH_KM` of its km whose length is within 15% (at least
 * 0.5 km) of its own, the nearest pairs first. A retrace left unpaired is
 * warned about; an entry left unpaired is `stale`.
 */
export function pairKnownRetraces(
  retraces: readonly SelfRetrace[],
  entries: readonly KnownRetraceConfig[]
): { known: Map<SelfRetrace, KnownRetraceConfig>; stale: KnownRetraceConfig[] } {
  const candidates: { retrace: SelfRetrace; entry: KnownRetraceConfig; offKm: number }[] = [];
  for (const retrace of retraces) {
    for (const entry of entries) {
      const offKm = Math.abs(entry.turnaroundKm - retrace.turnaroundKm);
      const lengthToleranceKm = Math.max(
        KNOWN_RETRACE_MIN_LENGTH_TOLERANCE_KM,
        entry.lengthKm * KNOWN_RETRACE_LENGTH_TOLERANCE
      );
      if (offKm <= KNOWN_RETRACE_MATCH_KM && Math.abs(entry.lengthKm - retrace.retraceLengthKm) <= lengthToleranceKm) {
        candidates.push({ retrace, entry, offKm });
      }
    }
  }
  candidates.sort((a, b) => a.offKm - b.offKm);
  const known = new Map<SelfRetrace, KnownRetraceConfig>();
  const used = new Set<KnownRetraceConfig>();
  for (const { retrace, entry } of candidates) {
    if (known.has(retrace) || used.has(entry)) continue;
    known.set(retrace, entry);
    used.add(entry);
  }
  return { known, stale: entries.filter(entry => !used.has(entry)) };
}

// Distance (metres) from a variant's track within which a waypoint counts as
// being on that variant. Deliberately tighter than the main route's
// `waypointMaxDistance`: variants are short and run close to the main route, so
// a loose threshold pulls in waypoints that belong to the through-route.
export const VARIANT_WAYPOINT_MAX_DISTANCE_METERS = 200;

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

export interface FlattenGpxOptions {
  /**
   * Guess a waypoint's type from words in its name ("Wallaby Creek Campsite" →
   * `campsite`) when no folder, known town or name prefix identifies it.
   *
   * Default false, and the split is deliberate:
   * - **curated trails** (`scripts/build-trails.ts`) get their types from
   *   CalTopo folders and hand-written `C:`/`WT:` prefixes, which are
   *   authoritative. Guessing from words there would only add noise, and would
   *   churn the pinned `public/data/generated/*.json` that
   *   `data/waypoint-ids.json` is built alongside — so it stays off.
   * - **user-imported GPX** (`gpx-import.ts`) follows no such convention, so
   *   without inference every waypoint lands on `waypoint` and the plan
   *   calculators see no water and no resupply at all. It stays on there.
   *
   * `importGpx` enables the equivalent flag on {@link BuildTrailOptions}
   * instead, so the pass runs exactly once and its counts reach the import
   * report. This flag is for callers that stop at flattening.
   */
  inferWaypointTypesFromKeywords?: boolean;
}

/**
 * Carry the optional off-trail access fields across a rebuild.
 *
 * `flattenGpx` and `enrichVariantWaypoints` construct their waypoints from an
 * explicit field list rather than a spread, so the fields have to be copied by
 * hand. Absent ones stay absent — writing `offTrailKm: undefined` would add a
 * key to every waypoint of every trail, which JSON.stringify drops but
 * structural comparisons (and reviewers reading a diff) do not.
 */
function waypointAccess(source: WaypointAccess): WaypointAccess {
  const access: WaypointAccess = {};
  if (source.offTrailKm !== undefined) access.offTrailKm = source.offTrailKm;
  if (source.accessMode !== undefined) access.accessMode = source.accessMode;
  if (source.acceptsBoxes !== undefined) access.acceptsBoxes = source.acceptsBoxes;
  if (source.store !== undefined) access.store = source.store;
  if (source.accessName !== undefined) access.accessName = source.accessName;
  if (source.offTrailAscentM !== undefined) access.offTrailAscentM = source.offTrailAscentM;
  if (source.offTrailDescentM !== undefined) access.offTrailDescentM = source.offTrailDescentM;
  if (source.offTrailPath !== undefined) access.offTrailPath = source.offTrailPath;
  return access;
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
export function flattenGpx(data: GpxData, options: FlattenGpxOptions = {}): ParsedGpxResult {
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
    const classification = classifyWaypoint(wpt.name || 'Unnamed', {
      inferFromKeywords: options.inferWaypointTypesFromKeywords,
    });
    return {
      name: classification.cleanedName,
      lat: wpt.lat,
      lon: wpt.lon,
      type: wpt.type || classification.type,
      description: wpt.desc || undefined,
      ...waypointAccess(wpt),
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
  /** Alternative trail ends (`Terminus: <name>`). */
  terminusTracks: ParsedGpxTrack[];
  mainTrackCount: number;
  gapWarnings: CombineTracksWarning[];
  combinedNames: string[];
  /** Joins between main tracks the route does not cross. Empty unless the
   *  trail declares `trackClassification.stretches`. */
  breaks: TrackBreak[];
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
  const sourceTracks = gpxData.tracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ ...p, time: p.time })),
  }));
  // A user's GPX is often one <trk> per day/leg with no naming convention at
  // all, and `fallbackToLongest` would keep only the longest of them. For
  // imports every unclassified track is part of the route; the build script
  // leaves this off, where an unclassified track means "not configured yet".
  //
  // The fallback is switched off rather than undone afterwards: it puts the
  // longest track first, and chaining starts from whichever track is first, so
  // a Day 1 (5 km) + Day 2 (17 km) file came out walking from the end of Day 2
  // back to the start of Day 1.
  const classification = classifyTracks(
    sourceTracks,
    combineUnclassified ? { ...config.trackClassification, fallbackToLongest: false } : config.trackClassification || {}
  );

  if (combineUnclassified && classification.unclassifiedTracks.length > 0) {
    for (const track of classification.unclassifiedTracks) track.type = 'main';
    classification.mainTracks.push(...classification.unclassifiedTracks);
    classification.unclassifiedTracks = [];
    // The file's own order, so the chain starts from the file's first track.
    const fileOrder = new Map(sourceTracks.map((t, i) => [t.points, i]));
    classification.mainTracks.sort((a, b) => (fileOrder.get(a.points) ?? 0) - (fileOrder.get(b.points) ?? 0));
  }

  const parts: string[] = [];
  if (classification.mainTracks.length > 0) parts.push(`${classification.mainTracks.length} main`);
  if (classification.alternateTracks.length > 0) parts.push(`${classification.alternateTracks.length} alternates`);
  if (classification.sideTripTracks.length > 0) parts.push(`${classification.sideTripTracks.length} side trips`);
  if (classification.terminusTracks.length > 0) parts.push(`${classification.terminusTracks.length} termini`);
  if (classification.ignoredTracks.length > 0) parts.push(`${classification.ignoredTracks.length} ignored`);
  if (classification.unclassifiedTracks.length > 0)
    parts.push(`${classification.unclassifiedTracks.length} unclassified`);
  const classificationSummary = parts.length > 0 ? parts.join(', ') : 'no tracks';

  const alternateTracks: ParsedGpxTrack[] = classification.alternateTracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  }));
  const sideTripTracks: ParsedGpxTrack[] = classification.sideTripTracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  }));
  const terminusTracks: ParsedGpxTrack[] = classification.terminusTracks.map(t => ({
    name: t.name,
    points: t.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  }));

  const base = {
    classificationSummary,
    alternateTracks,
    sideTripTracks,
    terminusTracks,
    mainTrackCount: classification.mainTracks.length,
  };

  // No main tracks found
  if (classification.mainTracks.length === 0) {
    return { ...base, points: [], gapWarnings: [], combinedNames: [], breaks: [] };
  }

  // Single main track - return directly
  if (classification.mainTracks.length === 1) {
    return {
      ...base,
      points: classification.mainTracks[0].points,
      gapWarnings: [],
      combinedNames: [classification.mainTracks[0].name],
      breaks: [],
    };
  }

  // Multiple main tracks. A trail that declares its tracks are consecutive
  // stretches keeps the file's order and its breaks; everything else is chained
  // by proximity, which bridges them.
  const stretches = config.trackClassification?.stretches;
  const mainTracks = classification.mainTracks.map(t => ({ name: t.name, points: t.points }));
  const { combinedPoints, orderedNames, warnings, breaks } = stretches
    ? concatenateStretches(mainTracks, stretches)
    : combineTracksGeographically(mainTracks);

  return {
    ...base,
    points: combinedPoints,
    gapWarnings: warnings,
    combinedNames: orderedNames,
    breaks,
  };
}

/**
 * Calculate an adaptive simplification tolerance based on point count.
 * Returns tolerance in meters that should result in approximately `targetPoints` points.
 *
 * Uses a heuristic based on trail length and point density:
 * - More points relative to distance = higher tolerance needed
 * - Starts with a baseline and scales logarithmically
 *
 * The result is capped at {@link MAX_TOLERANCE_METERS}, so a long trail
 * overshoots `targetPoints` rather than losing the shape of its line.
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

  return Math.min(MIN_TOLERANCE_METERS + scaleFactor * TOLERANCE_MULTIPLIER, MAX_TOLERANCE_METERS);
}

/**
 * Calculate distance and elevation for a set of points
 */
function calculateRouteStats(points: { lat: number; lon: number; ele: number }[]): {
  distance: number;
  ascent: number;
  descent: number;
} {
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
 * How far a variant's end may sit from the route it branches off and still
 * count as a junction, unless a trail raises it with
 * `trackClassification.maxJunctionDistanceMeters`.
 */
export const DEFAULT_MAX_JUNCTION_DISTANCE_METERS = 500;

/** Metres in a degree of latitude, for turning a tolerance into a bounding box. */
const METERS_PER_DEGREE_LAT = 111320;

/**
 * A residual is only worth recording past the standard tolerance. An end
 * inside 500 m is on the route for every purpose these pages have, so stamping
 * an offset on it would rewrite every existing trail's variants for nothing.
 */
function junctionOffset(distanceFromTrack: number): number | undefined {
  return distanceFromTrack > DEFAULT_MAX_JUNCTION_DISTANCE_METERS ? Math.round(distanceFromTrack) : undefined;
}

/**
 * A variant's source track need not run the way the main route does (notably
 * after a `reverseTrack` build, or when a CalTopo line was drawn from the far
 * end). Normalise so the variant reads forwards: the junction pair is swapped so
 * "Branches at: X km / Rejoins: Y km" has X before Y, and `points` is reversed
 * so `points[0]` is always the branch point. Everything downstream relies on
 * that invariant — variant waypoint km are `startDistance` plus the walk from
 * `points[0]`, and a child alternate's km are measured along its parent from the
 * same end — so the two must never be swapped independently. The ascent and
 * descent were measured the way the line was drawn, so they trade places too.
 *
 * Returns whether it turned the variant round.
 */
function normaliseJunctionOrder(variant: RouteVariant): boolean {
  if (
    variant.startDistance === undefined ||
    variant.endDistance === undefined ||
    variant.startDistance <= variant.endDistance
  ) {
    return false;
  }

  [variant.startDistance, variant.endDistance] = [variant.endDistance, variant.startDistance];
  [variant.startTrackIndex, variant.endTrackIndex] = [variant.endTrackIndex, variant.startTrackIndex];
  if (variant.startOffsetMeters !== undefined || variant.endOffsetMeters !== undefined) {
    [variant.startOffsetMeters, variant.endOffsetMeters] = [variant.endOffsetMeters, variant.startOffsetMeters];
  }
  variant.points = [...variant.points].reverse();
  variant.elevation = { ascent: variant.elevation.descent, descent: variant.elevation.ascent };
  return true;
}

/**
 * Turn a variant attached at its last point only into one attached at
 * `startDistance` only - the shape a terminus and a dead-end side trip already
 * have, so it reads forwards like every other variant. Left as it was, its
 * waypoints were numbered from km 0 (there is no `startDistance` to count
 * from) and it was drawn turnaround-first.
 *
 * Returns whether it turned the variant round.
 */
function turnEndOnlyRound(variant: RouteVariant): boolean {
  if (variant.startDistance !== undefined || variant.endDistance === undefined) return false;

  variant.startDistance = variant.endDistance;
  delete variant.endDistance;
  if (variant.endTrackIndex !== undefined) variant.startTrackIndex = variant.endTrackIndex;
  delete variant.endTrackIndex;
  if (variant.endOffsetMeters !== undefined) variant.startOffsetMeters = variant.endOffsetMeters;
  delete variant.endOffsetMeters;
  variant.points = [...variant.points].reverse();
  variant.elevation = { ascent: variant.elevation.descent, descent: variant.elevation.ascent };
  return true;
}

/**
 * Turn a terminus variant round so `points[0]` is the junction. The ascent and
 * descent were measured the way the line was drawn, so they trade places too -
 * the same bookkeeping {@link normaliseJunctionOrder} does for an alternate.
 */
function reverseVariantPoints(variant: RouteVariant): RouteVariant {
  return {
    ...variant,
    points: [...variant.points].reverse(),
    elevation: { ascent: variant.elevation.descent, descent: variant.elevation.ascent },
  };
}

/**
 * Attach an alternative trail end: exactly one junction, and never a search for
 * a rejoin.
 *
 * A terminus branches off the main line at one end and stops somewhere else
 * entirely - the CDT's Chief Mountain crossing is 10 km off the route, Antelope
 * Wells 31 km. Run through the ordinary variant path, the free end's nearest
 * main-route point is hundreds of times too far to be a junction, so
 * `endDistance` stays undefined and every reader shows a route with no end.
 * Here the far end is simply not asked about: `startDistance` is the junction,
 * the last point is the terminus, and `endDistance` is deliberately absent.
 *
 * The generator promises the track is drawn junction-first, but a promise about
 * the orientation of a line is exactly the kind of thing that comes out
 * backwards, so whichever end is actually nearer the route is taken as the
 * junction and the points are turned round if it was the last one.
 */
function findTerminusJunction(
  variant: RouteVariant,
  trackPoints: TrackPoint[],
  maxJunctionDistance: number
): RouteVariant {
  const firstJunction = findNearestTrackPoint(variant.points[0], trackPoints);
  const lastJunction = findNearestTrackPoint(variant.points[variant.points.length - 1], trackPoints);
  const junctionIsAtEnd = lastJunction.distanceFromTrack < firstJunction.distanceFromTrack;
  const junction = junctionIsAtEnd ? lastJunction : firstJunction;

  // Neither end is on the route. Leave it alone and unattached - a parent
  // alternate may still claim it in attachVariantsToParents.
  if (junction.distanceFromTrack > maxJunctionDistance) {
    return { ...variant };
  }

  const enriched: RouteVariant = junctionIsAtEnd ? reverseVariantPoints(variant) : { ...variant };
  enriched.startTrackIndex = junction.trackIndex;
  enriched.startDistance = Math.round(trackPoints[junction.trackIndex].dist * 100) / 100;
  const offset = junctionOffset(junction.distanceFromTrack);
  if (offset !== undefined) enriched.startOffsetMeters = offset;
  return enriched;
}

/**
 * Enrich route variants with junction point data.
 * Finds where each variant branches from and rejoins the main track.
 */
export function findVariantJunctions(
  variants: RouteVariant[],
  trackPoints: TrackPoint[],
  maxJunctionDistance: number = DEFAULT_MAX_JUNCTION_DISTANCE_METERS
): RouteVariant[] {
  return variants.map(variant => {
    if (variant.points.length === 0) {
      return variant;
    }

    if (variant.type === 'terminus') {
      return findTerminusJunction(variant, trackPoints, maxJunctionDistance);
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
      const startOffset = junctionOffset(startJunction.distanceFromTrack);
      if (startOffset !== undefined) enriched.startOffsetMeters = startOffset;
    }

    // For alternates, also record where they rejoin
    // For side trips, only record end if it's a different point (loop back)
    if (endJunction.distanceFromTrack <= maxJunctionDistance) {
      const isSameAsStart = Math.abs(endJunction.trackIndex - startJunction.trackIndex) < 10;

      if (variant.type === 'alternate' || !isSameAsStart) {
        enriched.endTrackIndex = endJunction.trackIndex;
        enriched.endDistance = Math.round(trackPoints[endJunction.trackIndex].dist * 100) / 100;
        const endOffset = junctionOffset(endJunction.distanceFromTrack);
        if (endOffset !== undefined) enriched.endOffsetMeters = endOffset;
      }
    }

    normaliseJunctionOrder(enriched);

    return enriched;
  });
}

/**
 * Attach variants whose ends never reached the main route to an alternate that
 * did — an alternate off an alternate, which CalTopo files are full of.
 *
 * Runs after {@link findVariantJunctions}, and only looks at the ends that
 * pass left unattached. The junction km it records is ordinary absolute trail km:
 * the parent's own junction km plus the walk along the parent to the branch
 * point. That is the whole point of doing it this way — nothing downstream
 * (waypoint enrichment, the datasheet, direction reversal) has to know a
 * parent exists, it just sees a variant with a normal place on the trail.
 *
 * Repeats until nothing more attaches, so a child of a child lands too.
 *
 * Only alternates can be parents: a side trip is walked out and back off
 * something else, so hanging a route off one would be describing a route that
 * doubles back over itself. And only an alternate's rejoin end is chased — a
 * side trip's far end is its turnaround, not a junction.
 *
 * A terminus (which travels in the side-trip list) is chased at whichever of
 * its two ends is nearer a parent, never at both: its far end is the trail's
 * end, not a junction.
 */
export function attachVariantsToParents(
  alternates: RouteVariant[],
  sideTrips: RouteVariant[],
  maxJunctionDistance: number = DEFAULT_MAX_JUNCTION_DISTANCE_METERS
): { alternates: RouteVariant[]; sideTrips: RouteVariant[] } {
  const all = [...alternates, ...sideTrips].map(variant => ({ ...variant }));
  const alternateCount = alternates.length;
  const cumulative = all.map(variant => cumulativeKm(variant.points));

  // Every unattached end is measured against every point of every attached
  // alternate, which on a trail with a hundred alternates is tens of millions
  // of haversines. A bounding box per variant throws out the ones that are
  // nowhere near before any of that runs.
  const bounds = all.map(variant => {
    const box = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
    for (const point of variant.points) {
      box.minLat = Math.min(box.minLat, point.lat);
      box.maxLat = Math.max(box.maxLat, point.lat);
      box.minLon = Math.min(box.minLon, point.lon);
      box.maxLon = Math.max(box.maxLon, point.lon);
    }
    return box;
  });
  const latMargin = maxJunctionDistance / METERS_PER_DEGREE_LAT;

  // Which alternate each end of a variant attached to, by index into `all`;
  // undefined for an end on the main route or not yet attached. Kept per end
  // rather than per variant because the ends attach in separate rounds and can
  // be swapped afterwards, and `parent` has to name the alternate the *branch
  // point* ended up on.
  const startParent: (number | undefined)[] = all.map(() => undefined);
  const endParent: (number | undefined)[] = all.map(() => undefined);

  /**
   * Absolute trail km of a point on an already-attached parent. `points[0]` is
   * the parent's branch point — normaliseJunctionOrder keeps it that way — so
   * the walk is simply the cumulative km to the point.
   */
  const kmAlongParent = (parentIndex: number, pointIndex: number): number =>
    Math.round((all[parentIndex].startDistance! + cumulative[parentIndex][pointIndex]) * 100) / 100;

  const nearestParent = (
    point: { lat: number; lon: number },
    selfIndex: number
  ): { parentIndex: number; pointIndex: number; distance: number } | null => {
    let best: { parentIndex: number; pointIndex: number; distance: number } | null = null;
    // Longitude degrees shrink towards the poles; clamp so a near-polar trail
    // cannot produce an unbounded margin.
    const lonMargin = latMargin / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.1);

    for (let p = 0; p < alternateCount; p++) {
      if (p === selfIndex) continue;
      const parent = all[p];
      if (parent.startDistance === undefined || parent.points.length === 0) continue;
      const box = bounds[p];
      if (
        point.lat < box.minLat - latMargin ||
        point.lat > box.maxLat + latMargin ||
        point.lon < box.minLon - lonMargin ||
        point.lon > box.maxLon + lonMargin
      ) {
        continue;
      }
      const near = findNearestTrackPoint(point, parent.points);
      if (near.distanceFromTrack > maxJunctionDistance) continue;
      if (best === null || near.distanceFromTrack < best.distance) {
        best = { parentIndex: p, pointIndex: near.trackIndex, distance: near.distanceFromTrack };
      }
    }
    return best;
  };

  // Variants turned round by `turnEndOnlyRound` below. Their far end is the
  // branch end that nothing would take, so it is not offered again — and a
  // variant other routes now measure along must never be turned a second time.
  const turnedRound = new Set<number>();

  let attachedSomething = true;
  while (attachedSomething) {
    attachedSomething = false;

    for (let i = 0; i < all.length; i++) {
      const variant = all[i];
      if (variant.points.length === 0) continue;

      const needsStart = variant.startDistance === undefined;
      const needsEnd = variant.endDistance === undefined && i < alternateCount && !turnedRound.has(i);
      if (!needsStart && !needsEnd) continue;

      // A terminus has one junction and it can be at either end of the line, so
      // both are offered to the parents and the nearer one wins - the same
      // orientation repair findTerminusJunction does against the main route.
      if (variant.type === 'terminus') {
        const fromFirst = nearestParent(variant.points[0], i);
        const fromLast = nearestParent(variant.points[variant.points.length - 1], i);
        const useLast = fromLast !== null && (fromFirst === null || fromLast.distance < fromFirst.distance);
        const chosen = useLast ? fromLast : fromFirst;
        if (chosen === null) continue;
        if (useLast) {
          const turned = reverseVariantPoints(variant);
          variant.points = turned.points;
          variant.elevation = turned.elevation;
          cumulative[i] = cumulativeKm(variant.points);
        }
        variant.startDistance = kmAlongParent(chosen.parentIndex, chosen.pointIndex);
        const terminusOffset = junctionOffset(chosen.distance);
        if (terminusOffset !== undefined) variant.startOffsetMeters = terminusOffset;
        variant.parent = { name: all[chosen.parentIndex].name, index: chosen.parentIndex };
        attachedSomething = true;
        continue;
      }

      const start = needsStart ? nearestParent(variant.points[0], i) : null;
      const end = needsEnd ? nearestParent(variant.points[variant.points.length - 1], i) : null;
      if (start === null && end === null) continue;

      if (start !== null) {
        variant.startDistance = kmAlongParent(start.parentIndex, start.pointIndex);
        startParent[i] = start.parentIndex;
        const offset = junctionOffset(start.distance);
        if (offset !== undefined) variant.startOffsetMeters = offset;
      }
      if (end !== null) {
        variant.endDistance = kmAlongParent(end.parentIndex, end.pointIndex);
        endParent[i] = end.parentIndex;
        const offset = junctionOffset(end.distance);
        if (offset !== undefined) variant.endOffsetMeters = offset;
      }

      // Turning the variant round also turns `points` round, which anything
      // hanging off this variant in a later round measures along; and it moves
      // each end's parent to the other end.
      if (normaliseJunctionOrder(variant)) {
        [startParent[i], endParent[i]] = [endParent[i], startParent[i]];
        cumulative[i] = cumulativeKm(variant.points);
      }

      // Named for the branch point when that is on an alternate; otherwise for
      // the rejoin, so a variant that leaves the main route and ends on an
      // alternate still records which one.
      const parentIndex = startParent[i] ?? endParent[i]!;
      variant.parent = { name: all[parentIndex].name, index: parentIndex };
      attachedSomething = true;
    }

    // Nothing more attaches, so a variant still held by its last point only
    // never will be by its first. Turned round now and not earlier: a variant
    // is only a parent once it has a startDistance, so nothing has measured
    // along these yet - and once turned they can be parents, so go round again.
    if (!attachedSomething) {
      for (let i = 0; i < all.length; i++) {
        if (turnedRound.has(i) || !turnEndOnlyRound(all[i])) continue;
        turnedRound.add(i);
        [startParent[i], endParent[i]] = [endParent[i], startParent[i]];
        cumulative[i] = cumulativeKm(all[i].points);
        attachedSomething = true;
      }
    }
  }

  return { alternates: all.slice(0, alternateCount), sideTrips: all.slice(alternateCount) };
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
 *
 * `mergeLoopClosure` is for the main route only. A variant that ends where it
 * started is an out-and-back side trip, and its datasheet lists the junction
 * again on the way back on purpose (the Shikoku Henro's Okunoin return).
 * The merged visit is the one at km 0, except for a waypoint `nearerEnd`
 * accepts: that one keeps whichever end is nearer.
 */
export function findWaypointVisits(
  waypoints: TrailWaypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number,
  mergeLoopClosure = false,
  nearerEnd: (waypoint: TrailWaypoint) => boolean = () => false
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

  // A loop ends where it started, so a waypoint at the trailhead is still in
  // range when the track finishes. That last pass is the visit at km 0 seen
  // again, not a second visit: recording it put the Great South West Walk's
  // Portland visitor centre at km 0 *and* km 253.7, which the duplicate-id
  // check in buildTrail rightly refuses.
  const first = trackPoints[0];
  const last = trackPoints[trackPoints.length - 1];
  const closedLoop =
    mergeLoopClosure &&
    trackPoints.length > 1 &&
    haversineDistanceMeters(first.lat, first.lon, last.lat, last.lon) <= maxDistanceMeters;
  const recorded = new Set(visits.map(v => v.waypoint));

  // Handle waypoints still inside at end of track
  for (const [wpIdx, data] of activeProximity.entries()) {
    const waypoint = waypoints[wpIdx];
    if (
      closedLoop &&
      recorded.has(waypoint) &&
      haversineDistanceMeters(waypoint.lat, waypoint.lon, first.lat, first.lon) <= maxDistanceMeters
    ) {
      // A place standing at its access junction goes to whichever end the
      // junction is nearer: one walked to from just before the finish
      // (Portland, from km 253.5 of 253.7) belongs there, not at km 0 a few
      // hundred metres from its junction. Anything else stays at km 0: a
      // recorded loop often ends a few metres nearer its start than it began.
      const atStart = visits.findIndex(v => v.waypoint === waypoint);
      if (nearerEnd(waypoint) && data.bestDistance < visits[atStart].distanceFromTrack) {
        visits[atStart] = { waypoint, trackIndex: data.bestTrackIndex, distanceFromTrack: data.bestDistance };
      }
      continue;
    }
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
 * Running climb per track point, from `cumulativeElevationChange`. When given,
 * a segment's ascent and descent are read off it instead of summing every step,
 * so the noise threshold an import applies to its totals applies to its
 * waypoints as well.
 */
export interface ClimbLadder {
  ascent: number[];
  descent: number[];
}

/**
 * Calculate segment statistics between two track indices
 */
export function calculateSegmentStats(
  points: readonly { lat: number; lon: number; ele: number }[],
  fromIndex: number,
  toIndex: number,
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
  climb?: ClimbLadder
): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = fromIndex; i < toIndex && i < points.length - 1; i++) {
    // The leg into the first point of a new stretch is the ferry, not the
    // trail. Charging for it here is what put Te Araroa's last waypoint 100 km
    // past the end of its own track: `track.points` stopped counting the
    // crossings and the waypoints did not.
    if (breakStarts.has(i + 1)) continue;

    const p1 = points[i];
    const p2 = points[i + 1];
    distance += haversineDistanceKm(p1.lat, p1.lon, p2.lat, p2.lon);

    // With a climb ladder the per-step sums would only be thrown away below,
    // and this runs once per waypoint over every import and backfill.
    if (climb) continue;
    const elevDiff = p2.ele - p1.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  if (climb && toIndex > fromIndex) {
    // The ladder already leaves the break steps out.
    const to = Math.min(toIndex, points.length - 1);
    ascent = climb.ascent[to] - climb.ascent[fromIndex];
    descent = climb.descent[to] - climb.descent[fromIndex];
  }

  return { distance, ascent, descent };
}

/** Shared empty set, so the common no-breaks call allocates nothing. */
const NO_BREAK_STARTS: ReadonlySet<number> = new Set<number>();

/**
 * Enrich waypoints with distance and elevation data by matching to track
 */
export function enrichWaypoints(
  waypoints: TrailWaypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number = DEFAULT_WAYPOINT_MAX_DISTANCE_METERS,
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
  climb?: ClimbLadder,
  nearerEnd?: (waypoint: TrailWaypoint) => boolean
): EnrichedWaypoint[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits = findWaypointVisits(waypoints, trackPoints, maxDistanceMeters, true, nearerEnd);

  if (visits.length === 0) {
    return [];
  }

  const enriched: EnrichedWaypoint[] = [];
  let prevTrackIndex = 0;
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  for (const visit of visits) {
    const segmentStats = calculateSegmentStats(trackPoints, prevTrackIndex, visit.trackIndex, breakStarts, climb);

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

/** Where the build attaches an off-route waypoint, from `data/trails/<dir>/access.json`. */
export interface WaypointAccessPlacement {
  /** The point on the route the walk to the place leaves from. */
  junction: { lat: number; lon: number };
  /** One-way walk from the junction to the place, km. */
  offTrailKm: number;
  /** Climb and descent walking in, from the junction to the place (metres). */
  ascentM?: number;
  descentM?: number;
  /** The walk in, `[lat, lon]` from the junction to the place, when it was routed. */
  path?: Array<[number, number]>;
}

/**
 * One alternate's `access.json` entries (those naming it as their `variant`),
 * applied to its waypoints by {@link enrichVariantWaypoints}: the walk leaves
 * from the alternate's own line, and the place is listed at the junction's km
 * along it.
 */
export interface VariantAccess {
  placements: ReadonlyMap<string, WaypointAccessPlacement>;
  /** Places the fetch found no way to: walked as the straight line to the alternate. */
  unrouted?: ReadonlySet<string>;
}

/**
 * The fields of a matched row the junction passes read and rewrite: a main
 * route's `EnrichedWaypoint`, or a variant's `VariantWaypoint` with its
 * `variantTrackIndex` read as `trackIndex`.
 */
type JunctionRow = Pick<
  EnrichedWaypoint,
  | 'id'
  | 'lat'
  | 'lon'
  | 'elevation'
  | 'distance'
  | 'totalDistance'
  | 'ascent'
  | 'descent'
  | 'totalAscent'
  | 'totalDescent'
  | 'trackIndex'
  | 'offTrailKm'
>;

/**
 * A junction further than this from the route no longer lies on it: the route
 * was redrawn since `fetch-access` ran, and the entry is ignored until it runs
 * again (metres).
 */
const STALE_JUNCTION_METERS = 100;

/**
 * How far a place beyond the match radius may sit past the end of its entry's
 * walk in, measured straight from the junction, and still be placed (metres).
 * Covers rounding in a hand-written `offTrailKm`.
 */
const WALK_REACH_SLACK_METERS = 50;

/**
 * The waypoints as the main route should match them: each one with a
 * placement stands at its junction, so `enrichWaypoints` attaches it to the
 * route point nearest the junction rather than nearest the place, and gets the
 * placement's walk in as `offTrailKm` — on the main route's row only, not the
 * source waypoint the variants match. Pair with {@link restoreJunctionPositions}.
 *
 * A placement is skipped, with a warning, when the place is beyond the match
 * radius and further from the junction than its walk in (the place moved, and
 * a stale entry must not pull an off-trail place onto the route), or when the
 * junction is no longer on the route. An entry whose walk does reach the place
 * places it however far off the route it is, so one long walk-in (the
 * Bibbulmun's Collie) does not need the radius widened for every waypoint.
 * A skipped waypoint is returned as the same object, an applied one as a new
 * one: {@link appliedAccessIds} reads which is which.
 */
export function matchAtJunctions(
  waypoints: TrailWaypoint[],
  placements: ReadonlyMap<string, WaypointAccessPlacement>,
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number,
  warn: (message: string) => void = () => {}
): TrailWaypoint[] {
  if (placements.size === 0) return waypoints;
  // The junction is measured to the route *line*, as fetch-access found it:
  // where the route runs straight its vertices can be a kilometre apart.
  const line = trackPoints.map(p => ({ lat: p.lat, lon: p.lon, dist: 0 }));
  return waypoints.map(wp => {
    const placement = wp.id === undefined ? undefined : placements.get(wp.id);
    if (!placement) return wp;
    const place = findNearestTrackPoint(wp, trackPoints);
    // Beyond the match radius, only an entry whose own walk reaches the place
    // counts: a place now further from its junction than the walk in has
    // moved since the entry was written, and stays off the route.
    const fromJunctionM = haversineDistanceMeters(placement.junction.lat, placement.junction.lon, wp.lat, wp.lon);
    const walkReaches = fromJunctionM <= placement.offTrailKm * 1000 + WALK_REACH_SLACK_METERS;
    if (place.distanceFromTrack > maxDistanceMeters && !walkReaches) {
      warn(
        `access for "${wp.name}" (${wp.id}) ignored: the place is ${Math.round(place.distanceFromTrack)}m ` +
          `from the route and ${Math.round(fromJunctionM)}m from its junction, beyond its ${placement.offTrailKm} km walk`
      );
      return wp;
    }
    const junctionOffM = snapToTrail(placement.junction.lat, placement.junction.lon, line)?.offTrailMeters ?? Infinity;
    if (junctionOffM > STALE_JUNCTION_METERS) {
      warn(
        `access for "${wp.name}" (${wp.id}) ignored: its junction is ${Math.round(junctionOffM)}m ` +
          'from the route — re-run fetch-access'
      );
      return wp;
    }
    // On the main route's row only, never the source waypoint: an alternate
    // or side trip that passes the place reaches it with no walk at all
    // (Shikoku's Kamiyama inns are on the Kamiyama alternative, and 3-4 km
    // off the main route).
    return {
      ...wp,
      lat: placement.junction.lat,
      lon: placement.junction.lon,
      offTrailKm: placement.offTrailKm,
      accessMode: 'foot' as const,
      ...(placement.ascentM !== undefined ? { offTrailAscentM: placement.ascentM } : {}),
      ...(placement.descentM !== undefined ? { offTrailDescentM: placement.descentM } : {}),
      ...(placement.path !== undefined ? { offTrailPath: placement.path } : {}),
    };
  });
}

/** The ids of the waypoints {@link matchAtJunctions} placed at a junction. */
export function appliedAccessIds(waypoints: readonly TrailWaypoint[], matched: readonly TrailWaypoint[]): Set<string> {
  const ids = new Set<string>();
  matched.forEach((wp, i) => {
    if (wp !== waypoints[i] && wp.id !== undefined) ids.add(wp.id);
  });
  return ids;
}

/** Segments either side of the matched vertex {@link snapBesideVertex} looks at. */
const SNAP_BESIDE_SEGMENTS = 20;

/**
 * Project a position onto the route segments near vertex `index`, never
 * across a route break: where the enrichment matched a waypoint, measured
 * along the line rather than at the vertex. Near, not adjacent: a junction may
 * sit up to 35 m off the line (`access-routing`), and the nearest segment to
 * it need not touch the nearest vertex (Great North Walk's Cowan: five vertices
 * on). Kept to a window so the other leg of an out-and-back, as close to the
 * junction, never wins; of two segments equally near, the one nearer `index`.
 */
function snapBesideVertex(
  lat: number,
  lon: number,
  points: readonly { lat: number; lon: number; dist: number }[],
  index: number,
  breakStarts: ReadonlySet<number>
): { km: number; offTrailMeters: number; segment: number } | null {
  if (points.length < 2) return null;
  let best: { km: number; offTrailMeters: number; segment: number; reach: number } | null = null;
  const first = Math.max(0, index - SNAP_BESIDE_SEGMENTS);
  const last = Math.min(points.length - 2, index + SNAP_BESIDE_SEGMENTS - 1);
  for (let k = first; k <= last; k++) {
    if (breakStarts.has(k + 1)) continue;
    const snap = snapToTrail(lat, lon, points.slice(k, k + 2));
    if (!snap) continue;
    const reach = Math.min(Math.abs(k - index), Math.abs(k + 1 - index));
    if (
      best === null ||
      snap.offTrailMeters < best.offTrailMeters - 0.5 ||
      (snap.offTrailMeters <= best.offTrailMeters + 0.5 && reach < best.reach)
    ) {
      best = { km: snap.currentKm, offTrailMeters: snap.offTrailMeters, segment: k, reach };
    }
  }
  return best && { km: best.km, offTrailMeters: best.offTrailMeters, segment: best.segment };
}

/**
 * Put each row {@link matchAtJunctions} placed at the km of its junction on the
 * route *line*. `enrichWaypoints` attaches a waypoint to the nearest vertex,
 * and on a road walk the vertices can be hundreds of metres apart: Heysen's
 * Goat Square Cottages, walked to from km 325.17 of an 856 m straight, was
 * built at the vertex at km 325.53. A moved row takes the nearer end of the
 * segment its junction projects onto as its vertex (`trackIndex`, elevation,
 * running climb), so `trackIndex` and the running totals never step backwards
 * down the list and no leg climbs a negative amount; the legs either side are
 * re-measured, and the rows put back in km order. Only `applied` ids move — an
 * entry `matchAtJunctions` ignored stands at the place, not a junction. Run
 * while the rows still stand at their junctions.
 *
 * `startKm` is the km the first row's leg is measured from: 0 on the main
 * route, an alternate's `startDistance` on its waypoints (whose `points` then
 * carry `dist` on the trail's scale and whose climb counts from `points[0]`).
 */
export function placeAtJunctionKm<T extends JunctionRow>(
  enriched: T[],
  applied: ReadonlySet<string>,
  points: readonly { lat: number; lon: number; ele: number; dist: number }[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
  climb?: ClimbLadder,
  startKm = 0
): T[] {
  if (applied.size === 0) return enriched;
  const moved = new Set<T>();
  const revertexed = new Set<T>();
  const rows = enriched.map(row => {
    if (row.id === undefined || !applied.has(row.id)) return row;
    const snap = snapBesideVertex(row.lat, row.lon, points, row.trackIndex, breakStarts);
    if (snap === null) return row;
    const km = Math.round(snap.km * 100) / 100;
    const { segment } = snap;
    const vertex = snap.km - points[segment].dist <= points[segment + 1].dist - snap.km ? segment : segment + 1;
    if (km === row.totalDistance && vertex === row.trackIndex) return row;
    const placed = { ...row, totalDistance: km };
    if (vertex !== row.trackIndex) {
      const toVertex = calculateSegmentStats(points, 0, vertex, breakStarts, climb);
      placed.trackIndex = vertex;
      placed.elevation = Math.round(points[vertex].ele);
      placed.totalAscent = Math.round(toVertex.ascent);
      placed.totalDescent = Math.round(toVertex.descent);
      revertexed.add(placed);
    }
    moved.add(placed);
    return placed;
  });
  if (moved.size === 0) return enriched;
  // By km, then as enriched: rows the move did not touch keep their order.
  const ordered = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => a.row.totalDistance - b.row.totalDistance || a.row.trackIndex - b.row.trackIndex || a.i - b.i)
    .map(({ row }) => row);
  const enrichedPrev = new Map(rows.map((row, i) => [row, rows[i - 1]]));
  return ordered.map((row, i) => {
    const prev = ordered[i - 1];
    // A leg into or out of a moved row is re-measured between the rows' own
    // totals; every other leg stays as enriched.
    const reordered = enrichedPrev.get(row) !== prev;
    if (!reordered && !moved.has(row) && !(prev !== undefined && moved.has(prev))) return row;
    const distance = Math.round((row.totalDistance - (prev?.totalDistance ?? startKm)) * 100) / 100;
    // Climb is read at the vertex, so only a leg whose ends changed vertex needs it again.
    if (!reordered && !revertexed.has(row) && !(prev !== undefined && revertexed.has(prev)))
      return { ...row, distance };
    return {
      ...row,
      distance,
      ascent: row.totalAscent - (prev?.totalAscent ?? 0),
      descent: row.totalDescent - (prev?.totalDescent ?? 0),
    };
  });
}

/**
 * The walk to an access-listed place with no junction applied — `fetch-access`
 * found no way to it (`method: 'none'`), or `matchAtJunctions` ignored its
 * entry as stale: the straight line to the route, as a hiker waypoint gets
 * (`placeUserWaypoints`), rather than no walk at all. A row whose source
 * already gives `offTrailKm` keeps it.
 */
export function straightLineAccess<T extends JunctionRow>(
  enriched: T[],
  ids: ReadonlySet<string>,
  points: readonly { lat: number; lon: number; dist: number }[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS
): T[] {
  if (ids.size === 0) return enriched;
  return enriched.map(row => {
    if (row.id === undefined || !ids.has(row.id) || row.offTrailKm !== undefined) return row;
    const snap = snapBesideVertex(row.lat, row.lon, points, row.trackIndex, breakStarts);
    return snap ? { ...row, offTrailKm: Math.round(snap.offTrailMeters / 10) / 100 } : row;
  });
}

/** Undo {@link matchAtJunctions} on the enriched rows: the place stays where it is. */
export function restoreJunctionPositions<T extends Pick<JunctionRow, 'id' | 'lat' | 'lon'>>(
  enriched: T[],
  waypoints: readonly TrailWaypoint[],
  placements: ReadonlyMap<string, WaypointAccessPlacement>
): T[] {
  if (placements.size === 0) return enriched;
  const source = new Map(waypoints.filter(wp => wp.id !== undefined && placements.has(wp.id)).map(wp => [wp.id, wp]));
  return enriched.map(ew => {
    const wp = ew.id === undefined ? undefined : source.get(ew.id);
    return wp ? { ...ew, lat: wp.lat, lon: wp.lon } : ew;
  });
}

/**
 * Enrich route variants with waypoint data.
 * For each variant, walks along its track points and matches nearby waypoints
 * using the same hysteresis approach as the main route.
 *
 * Waypoint `totalDistance` is on the TRAIL's absolute km scale: the junction
 * km where the variant leaves the main track (`startDistance`, set by
 * findVariantJunctions — call that first) plus the distance walked along the
 * variant from `points[0]`, which the junction pass guarantees is the branch
 * point. This keeps variant waypoints directly comparable with main-route
 * waypoints in datasheets. Falls back to variant-relative km when the variant
 * never attaches to the main track.
 *
 * `access` (by alternate name) places an off-route waypoint at the junction
 * where it is walked to from that *alternate* — the main route's
 * {@link matchAtJunctions} → {@link placeAtJunctionKm} →
 * {@link restoreJunctionPositions} → {@link straightLineAccess} passes, run on
 * the alternate's own line with the variant match radius. Only alternates take
 * it: a side trip is itself the way to what is near it, and a terminus ends
 * the trail. A variant with no entries is enriched exactly as before.
 */
export function enrichVariantWaypoints(
  variants: RouteVariant[],
  waypoints: TrailWaypoint[],
  access: ReadonlyMap<string, VariantAccess> = NO_VARIANT_ACCESS,
  warn: (message: string) => void = () => {}
): RouteVariant[] {
  if (waypoints.length === 0) return variants;

  return variants.map(variant => {
    if (variant.points.length === 0) return variant;

    const own = variant.type === 'alternate' ? access.get(variant.name) : undefined;
    const placements = own?.placements ?? NO_PLACEMENTS;
    const matched = matchAtJunctions(
      waypoints,
      placements,
      variant.points,
      VARIANT_WAYPOINT_MAX_DISTANCE_METERS,
      message => warn(`alternate "${variant.name}": ${message}`)
    );
    const visits = findWaypointVisits(matched, variant.points, VARIANT_WAYPOINT_MAX_DISTANCE_METERS);
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
        ...waypointAccess(visit.waypoint),
      });

      prevTrackIndex = visit.trackIndex;
    }

    if (!own) return { ...variant, waypoints: variantWaypoints };
    return { ...variant, waypoints: applyVariantAccess(variant, variantWaypoints, waypoints, matched, own) };
  });
}

const NO_PLACEMENTS: ReadonlyMap<string, WaypointAccessPlacement> = new Map();
const NO_VARIANT_ACCESS: ReadonlyMap<string, VariantAccess> = new Map();

/**
 * The main route's junction passes on one alternate's rows: each applied
 * place moves to its junction's km on the alternate's line and back to its
 * own position, and every listed place without a junction applied is walked
 * as the straight line to the alternate.
 */
function applyVariantAccess(
  variant: RouteVariant,
  rows: VariantWaypoint[],
  waypoints: TrailWaypoint[],
  matched: readonly TrailWaypoint[],
  access: VariantAccess
): VariantWaypoint[] {
  const applied = appliedAccessIds(waypoints, matched);
  const unrouted = new Set([
    ...(access.unrouted ?? []),
    ...[...access.placements.keys()].filter(id => !applied.has(id)),
  ]);
  const startKm = variant.startDistance ?? 0;
  // On the trail's scale, as the rows' `totalDistance` is.
  const points = cumulativeKm(variant.points).map((km, i) => ({ ...variant.points[i], dist: startKm + km }));
  const asRows = rows.map(row => ({ ...row, trackIndex: row.variantTrackIndex }));
  const placed = straightLineAccess(
    restoreJunctionPositions(
      placeAtJunctionKm(asRows, applied, points, NO_BREAK_STARTS, undefined, startKm),
      waypoints,
      access.placements
    ),
    unrouted,
    points
  );
  // `variantTrackIndex` keeps its place among the keys.
  return placed.map(({ trackIndex, ...row }) => ({ ...row, variantTrackIndex: trackIndex }));
}

// ---------------------------------------------------------------------------
// buildTrail
// ---------------------------------------------------------------------------

/** Mints a stable id per source waypoint (registry-backed, or deterministic). */
export type WaypointIdMinter = (waypoints: TrailWaypoint[], config: TrailConfig) => (string | undefined)[];

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
   * When set, ascent/descent — the totals and every main-route waypoint's
   * segment and running figures — count a change only once it reaches this
   * many metres from the last counted elevation (`calculateElevationStats`'
   * hysteresis), instead of summing every sample-to-sample delta.
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
  /**
   * Guess a type from words in the waypoint's name for any waypoint still
   * typed `waypoint` (or untyped) once `resolveWaypoints` has run.
   *
   * Default false. Same rationale as {@link FlattenGpxOptions.inferWaypointTypesFromKeywords}:
   * on for user imports, off for the curated build, whose folder/prefix
   * conventions are authoritative and whose generated JSON is pinned.
   *
   * This is the flag `importGpx` sets, in preference to `flattenGpx`'s: running
   * here also covers waypoints a `resolveWaypoints` hook introduces, and lets
   * the run report `keywordTypedWaypointCount`. Enabling both is redundant
   * rather than wrong — the second pass would simply find nothing to type.
   */
  inferWaypointTypesFromKeywords?: boolean;
  /** Elevation cleaning; entirely off by default. */
  elevation?: ElevationCleaningOptions;
  /** Mint stable ids for the source waypoints before enrichment. */
  mintWaypointIds?: WaypointIdMinter;
  /**
   * Off-route waypoints to attach at a junction found over OpenStreetMap
   * rather than at the route point nearest them, by waypoint id (the build
   * reads them from `data/trails/<dir>/access.json`; see `fetch-access.ts`).
   */
  waypointAccess?: ReadonlyMap<string, WaypointAccessPlacement>;
  /**
   * Off-route waypoints `fetch-access` found no way to (`method: 'none'`), by
   * id: walked as the straight line to the route ({@link straightLineAccess}).
   */
  waypointAccessUnrouted?: ReadonlySet<string>;
  /**
   * Off-route waypoints walked to from an alternate rather than the main
   * route, by alternate name (`access.json` entries with a `variant`): applied
   * to that alternate's waypoints only ({@link enrichVariantWaypoints}).
   */
  variantWaypointAccess?: ReadonlyMap<string, VariantAccess>;
  /**
   * What each resupply place sells, by waypoint id (the build reads them from
   * `access.json` entries' `store`). Set on the source waypoint once ids are
   * minted, so it reaches every row the place appears in — main route,
   * off-trail, alternate and side trip — and overrides a GPX `<tn:store>`.
   */
  waypointStores?: ReadonlyMap<string, StoreKind>;
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
  /** Human-readable self-retrace advisories (worded for trail.json authors). */
  selfRetraceWarnings: string[];
  /** The same self-retraces, structured, so callers can word their own advice. */
  selfRetraces: SelfRetrace[];
  /** Points on the built main route. */
  pointCount: number;
  /** Points in the simplified display copy. */
  displayPointCount: number;
  alternateCount: number;
  sideTripCount: number;
  /** Alternative trail ends found (they travel inside `sideTrips`). */
  terminusCount: number;
  waypointCount: number;
  offTrailWaypointCount: number;
  /**
   * Source waypoints whose type came from keyword inference (0 unless
   * `inferWaypointTypesFromKeywords` was set).
   */
  keywordTypedWaypointCount: number;
  /** Source waypoints still typed `waypoint` after every tier had a go. */
  unclassifiedWaypointCount: number;
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

  const { alternateTracks, sideTripTracks: classifiedSideTrips, terminusTracks } = selection;
  let mainRoutePoints = selection.points;
  let breaks = selection.breaks;
  for (const routeBreak of breaks) {
    log(
      `  Route break: ${(routeBreak.gapMeters / 1000).toFixed(1)} km between ` +
        `"${routeBreak.fromTrack}" and "${routeBreak.toTrack}" (not walked, not counted)`
    );
  }

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
    // A break sits *between* points i-1 and i. Reversing an n-point array sends
    // index i to n-1-i, so that same seam lands between n-i-1 and n-i, and the
    // first point after it is n-i. The two sides swap names with the direction.
    breaks = [...breaks].reverse().map(b => ({
      index: mainRoutePoints.length - b.index,
      fromTrack: b.toTrack,
      toTrack: b.fromTrack,
      gapMeters: b.gapMeters,
    }));
    log('  ✓ Reversed track direction (reverseTrack)');
  }

  // Lift configured out-and-back spurs off the main route. Explicit config
  // only - detectSelfRetraces below finds every retrace, but most are the
  // official route, so this is never automatic.
  const extractedSpurs: ParsedGpxTrack[] = [];
  if (breaks.length > 0 && (config.extractSpurs ?? []).length > 0) {
    // extractSpur cuts a range out of the main route, which moves every index
    // after it. Nothing needs both, so the honest answer is to say so rather
    // than to silently misplace the breaks.
    throw new Error(
      'trail.json declares both extractSpurs and trackClassification.stretches, ' +
        'which are not supported together: extracting a spur renumbers the points ' +
        'the route breaks are anchored to.'
    );
  }
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
  const selfRetraces = detectSelfRetraces(mainRoutePoints, { minRetraceKm: SELF_RETRACE_WARN_KM });
  const { known: knownByRetrace, stale: staleRetraces } = pairKnownRetraces(selfRetraces, config.knownRetraces ?? []);
  for (const entry of staleRetraces) {
    warn(
      `  Warning: knownRetraces lists a ${entry.lengthKm} km retrace at km ${entry.turnaroundKm} that the route ` +
        'no longer has. Remove or correct the entry in trail.json.'
    );
  }
  for (const retrace of selfRetraces) {
    const known = knownByRetrace.get(retrace);
    if (known) {
      log(
        `  ✓ Main route retraces ${retrace.retraceLengthKm.toFixed(1)} km around km ` +
          `${retrace.turnaroundKm.toFixed(1)} (known): ${known.note}`
      );
      continue;
    }
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

  // Calculate cumulative distance and elevation. The leg into the first point
  // of a new stretch is not walked, so it adds neither distance nor climb: km
  // and elevation carry across a break unchanged, and the sea between
  // Wellington and Ship Cove stops counting as 51 km of trail.
  const breakStarts = new Set(breaks.map(b => b.index));
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;

  const points: TrackPoint[] = mainRoutePoints.map((p, i, arr) => {
    if (i > 0 && !breakStarts.has(i)) {
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

  // Noise-thresholded climb, when asked for. The waypoints' segment ascent and
  // descent come from the same running count as the totals, so the last
  // waypoint's running total never claims more climb than the whole trail.
  const climb =
    options.elevation?.ascentThreshold !== undefined
      ? cumulativeElevationChange(points, options.elevation.ascentThreshold, breakStarts)
      : undefined;
  if (climb) {
    totalAscent = climb.ascent[climb.ascent.length - 1] ?? 0;
    totalDescent = climb.descent[climb.descent.length - 1] ?? 0;
  }

  // Simplify for map display (target ~3000 points for smooth rendering)
  const targetDisplayPoints = options.targetDisplayPoints ?? DEFAULT_TARGET_DISPLAY_POINTS;
  let displayPoints = points;
  // Where each break falls in `displayPoints`. Filled in alongside the
  // simplification below so the map can cut the line at the same places.
  let displayBreakIndices: number[] = breaks.map(b => b.index);

  if (points.length > targetDisplayPoints) {
    const tolerance = calculateAdaptiveTolerance(points, targetDisplayPoints, totalDistance);
    // Kept points are taken back by index. Looking them up by coordinate gave
    // every point an out-and-back or a loop passes twice the km of whichever
    // pass came last, and the Bibbulmun's display line ran backwards 26 times
    // around Denmark.
    const simplify = (stretch: TrackPoint[]): TrackPoint[] =>
      douglasPeuckerIndices(stretch, tolerance).map(i => stretch[i]);

    if (breaks.length === 0) {
      displayPoints = simplify(points);
    } else {
      // One pass per stretch. Simplifying across a break would let
      // Douglas-Peucker drop the two points either side of it — the line's
      // endpoints — and cut the corner over the water instead.
      const bounds = [0, ...displayBreakIndices, points.length];
      const simplifiedStretches: TrackPoint[][] = [];
      for (let i = 0; i < bounds.length - 1; i++) {
        simplifiedStretches.push(simplify(points.slice(bounds[i], bounds[i + 1])));
      }
      displayPoints = simplifiedStretches.flat();
      displayBreakIndices = [];
      let offset = 0;
      for (const stretch of simplifiedStretches.slice(0, -1)) {
        offset += stretch.length;
        displayBreakIndices.push(offset);
      }
    }
    log(`  ✓ Simplified ${points.length} → ${displayPoints.length} points for display`);
  }

  const routeBreaks: RouteBreak[] = breaks.map((b, i) => ({
    index: b.index,
    displayIndex: displayBreakIndices[i],
    km: Math.round(points[b.index].dist * 1000) / 1000,
    straightLineKm: Math.round(b.gapMeters) / 1000,
    fromTrack: b.fromTrack,
    toTrack: b.toTrack,
  }));

  // Get waypoints - GPX waypoints, plus whatever the caller layers on top
  // (CalTopo categories, CSV fallback).
  let waypoints: TrailWaypoint[] = gpx.waypoints;
  if (options.resolveWaypoints) {
    waypoints = options.resolveWaypoints(waypoints, config);
  }

  // Last-resort typing for user imports: guess from words in the name. Only
  // touches waypoints nothing else has typed, so a folder, a known town, a name
  // prefix or an explicit GPX `<type>` all still win. Runs after
  // `resolveWaypoints` so waypoints that hook introduces are covered too, and
  // before id minting — which hashes name/lat/lon, never type, so no id moves.
  //
  // Copies rather than mutates: with no `resolveWaypoints` hook, `waypoints` IS
  // `gpx.waypoints`, and typing in place would edit the caller's parsed result.
  // A second `buildTrail` on the same `ParsedGpxResult` would then report
  // `keywordTypedWaypointCount: 0` because the first call had already done the
  // work — and any caller reusing a parsed file (both directions, a re-import)
  // would silently get a different trail the second time.
  let keywordTypedWaypointCount = 0;
  if (options.inferWaypointTypesFromKeywords) {
    waypoints = waypoints.map(wp => {
      if (wp.type && wp.type !== 'waypoint') return wp;
      const inferred = inferWaypointTypeFromKeywords(wp.name);
      if (!inferred) return wp;
      keywordTypedWaypointCount++;
      return { ...wp, type: inferred };
    });
  }
  const unclassifiedWaypointCount = waypoints.filter(wp => !wp.type || wp.type === 'waypoint').length;

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

  // Alternative trail ends ride in the same list as the side trips - they leave
  // the trail and do not come back, which is what every consumer of that list
  // already handles - and are told apart by `type`.
  let terminusCount = 0;
  for (const track of terminusTracks) {
    const trackPoints3d = track.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    const stats = calculateRouteStats(trackPoints3d);
    sideTrips.push({
      name: track.name,
      type: 'terminus',
      points: trackPoints3d,
      distance: Math.round(stats.distance * 10) / 10,
      elevation: {
        ascent: Math.round(stats.ascent),
        descent: Math.round(stats.descent),
      },
    });
    terminusCount++;
  }

  if (alternates.length > 0) log(`  ✓ Found ${alternates.length} alternate routes from GPX`);
  if (sideTrips.length - terminusCount > 0) log(`  ✓ Found ${sideTrips.length - terminusCount} side trips`);
  if (terminusCount > 0) log(`  ✓ Found ${terminusCount} alternative termini`);

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
  if (options.waypointStores && options.waypointStores.size > 0) {
    for (const wp of waypoints) {
      const store = wp.id === undefined ? undefined : options.waypointStores.get(wp.id);
      if (store !== undefined) wp.store = store;
    }
  }

  // Enrich waypoints with distance and elevation data
  const waypointMaxDist = config.waypointMaxDistance ?? DEFAULT_WAYPOINT_MAX_DISTANCE_METERS;
  const placements = options.waypointAccess ?? new Map<string, WaypointAccessPlacement>();
  const atJunctions = matchAtJunctions(waypoints, placements, mainRoutePoints, waypointMaxDist, message =>
    warn(`  Warning: ${message}`)
  );
  const applied = appliedAccessIds(waypoints, atJunctions);
  // Every access-listed place without a junction applied is walked as the straight line.
  const unrouted = new Set([
    ...(options.waypointAccessUnrouted ?? []),
    ...[...placements.keys()].filter(id => !applied.has(id)),
  ]);
  const enrichedWaypoints = straightLineAccess(
    restoreJunctionPositions(
      placeAtJunctionKm(
        enrichWaypoints(
          atJunctions,
          mainRoutePoints,
          waypointMaxDist,
          breakStarts,
          climb,
          wp => wp.id !== undefined && applied.has(wp.id)
        ),
        applied,
        points,
        breakStarts,
        climb
      ),
      waypoints,
      placements
    ),
    unrouted,
    points,
    breakStarts
  );

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
    options.duplicateWaypointIds ?? config.revisitedWaypointIds ?? 'throw'
  );

  // Merge near-duplicate waypoints: some sources mark one physical feature with
  // two <wpt>s of the same name and type a few tens of metres apart, which shows
  // up as two adjacent identical-looking rows. (A campsite and its water tank
  // pinned under one name are two types and stay two rows.) Opt in per trail
  // via `dedupeWaypoints`.
  //
  // Placement matters: this runs AFTER id minting (which still sees every
  // source waypoint, so data/waypoint-ids.json stays append-only and retired ids
  // keep their comments) and after the duplicate-id invariant above, but before
  // the waypoint lists are handed to the output. Dropped ids are recorded on the
  // survivor as `mergedIds`.
  const dedupeConfig = config.dedupeWaypoints;
  const dedupeEnabled = dedupeConfig === true || (typeof dedupeConfig === 'object' && dedupeConfig !== null);
  const dedupeRadiusMeters =
    typeof dedupeConfig === 'object' && dedupeConfig !== null ? dedupeConfig.radiusMeters : undefined;

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

  // Enrich variants with junction point data (where they connect to main track),
  // then hang whatever is still loose off an alternate that did attach.
  const maxJunctionDistance =
    config.trackClassification?.maxJunctionDistanceMeters ?? DEFAULT_MAX_JUNCTION_DISTANCE_METERS;
  const { alternates: enrichedAlternates, sideTrips: enrichedSideTrips } = attachVariantsToParents(
    findVariantJunctions(alternates, points, maxJunctionDistance),
    findVariantJunctions(sideTrips, points, maxJunctionDistance),
    maxJunctionDistance
  );

  // Enrich variants with waypoint data (which waypoints they pass through).
  // Variants re-match the same source waypoints, so a near-duplicate pair shows
  // up twice here too and needs the same merge (preferring the main route's
  // survivor) to stay consistent with the main list.
  const dedupeVariants = (variants: RouteVariant[]): RouteVariant[] =>
    variants.map(variant =>
      variant.waypoints === undefined
        ? variant
        : { ...variant, waypoints: applyWaypointDedupe(variant.waypoints, `variant "${variant.name}"`) }
    );

  const variantAccess = options.variantWaypointAccess ?? NO_VARIANT_ACCESS;
  const alternateNames = new Set(enrichedAlternates.map(variant => variant.name));
  for (const name of variantAccess.keys()) {
    if (!alternateNames.has(name)) {
      warn(
        `  Warning: access for alternate "${name}" ignored: the trail has no alternate of that name — re-run fetch-access`
      );
    }
  }
  const alternatesWithWaypoints = dedupeVariants(
    enrichVariantWaypoints(enrichedAlternates, waypoints, variantAccess, message => warn(`  Warning: ${message}`))
  );
  const sideTripsWithWaypoints = dedupeVariants(enrichVariantWaypoints(enrichedSideTrips, waypoints));

  // Identify off-trail waypoints (not matched even at the increased threshold).
  // `matchedNames` is built from the pre-dedupe enriched list on purpose: a
  // waypoint that was matched and then merged away must not reappear here as an
  // off-trail waypoint. `mainMergedAwayIds` re-states that explicitly (the
  // name|lat|lon key would miss a merged-away twin only if two source waypoints
  // shared all three, but the guard costs nothing and states the intent).
  const matchedNames = new Set(enrichedWaypoints.map(ew => `${ew.name}|${ew.lat}|${ew.lon}`));
  // A terminus carries its own end: the `endpoint` waypoint at the free end is
  // attached to the variant, and listing it a second time as "off-trail, 31 km
  // from the route" would describe a place the trail goes as a place it misses.
  // Only termini are treated this way — an alternate or side trip's waypoints
  // have always doubled as off-trail rows and those lists are pinned output.
  const terminusWaypointKeys = new Set<string>();
  for (const variant of sideTripsWithWaypoints) {
    if (variant.type !== 'terminus') continue;
    for (const wp of variant.waypoints ?? []) {
      terminusWaypointKeys.add(`${wp.name}|${wp.lat}|${wp.lon}`);
    }
  }
  const offTrailCandidates: OffTrailWaypoint[] = waypoints
    .filter(wp => !matchedNames.has(`${wp.name}|${wp.lat}|${wp.lon}`))
    .filter(wp => !terminusWaypointKeys.has(`${wp.name}|${wp.lat}|${wp.lon}`))
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
    selfRetraces,
    pointCount: points.length,
    displayPointCount: displayPoints.length,
    alternateCount: alternatesWithWaypoints.length,
    sideTripCount: sideTripsWithWaypoints.filter(v => v.type !== 'terminus').length,
    terminusCount: sideTripsWithWaypoints.filter(v => v.type === 'terminus').length,
    waypointCount: outputWaypoints.length,
    offTrailWaypointCount: offTrailWaypoints.length,
    keywordTypedWaypointCount,
    unclassifiedWaypointCount,
  });

  return {
    config,
    track: {
      points,
      displayPoints,
      totalDistance,
      totalAscent,
      totalDescent,
      ...(routeBreaks.length > 0 ? { breaks: routeBreaks } : {}),
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
 *   points, matched in order since the display copy is a subset of them),
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
export function recomputeTrailElevation(trail: ProcessedTrail, options?: ElevationCleaningOptions): ProcessedTrail {
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

  // The step into each route break is not walked, as in `buildTrail`.
  const breakStarts = new Set((trail.track.breaks ?? []).map(b => b.index));
  let totalAscent = 0;
  let totalDescent = 0;
  for (let i = 1; i < points.length; i++) {
    if (breakStarts.has(i)) continue;
    const diff = points[i].ele - points[i - 1].ele;
    if (diff > 0) totalAscent += diff;
    else totalDescent += Math.abs(diff);
  }
  const climb =
    options?.ascentThreshold !== undefined
      ? cumulativeElevationChange(points, options.ascentThreshold, breakStarts)
      : undefined;
  if (climb) {
    totalAscent = climb.ascent[climb.ascent.length - 1] ?? 0;
    totalDescent = climb.descent[climb.descent.length - 1] ?? 0;
  }

  // Every display point is a copy of one track point, so its coordinates AND
  // its km name that point: an out-and-back or a loop passes the same
  // coordinate twice, but at two different km, and the two passes have
  // different neighbours to smooth with. The km matters for a trail imported
  // before display points were restored by index (`buildTrail`): its display
  // points are the later pass's copies, out of index order, so an in-order
  // walk of the two arrays would skip the whole outbound stretch — and scan to
  // the end of the array for every display point after it.
  const byPlace = new Map<string, number>();
  for (let i = points.length - 1; i >= 0; i--) {
    byPlace.set(placeKey(points[i]), i);
  }
  const displayPoints = trail.track.displayPoints.map(dp => {
    const i = byPlace.get(placeKey(dp));
    return i === undefined ? dp : { ...dp, ele: points[i].ele };
  });

  let prevTrackIndex = 0;
  let runningAscent = 0;
  let runningDescent = 0;
  const waypoints: EnrichedWaypoint[] = trail.waypoints.map(wp => {
    const segment = calculateSegmentStats(points, prevTrackIndex, wp.trackIndex, breakStarts, climb);
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

/** A track point's place on the trail: where it is, and which pass this is. */
function placeKey(p: { lat: number; lon: number; dist: number }): string {
  return `${p.lat},${p.lon},${p.dist}`;
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
            `the second pass falls outside the match threshold. If the route really does ` +
            `pass it twice, set "revisitedWaypointIds": "suffix".`
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
