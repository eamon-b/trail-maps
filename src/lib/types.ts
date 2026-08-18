// GPX Types
export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string | null;
}

export interface GpxWaypoint {
  /**
   * Stable waypoint id assigned by the build pipeline from the committed
   * registry (`data/waypoint-ids.json`). Absent for freshly-parsed GPX that
   * has not been through id assignment.
   */
  id?: string;
  lat: number;
  lon: number;
  ele: number;
  name: string;
  desc: string;
  /**
   * Explicit GPX `<type>` when the source file provides one (e.g. files
   * exported by the mobile app). Consumers prefer it over name-based
   * classification so an export→import round trip preserves the type.
   */
  type?: string;
}

export interface GpxSegment {
  points: GpxPoint[];
}

export interface GpxTrack {
  name: string;
  segments: GpxSegment[];
}

export interface GpxRoute {
  name: string;
  points: GpxPoint[];
}

export interface GpxData {
  tracks: GpxTrack[];
  routes: GpxRoute[];
  waypoints: GpxWaypoint[];
}

// GPX Splitter Types
export interface SplitOptions {
  maxPoints: number;
  waypointMaxDistance: number; // in km
}

export interface SplitResult {
  filename: string;
  content: string;
  pointCount: number;
  waypointCount: number;
}

// GPX Combiner Types
export interface CombineOptions {
  trackName: string;
  removeDuplicateWaypoints: boolean;
  /** Enable automatic reordering of routes for best geographic continuity */
  autoOrder: boolean;
  /** Gap threshold in meters - gaps larger than this trigger warnings */
  gapThresholdMeters: number;
}

export interface RouteGap {
  /** Index of the route segment before the gap */
  afterSegmentIndex: number;
  /** Distance of the gap in meters */
  distanceMeters: number;
  /** End point of the previous segment */
  fromPoint: { lat: number; lon: number };
  /** Start point of the next segment */
  toPoint: { lat: number; lon: number };
}

export interface CombineResult {
  content: string;
  pointCount: number;
  waypointCount: number;
  fileCount: number;
  /** Detected gaps between route segments */
  gaps: RouteGap[];
  /** Whether routes were reordered from input order */
  wasReordered: boolean;
  /** Order of segments after processing (indices into original input) */
  segmentOrder: number[];
}

// CSV Processor Types
export type DistanceUnit = 'km' | 'mi';
export type ElevationUnit = 'm' | 'ft';
export type CsvDelimiter = ',' | ';' | '\t';

export interface ProcessOptions {
  resupplyKeywords: string[];
  includeEndAsResupply: boolean;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  csvDelimiter: CsvDelimiter;
}

export interface ProcessedRow {
  location: string;
  elevation: number;
  ascent: number;
  descent: number;
  distance: number;
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
  notes: string;
}

export interface ResupplyRow {
  location: string;
  notes: string;
  totalDistance: number;
  distance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
}

export interface ProcessResult {
  processedPlan: string;
  resupplyPoints: string;
  stats: {
    totalPoints: number;
    resupplyCount: number;
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
}

// GPX Datasheet Types
export interface GpxProcessOptions {
  resupplyKeywords: string[];
  includeEndAsResupply: boolean;
  includeStartAsResupply: boolean;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  csvDelimiter: CsvDelimiter;
  waypointMaxDistance: number; // meters - max distance from track to include waypoint
}

export interface WaypointVisit {
  waypoint: GpxWaypoint;
  trackIndex: number;           // position along track where visit occurs
  distanceFromTrack: number;    // actual distance from track point to waypoint
}

// GPX Optimizer Types
export interface OptimizationOptions {
  // Simplification
  simplificationTolerance: number;  // meters - Douglas-Peucker epsilon

  // Elevation smoothing
  elevationSmoothing: boolean;
  elevationSmoothingWindow: number; // number of points for moving average
  spikeThreshold: number;           // meters - max elevation change to consider valid

  // Privacy
  truncateStart: number;            // meters to remove from start (0 = disabled)
  truncateEnd: number;              // meters to remove from end (0 = disabled)
  stripExtensions: boolean;         // remove proprietary extensions

  // Data retention
  preserveTimestamps: boolean;      // keep <time> elements (default: true)
  coordinatePrecision: number;      // decimal places (default: 6)

  // Validation thresholds
  maxDistanceChangeRatio: number;   // fraction (0-1) - warn if distance changes by more than this
  maxElevationChangeRatio: number;  // fraction (0-1) - warn if elevation gain changes by more than this
  maxPointCount: number;            // maximum number of points to process (0 = unlimited)
  maxFileSize: number;              // maximum input file size in bytes (0 = unlimited)
}

export interface OptimizationStats {
  pointCount: number;
  fileSize: number;               // bytes
  distance: number;               // meters
  elevationGain: number;          // meters
  elevationLoss: number;          // meters
}

export interface OptimizationResult {
  filename: string;
  content: string;                  // optimized GPX XML

  // Statistics
  original: OptimizationStats;
  optimized: OptimizationStats;

  // Validation
  warnings: string[];               // issues detected during processing
  passed: boolean;                  // true if within acceptable tolerances
}

export interface BatchOptimizationStats {
  filesProcessed: number;
  totalOriginalSize: number;
  totalOptimizedSize: number;
  averageReduction: number;         // percentage
  warnings: string[];
}

// Track Classification Types
export interface TrackClassificationConfig {
  mainRoutePatterns?: string[];     // Regex patterns for main route tracks
  alternatePatterns?: string[];     // Regex patterns for alternate routes
  sideTripPatterns?: string[];      // Regex patterns for side trips/spurs
  ignorePatterns?: string[];        // Regex patterns to ignore completely
  fallbackToLongest?: boolean;      // Use longest track if no patterns match (default: true)
}

export interface ClassifiedTrack {
  name: string;
  type: 'main' | 'alternate' | 'sideTrip' | 'ignored' | 'unclassified';
  points: GpxPoint[];
  distance: number;
}

export interface TrackClassificationResult {
  mainTracks: ClassifiedTrack[];
  alternateTracks: ClassifiedTrack[];
  sideTripTracks: ClassifiedTrack[];
  ignoredTracks: ClassifiedTrack[];
  unclassifiedTracks: ClassifiedTrack[];
}

export interface CombineTracksWarning {
  type: 'gap';
  fromTrack: string;
  toTrack: string;
  gapMeters: number;
}

export interface CombineTracksResult {
  combinedPoints: GpxPoint[];
  orderedNames: string[];
  warnings: CombineTracksWarning[];
}

// Tile Pipeline Types

export interface TileManifestFile {
  /** Logical filename — also the on-device filename (e.g. "base.mbtiles"). */
  name: string;
  size: number;
  sha256: string;
  /**
   * MD5 hex digest of the file. Verified on-device after download via the
   * expo-file-system `File.md5` property (sha256 is kept for tooling, but
   * hashing a 100MB file in JS is too slow to check on-device).
   */
  md5?: string;
  /**
   * Content-addressed remote object key under the trail prefix, e.g.
   * "base.58ce65fc4290.mbtiles" (first 12 hex chars of the sha256). Uploads
   * write new objects at new keys and swap the manifest last, so a client
   * holding the old manifest keeps downloading the old (still present)
   * objects — the manifest write is the atomic commit point. Absent in
   * manifests produced before content addressing; fall back to `name`.
   */
  key?: string;
}

export interface TileManifest {
  trailId: string;
  version: string;
  files: TileManifestFile[];
  totalSize: number;
  bounds: [number, number, number, number]; // [west, south, east, north]
  zoomRange: [number, number]; // [minZoom, maxZoom]
}

export interface TrailTileConfig {
  mgaZone: number;  // MGA zone number (50-56)
  epsg: number;     // Full EPSG code (28350-28356)
}

// Grid Tile Types

export interface GridCell {
  id: string;                                     // e.g. "E114_S34"
  bounds: [number, number, number, number];        // [west, south, east, north]
  totalSize: number;                               // bytes (base + contours)
}

export interface GridIndex {
  version: string;                                 // ISO date
  cellSizeDeg: [number, number];                   // [lonDeg, latDeg] e.g. [2, 2]
  bounds: [number, number, number, number];        // [west, south, east, north] of full grid
  cells: GridCell[];
}
