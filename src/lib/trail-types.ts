/**
 * The shape of a processed trail — the single definition shared by the build
 * pipeline (`scripts/build-trails.ts`), the runtime GPX importer
 * (`gpx-import.ts`), the web viewers and the mobile app.
 *
 * These types used to live as locals in `scripts/build-trails.ts` and were
 * hand-duplicated as `TrailJson` on mobile and as two `interface Trail`s in the
 * web viewers. The generated `public/data/generated/{id}.json` is exactly a
 * serialized {@link ProcessedTrail}.
 *
 * Platform-neutral: no Node, DOM or React Native imports.
 */

import type { TrackClassificationConfig } from './types';

/** Where a trail's climate data was sampled. */
export interface ClimateLocationConfig {
  name: string;
  waypointName?: string;
  lat: number;
  lon: number;
}

/** Display labels for the two hiking directions (e.g. Northbound/Southbound). */
export interface DirectionConfig {
  default: string;
  reversed: string;
}

/**
 * An out-and-back section folded into the main-route track that should be
 * lifted out into a side trip. `fromKm`/`toKm` are in the *built* km space,
 * i.e. after `reverseTrack` has been applied, and `toKm` defaults to the end of
 * the track (the common case: a summit spur off a terminus).
 */
export interface SpurExtractionConfig {
  name: string;
  fromKm: number;
  toKm?: number;
}

/**
 * Where a trail's GPX track came from. `text` is the sentence shown to
 * readers; `url` links back to the guide when the track is someone else's.
 */
export interface TrailDataSource {
  text: string;
  url?: string;
  linkText?: string;
}

export interface TrailConfig {
  id: string;
  name: string;
  shortName: string;
  region: string;
  lengthKm: number;
  gpxFile: string;
  /** CalTopo GeoJSON file for alternates/side trips (build script only). */
  geojsonFile?: string;
  trackClassification?: TrackClassificationConfig;
  /** Reverse the source track so km 0 is the trail's canonical start. */
  reverseTrack?: boolean;
  /** Out-and-back sections to lift out of the main route. */
  extractSpurs?: SpurExtractionConfig[];
  /** Merge near-duplicate waypoints (same name + type within radius, default 150m). */
  dedupeWaypoints?: boolean | { radiusMeters?: number };
  /** Max distance (meters) from track to match waypoints (default 500). */
  waypointMaxDistance?: number;
  waypointsFile?: string;
  climateFile?: string;
  climateLocations?: ClimateLocationConfig[];
  description?: string;
  direction?: DirectionConfig;
  /**
   * Provenance of the GPX track: who made it and, when it is someone else's
   * work, where to find the guide it came from. Rendered as an attribution
   * note on the trail page.
   */
  dataSource?: TrailDataSource;
  /** Marks a trail produced by the runtime GPX importer rather than the build. */
  source?: 'imported';
  /**
   * Where the track's elevations came from: the source file (`'gpx'`), a
   * terrain-API backfill (`'backfilled'`), or nowhere at all (`'none'` — the
   * profile is flat and day estimates are distance-only).
   *
   * Optional, and only written by the runtime importer: bundled trails omit it,
   * which is what keeps `public/data/generated/*.json` byte-identical.
   */
  elevationSource?: 'gpx' | 'backfilled' | 'none';
}

/** A raw source waypoint, before it is matched against the track. */
export interface TrailWaypoint {
  /** Stable id assigned from the committed registry, or minted for imports. */
  id?: string;
  name: string;
  lat: number;
  lon: number;
  type: string;
  description?: string;
  /** Ids of near-duplicate waypoints merged into this one (see dedupeWaypoints). */
  mergedIds?: string[];
}

/** A waypoint matched to the main route and enriched with cumulative stats. */
export interface EnrichedWaypoint extends TrailWaypoint {
  elevation: number;
  /** Segment distance from previous waypoint (km). */
  distance: number;
  /** Cumulative distance along route (km). */
  totalDistance: number;
  /** Segment ascent from previous waypoint (m). */
  ascent: number;
  /** Segment descent from previous waypoint (m). */
  descent: number;
  totalAscent: number;
  totalDescent: number;
  /** Index in the track points array. */
  trackIndex: number;
}

/** One proximity episode of the route passing a waypoint. */
export interface WaypointVisit {
  waypoint: TrailWaypoint;
  trackIndex: number;
  distanceFromTrack: number;
}

/** A waypoint matched to an alternate/side-trip rather than the main route. */
export interface VariantWaypoint {
  /** Stable id, shared with the same waypoint on the main route. */
  id?: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation: number;
  /** Segment distance from previous waypoint (variant-relative). */
  distance: number;
  /** Absolute trail km: junction startDistance + distance along the variant. */
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
  description?: string;
  mergedIds?: string[];
}

/** An alternate route or side trip hanging off the main route. */
export interface RouteVariant {
  name: string;
  type: 'alternate' | 'side-trip';
  points: { lat: number; lon: number; ele: number }[];
  distance: number;
  elevation: { ascent: number; descent: number };
  /** km along the main route where the variant branches. */
  startDistance?: number;
  startTrackIndex?: number;
  /** km where an alternate rejoins the main route. */
  endDistance?: number;
  endTrackIndex?: number;
  /**
   * How far the branch end really sits from what it attached to, in metres.
   * Only recorded past the standard 500 m tolerance - i.e. only for a trail
   * that raised `trackClassification.maxJunctionDistanceMeters` to take in a
   * loose end - so the junction km can be read together with the gap it papers
   * over rather than pretending the alternate touches the route.
   */
  startOffsetMeters?: number;
  /** The same residual for the rejoin end. */
  endOffsetMeters?: number;
  /**
   * The alternate this variant hangs off, when its junction is on that
   * alternate rather than on the main route. `index` is into the trail's
   * `alternates` array. `startDistance`/`endDistance` stay ordinary absolute
   * trail km (the parent's junction km plus the walk along the parent), so
   * every consumer reads a parent-attached variant like any other.
   */
  parent?: { name: string; index: number };
  waypoints?: VariantWaypoint[];
}

/** A source waypoint that never came within the match threshold of the route. */
export interface OffTrailWaypoint extends TrailWaypoint {
  /** Distance to the nearest track point, in meters. */
  distanceFromTrail: number;
}

/** One point of the built main route, carrying its cumulative km. */
export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance from the start of the route, in km. */
  dist: number;
  /**
   * Cumulative ascent from the start of the route to this point, in metres,
   * measured on the *full-resolution* track (the step into a route break is not
   * climbed, as for `TrackData.totalAscent`).
   *
   * Only the phone's thinned copies carry this pair, written by
   * `scripts/build-mobile-trails.ts`: summing point-to-point steps over a
   * 5,000-point track loses most of its small climbs, so the climb over a span
   * is read as the difference of its two ends instead. Absent — and not needed
   * — wherever the points are full resolution, which is the generated web JSON
   * and every imported trail.
   */
  cumAscent?: number;
  /** Cumulative descent to this point, in metres. Present iff `cumAscent` is. */
  cumDescent?: number;
}

/** The built main route: full resolution plus a simplified display copy. */
export interface TrackData {
  points: TrackPoint[];
  displayPoints: TrackPoint[];
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
  /**
   * Places the walking route stops and resumes somewhere else. Absent for the
   * trails whose route is continuous — only a trail declaring
   * `trackClassification.stretches` can have any.
   */
  breaks?: RouteBreak[];
}

/**
 * A place where the walking route ends and starts again somewhere else: a
 * ferry, a river with no crossing, a lake. The route does not cross it, so it
 * contributes no distance and no climb, and `points` either side of it are two
 * separate lines rather than one.
 */
export interface RouteBreak {
  /** Index into `TrackData.points` of the first point after the break. */
  index: number;
  /** Index into `TrackData.displayPoints` of that same point. */
  displayIndex: number;
  /** Route km, which is the same on both sides — the route does not advance. */
  km: number;
  /** Straight-line distance across the break, in km. Not part of `totalDistance`. */
  straightLineKm: number;
  /** Name of the stretch that ends here, and of the one that resumes. */
  fromTrack: string;
  toTrack: string;
}

/** A fully processed trail — the serialized form of a generated trail JSON. */
/** The six OpenStreetMap POI families the enrichment catalog produces. */
export type TrailPOICategory =
  | 'water'
  | 'camping'
  | 'resupply'
  | 'restaurant'
  | 'transport'
  | 'emergency';

/**
 * An OpenStreetMap point of interest near the trail, found by `scripts/fetch-pois.ts`
 * (bundled trails) or by the in-browser enrichment (imported trails). Kept separate
 * from waypoints: POIs are uncurated, carry no registry id, and can be hidden or
 * rejected without touching the waypoint data. Data is © OpenStreetMap contributors (ODbL).
 */
export interface TrailPOI {
  /** OSM element id. Only unique together with `type`. */
  id: number;
  /** OSM element type: 'node' | 'way' | 'relation'. */
  type: string;
  category: TrailPOICategory;
  lat: number;
  lon: number;
  name: string | null;
  tags: Record<string, string>;
  /** km along the trail, on the same scale as `track.points[].dist` and `waypoints[].totalDistance`. */
  distanceAlongTrail: number;
  /** Cross-track distance from the trail, km. */
  distanceFromTrail: number;
  /**
   * Set when this POI describes a place a curated waypoint already covers; holds
   * that waypoint's stable id. Derived at build/import time by
   * `@lib/poi-dedup`, never stored in `data/trails/<dir>/pois.json`.
   *
   * Flagged rather than removed so the OSM detail (`website`, `opening_hours`,
   * `operator`) stays available to show on the waypoint it duplicates. The UI
   * hides these: the curated waypoint is the one marker for that place.
   */
  duplicateOf?: string;
  /** Metres between this POI and the waypoint it duplicates. Review aid. */
  duplicateDistanceM?: number;
}

export interface ProcessedTrail {
  config: TrailConfig;
  track: TrackData;
  waypoints: EnrichedWaypoint[];
  offTrailWaypoints: OffTrailWaypoint[];
  alternates: RouteVariant[];
  sideTrips: RouteVariant[];
  climate: Record<string, unknown> | null;
  climateLocations: ClimateLocationConfig[] | null;
  direction: DirectionConfig | null;
  /** OSM points of interest near the trail, sorted by `distanceAlongTrail`. Absent when never fetched. */
  pois?: TrailPOI[];
}
