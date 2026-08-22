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
  /** Marks a trail produced by the runtime GPX importer rather than the build. */
  source?: 'imported';
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
}

/** The built main route: full resolution plus a simplified display copy. */
export interface TrackData {
  points: TrackPoint[];
  displayPoints: TrackPoint[];
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
}

/** A fully processed trail — the serialized form of a generated trail JSON. */
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
}
