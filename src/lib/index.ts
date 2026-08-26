// Types
export type {
  GpxPoint,
  GpxWaypoint,
  GpxSegment,
  GpxTrack,
  GpxRoute,
  GpxData,
  OptimizationOptions,
  OptimizationResult,
  OptimizationStats,
  TrackClassificationConfig,
  ClassifiedTrack,
  TrackClassificationResult,
  CombineTracksResult,
  CombineTracksWarning,
} from './types';

// Distance Utilities
export {
  EARTH_RADIUS_METERS,
  haversineDistance,
  haversineDistance3D,
  waypointToPointDistance,
  isWaypointNearPoints,
  findCloseWaypoints,
} from './distance';

// GPX Optimizer
export {
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  calculateTrackDistance,
  calculateElevationStats,
  truncateTrack,
  roundCoordinates,
  GPX_OPTIMIZER_DEFAULTS,
} from './gpx-optimizer';

// Track Classification
export {
  classifyTracks,
  combineTracksGeographically,
  TRACK_CLASSIFICATION_DEFAULTS,
} from './track-classification';

// Waypoint Dedupe
export type {
  DedupableWaypoint,
  WaypointDedupeOptions,
  WaypointDedupeResult,
  WaypointMerge,
} from './waypoint-dedupe';
export {
  dedupeNearDuplicateWaypoints,
  WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS,
} from './waypoint-dedupe';

// Waypoint Classification
export type {
  ClassificationResult,
  WaypointPrefixRule,
  WaypointKeywordRule,
} from './waypoint-classifier';
export {
  classifyWaypoint,
  inferWaypointTypeFromKeywords,
  FOLDER_TYPE_MAP,
  DEFAULT_PREFIX_RULES,
  KEYWORD_RULES,
  KNOWN_TOWNS,
} from './waypoint-classifier';

// Waypoint Taxonomy — the vocabulary of types and the water/resupply families
export type { WaypointType, WaypointFamily } from './waypoint-taxonomy';
export {
  WAYPOINT_TYPES,
  WAYPOINT_TYPE_LABELS,
  waypointTypeLabel,
  isKnownWaypointType,
  WATER_TYPES,
  WATER_TYPE_ALIASES,
  RESUPPLY_TYPES,
  RESUPPLY_TYPE_ALIASES,
  isWaterWaypoint,
  isResupplyWaypoint,
  WAYPOINT_FAMILIES,
  matchesWaypointFamily,
} from './waypoint-taxonomy';
