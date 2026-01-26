import { haversineDistance } from './distance';
import type {
  GpxPoint,
  TrackClassificationConfig,
  ClassifiedTrack,
  TrackClassificationResult,
  CombineTracksResult,
  CombineTracksWarning,
} from './types';

/**
 * Default patterns for track classification when not explicitly configured.
 * These cover common naming conventions used in trail GPX files.
 */
export const TRACK_CLASSIFICATION_DEFAULTS: Required<Omit<TrackClassificationConfig, 'mainRoutePatterns' | 'ignorePatterns'>> = {
  alternatePatterns: ['\\bAlt\\b', 'Alternative', 'Detour', 'Reroute'],
  sideTripPatterns: ['^ST:', 'Spur', 'Side Trip', 'side trip'],
  fallbackToLongest: true,
};

/**
 * Gap threshold in meters for warning about discontinuities between tracks.
 * 100m is a reasonable threshold - smaller gaps are likely just GPS inaccuracy.
 */
const GAP_WARNING_THRESHOLD_METERS = 100;

/**
 * Calculate total distance of a track's points in meters.
 */
function calculateTrackDistance(points: GpxPoint[]): number {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    distance += haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
  }
  return distance;
}

/**
 * Test if a track name matches any of the given regex patterns.
 * Invalid regex patterns are silently ignored (treated as non-matching).
 */
function matchesPatterns(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(name)) {
        return true;
      }
    } catch {
      // Invalid regex - skip this pattern
      console.warn(`Invalid regex pattern: ${pattern}`);
    }
  }
  return false;
}

/**
 * Classify tracks by name patterns into main route, alternates, side trips, etc.
 *
 * Pattern matching priority:
 * 1. ignorePatterns - tracks matching these are marked as 'ignored'
 * 2. mainRoutePatterns - tracks matching these are marked as 'main'
 * 3. alternatePatterns - tracks matching these are marked as 'alternate'
 * 4. sideTripPatterns - tracks matching these are marked as 'sideTrip'
 * 5. Remaining tracks are 'unclassified'
 *
 * If no main tracks are found and fallbackToLongest is true (default),
 * the longest unclassified track becomes the main track.
 */
export function classifyTracks(
  tracks: Array<{ name: string; points: GpxPoint[] }>,
  config: TrackClassificationConfig
): TrackClassificationResult {
  const result: TrackClassificationResult = {
    mainTracks: [],
    alternateTracks: [],
    sideTripTracks: [],
    ignoredTracks: [],
    unclassifiedTracks: [],
  };

  if (tracks.length === 0) {
    return result;
  }

  // Merge config with defaults
  const alternatePatterns = config.alternatePatterns ?? TRACK_CLASSIFICATION_DEFAULTS.alternatePatterns;
  const sideTripPatterns = config.sideTripPatterns ?? TRACK_CLASSIFICATION_DEFAULTS.sideTripPatterns;
  const fallbackToLongest = config.fallbackToLongest ?? TRACK_CLASSIFICATION_DEFAULTS.fallbackToLongest;
  const mainRoutePatterns = config.mainRoutePatterns ?? [];
  const ignorePatterns = config.ignorePatterns ?? [];

  // Classify each track
  for (const track of tracks) {
    const distance = calculateTrackDistance(track.points);
    const classifiedTrack: ClassifiedTrack = {
      name: track.name,
      type: 'unclassified',
      points: track.points,
      distance,
    };

    // Apply patterns in priority order
    if (ignorePatterns.length > 0 && matchesPatterns(track.name, ignorePatterns)) {
      classifiedTrack.type = 'ignored';
      result.ignoredTracks.push(classifiedTrack);
    } else if (mainRoutePatterns.length > 0 && matchesPatterns(track.name, mainRoutePatterns)) {
      classifiedTrack.type = 'main';
      result.mainTracks.push(classifiedTrack);
    } else if (matchesPatterns(track.name, alternatePatterns)) {
      classifiedTrack.type = 'alternate';
      result.alternateTracks.push(classifiedTrack);
    } else if (matchesPatterns(track.name, sideTripPatterns)) {
      classifiedTrack.type = 'sideTrip';
      result.sideTripTracks.push(classifiedTrack);
    } else {
      result.unclassifiedTracks.push(classifiedTrack);
    }
  }

  // Fallback: if no main tracks found and fallback is enabled, use longest unclassified track
  if (result.mainTracks.length === 0 && fallbackToLongest && result.unclassifiedTracks.length > 0) {
    // Find longest unclassified track
    let longestIdx = 0;
    let longestDistance = result.unclassifiedTracks[0].distance;

    for (let i = 1; i < result.unclassifiedTracks.length; i++) {
      if (result.unclassifiedTracks[i].distance > longestDistance) {
        longestDistance = result.unclassifiedTracks[i].distance;
        longestIdx = i;
      }
    }

    // Move longest to main tracks
    const [longestTrack] = result.unclassifiedTracks.splice(longestIdx, 1);
    longestTrack.type = 'main';
    result.mainTracks.push(longestTrack);
  }

  return result;
}

/**
 * Find the best connection point between two tracks.
 * Returns distances for all four possible connections:
 * - end1 to start2
 * - end1 to end2 (track2 reversed)
 * - start1 to start2 (track1 reversed)
 * - start1 to end2 (both reversed)
 */
function findBestConnection(
  track1: { points: GpxPoint[] },
  track2: { points: GpxPoint[] }
): {
  distance: number;
  reverseTrack1: boolean;
  reverseTrack2: boolean;
} {
  if (track1.points.length === 0 || track2.points.length === 0) {
    return { distance: Infinity, reverseTrack1: false, reverseTrack2: false };
  }

  const start1 = track1.points[0];
  const end1 = track1.points[track1.points.length - 1];
  const start2 = track2.points[0];
  const end2 = track2.points[track2.points.length - 1];

  const connections = [
    {
      distance: haversineDistance(end1.lat, end1.lon, start2.lat, start2.lon),
      reverseTrack1: false,
      reverseTrack2: false,
    },
    {
      distance: haversineDistance(end1.lat, end1.lon, end2.lat, end2.lon),
      reverseTrack1: false,
      reverseTrack2: true,
    },
    {
      distance: haversineDistance(start1.lat, start1.lon, start2.lat, start2.lon),
      reverseTrack1: true,
      reverseTrack2: false,
    },
    {
      distance: haversineDistance(start1.lat, start1.lon, end2.lat, end2.lon),
      reverseTrack1: true,
      reverseTrack2: true,
    },
  ];

  return connections.reduce((best, curr) =>
    curr.distance < best.distance ? curr : best
  );
}

/**
 * Combine multiple tracks into a single continuous route by geographic proximity.
 *
 * The algorithm:
 * 1. Start with the first track
 * 2. Find the track that best connects to the current route (smallest gap)
 * 3. Reverse tracks if needed to minimize gaps
 * 4. Repeat until all tracks are combined
 *
 * Warnings are generated for gaps larger than 100m between consecutive tracks.
 */
export function combineTracksGeographically(
  tracks: Array<{ name: string; points: GpxPoint[] }>
): CombineTracksResult {
  if (tracks.length === 0) {
    return {
      combinedPoints: [],
      orderedNames: [],
      warnings: [],
    };
  }

  if (tracks.length === 1) {
    return {
      combinedPoints: [...tracks[0].points],
      orderedNames: [tracks[0].name],
      warnings: [],
    };
  }

  // Work with copies to avoid mutating input
  const remaining = tracks.map(t => ({
    name: t.name,
    points: [...t.points],
  }));

  const orderedNames: string[] = [];
  const combinedPoints: GpxPoint[] = [];
  const warnings: CombineTracksWarning[] = [];

  // Start with the first track
  const first = remaining.shift()!;
  orderedNames.push(first.name);
  combinedPoints.push(...first.points);

  // Greedily add remaining tracks by finding best connection
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestConnection = findBestConnection(
      { points: combinedPoints },
      remaining[0]
    );

    // Find the track with the best connection
    for (let i = 1; i < remaining.length; i++) {
      const connection = findBestConnection({ points: combinedPoints }, remaining[i]);
      if (connection.distance < bestConnection.distance) {
        bestConnection = connection;
        bestIdx = i;
      }
    }

    // Get the best track and remove from remaining
    const [nextTrack] = remaining.splice(bestIdx, 1);

    // Reverse if needed
    if (bestConnection.reverseTrack2) {
      nextTrack.points.reverse();
    }

    // Check if this would require reversing the entire combined route
    // (shouldn't happen often with greedy approach, but handle it)
    if (bestConnection.reverseTrack1) {
      combinedPoints.reverse();
      orderedNames.reverse();
    }

    // Check for gap warning
    if (combinedPoints.length > 0 && nextTrack.points.length > 0) {
      const lastPoint = combinedPoints[combinedPoints.length - 1];
      const firstPoint = nextTrack.points[0];
      const gapMeters = haversineDistance(
        lastPoint.lat,
        lastPoint.lon,
        firstPoint.lat,
        firstPoint.lon
      );

      if (gapMeters > GAP_WARNING_THRESHOLD_METERS) {
        warnings.push({
          type: 'gap',
          fromTrack: orderedNames[orderedNames.length - 1],
          toTrack: nextTrack.name,
          gapMeters,
        });
      }
    }

    // Add to combined route
    orderedNames.push(nextTrack.name);
    combinedPoints.push(...nextTrack.points);
  }

  return {
    combinedPoints,
    orderedNames,
    warnings,
  };
}
