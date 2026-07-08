/**
 * Opt-in elevation backfill for imported GPX trails without <ele> data.
 *
 * Uses the Open-Meteo elevation API (90m Copernicus DEM) to look up elevation
 * for a limited set of sample points along the track, then linearly
 * interpolates over cumulative distance to fill every track point.
 *
 * Offline-first contract: strictly user-triggered from the import screen
 * ("Fetch elevation data (requires internet)"); never called automatically.
 */

import { trailJsonToTrail, type Trail, type TrackPoint, type TrailWaypoint } from '../lib/trail-utils';
import { calculateSegmentStats } from '../lib/gpx-processor';
import type { TrailJson } from './trail-loader';
import { TrailDataService } from './trail-data-service';

const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

/** Open-Meteo accepts up to 100 coordinates per request. */
export const ELEVATION_BATCH_SIZE = 100;

/** Max number of DEM lookups per trail. */
export const MAX_ELEVATION_SAMPLES = 500;

export interface Coordinate {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------
// Sample selection
// ---------------------------------------------------------------------------

/**
 * Pick up to `maxSamples` track points evenly spaced by cumulative distance.
 * Returns parallel arrays of sample distances (km) and coordinates, sorted by
 * distance and de-duplicated.
 */
export function pickElevationSamplePoints(
  points: TrackPoint[],
  maxSamples: number = MAX_ELEVATION_SAMPLES,
): { dists: number[]; coords: Coordinate[] } {
  if (points.length === 0) return { dists: [], coords: [] };

  if (points.length <= maxSamples) {
    return {
      dists: points.map((p) => p.dist),
      coords: points.map((p) => ({ lat: p.lat, lon: p.lon })),
    };
  }

  const totalDist = points[points.length - 1].dist;
  const dists: number[] = [];
  const coords: Coordinate[] = [];
  let searchFrom = 0;
  let lastIndex = -1;

  for (let i = 0; i < maxSamples; i++) {
    const target = (totalDist * i) / (maxSamples - 1);
    // Points are sorted by dist; advance a moving cursor to the nearest point
    while (
      searchFrom < points.length - 1 &&
      Math.abs(points[searchFrom + 1].dist - target) <= Math.abs(points[searchFrom].dist - target)
    ) {
      searchFrom++;
    }
    if (searchFrom !== lastIndex) {
      lastIndex = searchFrom;
      dists.push(points[searchFrom].dist);
      coords.push({ lat: points[searchFrom].lat, lon: points[searchFrom].lon });
    }
  }

  return { dists, coords };
}

// ---------------------------------------------------------------------------
// Open-Meteo elevation fetch
// ---------------------------------------------------------------------------

/**
 * Fetch elevations for a list of coordinates from the Open-Meteo elevation
 * API, batching requests at 100 coordinates each.
 *
 * Network access — must only be called from a user-triggered action.
 * Throws on any batch failure (callers fall back to a flat import).
 */
export async function fetchElevations(
  coords: Coordinate[],
  onProgress?: (done: number, total: number) => void,
): Promise<(number | null)[]> {
  const elevations: (number | null)[] = [];

  for (let start = 0; start < coords.length; start += ELEVATION_BATCH_SIZE) {
    const batch = coords.slice(start, start + ELEVATION_BATCH_SIZE);
    const params = new URLSearchParams({
      latitude: batch.map((c) => c.lat).join(','),
      longitude: batch.map((c) => c.lon).join(','),
    });

    const response = await fetch(`${ELEVATION_ENDPOINT}?${params}`);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Elevation API error: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    const data = (await response.json()) as { elevation?: (number | null)[] };
    if (!Array.isArray(data.elevation) || data.elevation.length !== batch.length) {
      throw new Error('Elevation API returned an unexpected response');
    }

    // Preserve nulls (DEM gaps) verbatim. Zero-filling them here would drop the
    // sample to sea level, and interpolation would then ramp down to 0 and back
    // up, fabricating ~2x the gap's worth of phantom ascent+descent. Callers
    // drop null samples so the interpolator bridges the gap from real neighbours.
    elevations.push(...data.elevation);
    onProgress?.(Math.min(start + batch.length, coords.length), coords.length);
  }

  return elevations;
}

/**
 * Drop samples whose fetched elevation is null (DEM gaps), keeping the parallel
 * `dists`/`eles` arrays aligned. The remaining real samples let
 * backfillTrackElevation interpolate straight across each gap.
 */
export function dropNullElevationSamples(
  dists: number[],
  eles: (number | null)[],
): { dists: number[]; eles: number[] } {
  const outDists: number[] = [];
  const outEles: number[] = [];
  for (let i = 0; i < eles.length; i++) {
    const e = eles[i];
    if (e != null) {
      outDists.push(dists[i]);
      outEles.push(e);
    }
  }
  return { dists: outDists, eles: outEles };
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Backfill elevation for every track point by linearly interpolating the
 * sampled elevations over cumulative distance. `sampleDists` must be sorted
 * ascending and parallel to `sampleEles`. Points before the first / after the
 * last sample are clamped to the nearest sample's elevation.
 *
 * Returns new point objects; the input is not mutated.
 */
export function backfillTrackElevation<P extends { dist: number; ele: number }>(
  points: P[],
  sampleDists: number[],
  sampleEles: number[],
): P[] {
  if (sampleDists.length === 0 || sampleDists.length !== sampleEles.length) {
    throw new Error('backfillTrackElevation requires matching, non-empty sample arrays');
  }

  let seg = 0; // index of the sample segment [seg, seg+1] under the cursor

  return points.map((p) => {
    let ele: number;
    if (p.dist <= sampleDists[0]) {
      ele = sampleEles[0];
    } else if (p.dist >= sampleDists[sampleDists.length - 1]) {
      ele = sampleEles[sampleEles.length - 1];
    } else {
      // Move the segment cursor so that sampleDists[seg] <= p.dist <= sampleDists[seg+1].
      // Track points are sorted by dist, so this walk is amortized O(1).
      while (seg < sampleDists.length - 2 && sampleDists[seg + 1] < p.dist) seg++;
      while (seg > 0 && sampleDists[seg] > p.dist) seg--;
      const d0 = sampleDists[seg];
      const d1 = sampleDists[seg + 1];
      const e0 = sampleEles[seg];
      const e1 = sampleEles[seg + 1];
      ele = d1 === d0 ? e0 : e0 + ((p.dist - d0) / (d1 - d0)) * (e1 - e0);
    }

    return { ...p, ele: Math.round(ele * 10) / 10 };
  });
}

// ---------------------------------------------------------------------------
// Trail stats recomputation (mirrors the gpx-processor stats pass)
// ---------------------------------------------------------------------------

function recomputeWaypointStats(
  waypoints: TrailWaypoint[],
  points: TrackPoint[],
): TrailWaypoint[] {
  let prevTrackIndex = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  return waypoints.map((wp) => {
    if (wp.trackIndex == null || wp.trackIndex >= points.length) return wp;

    // Segment ascent/descent between the previous waypoint and this one,
    // via the shared gpx-processor stats pass (distance is ignored here).
    const { ascent, descent } = calculateSegmentStats(points, prevTrackIndex, wp.trackIndex);
    runningAscent += ascent;
    runningDescent += descent;
    prevTrackIndex = wp.trackIndex;

    return {
      ...wp,
      elevation: Math.round(points[wp.trackIndex].ele),
      ascent: Math.round(ascent),
      descent: Math.round(descent),
      totalAscent: Math.round(runningAscent),
      totalDescent: Math.round(runningDescent),
    };
  });
}

/**
 * Apply fetched elevation samples to a processed trail: backfills every track
 * point (full + display resolution) and re-runs the gpx-processor stats pass
 * (total ascent/descent, waypoint elevations and segment ascent/descent).
 * Distances are unaffected (they are computed from lat/lon only).
 *
 * Pure — returns a new Trail.
 */
export function applyElevationToTrail(
  trail: Trail,
  sampleDists: number[],
  sampleEles: number[],
): Trail {
  const points = backfillTrackElevation(trail.track.points, sampleDists, sampleEles);
  const displayPoints = trail.track.displayPoints
    ? backfillTrackElevation(trail.track.displayPoints, sampleDists, sampleEles)
    : undefined;

  // Total ascent/descent over the full-resolution track via the shared pass.
  const { ascent: totalAscent, descent: totalDescent } = calculateSegmentStats(
    points,
    0,
    points.length,
  );

  return {
    ...trail,
    track: {
      ...trail.track,
      points,
      displayPoints,
      totalAscent,
      totalDescent,
    },
    waypoints: recomputeWaypointStats(trail.waypoints, points),
  };
}

// ---------------------------------------------------------------------------
// Post-save backfill orchestration
// ---------------------------------------------------------------------------

/** Merge an elevation-updated Trail back into its stored TrailJson shape,
 * preserving config and any extra top-level fields from the original. */
function trailToTrackData(trail: Trail, base: TrailJson): TrailJson {
  return {
    ...base,
    waypoints: trail.waypoints.map((wp) => ({
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      type: wp.type,
      description: wp.description,
      elevation: wp.elevation,
      distance: wp.distance,
      totalDistance: wp.totalDistance,
      ascent: wp.ascent,
      descent: wp.descent,
      totalAscent: wp.totalAscent,
      totalDescent: wp.totalDescent,
    })),
    track: {
      points: trail.track.points,
      displayPoints: trail.track.displayPoints ?? trail.track.points,
      totalDistance: trail.track.totalDistance,
      totalAscent: trail.track.totalAscent,
      totalDescent: trail.track.totalDescent,
    },
  };
}

/** True when a stored custom trail has no usable elevation data (flat profile),
 * i.e. importing offline left every track point at 0 m. */
export function trailLacksElevation(trail: Trail): boolean {
  return (
    (trail.track.totalAscent ?? 0) === 0 &&
    (trail.track.totalDescent ?? 0) === 0 &&
    trail.track.points.every((p) => (p.ele ?? 0) === 0)
  );
}

/**
 * Backfill elevation for an already-saved custom trail: loads the stored track,
 * runs pick -> fetch -> apply, and persists the result. Mirrors climate's
 * ensureCustomTrailClimate so a trail imported offline can gain elevation later.
 *
 * Network access — must only be called from a user-triggered action.
 * The whole body is guarded: any failure resolves to null and persists nothing.
 */
export async function backfillTrailElevation(
  trailId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Trail | null> {
  try {
    const service = await TrailDataService.create();
    const json = await service.getTrailTrackData(trailId);
    if (!json) return null;

    const trail = trailJsonToTrail(json);
    const { dists, coords } = pickElevationSamplePoints(trail.track.points);
    if (coords.length === 0) return null;

    const rawEles = await fetchElevations(coords, onProgress);
    const { dists: validDists, eles: validEles } = dropNullElevationSamples(dists, rawEles);
    if (validEles.length === 0) return null;

    const updated = applyElevationToTrail(trail, validDists, validEles);
    await service.storeCustomTrailData(trailId, trailToTrackData(updated, json));
    return updated;
  } catch (e) {
    console.warn('Elevation backfill failed:', e);
    return null;
  }
}
