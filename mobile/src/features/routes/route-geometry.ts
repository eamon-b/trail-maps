/**
 * Pure geometry for FarOut-style custom routes.
 *
 * A route is an ordered list of tapped points over a distance-sorted trail
 * track. Two point kinds:
 *   - 'snap'   — sits on the trail, carries the trail `km` at that point;
 *   - 'sketch' — an off-trail tap, `km` is null.
 *
 * Legs derive from consecutive points:
 *   - snap → snap        : an on-trail SPAN. Distance is |kmB − kmA| along the
 *                          track; ascent/descent come from the shared
 *                          `calculateElevationBetween`, direction-corrected so
 *                          walking high-km → low-km reports the real climb.
 *   - anything w/ sketch : a STRAIGHT line. Distance is the haversine between
 *                          the two vertices; it contributes 0 ascent/descent
 *                          (nothing is known about the ground between).
 *
 * Everything here is React-/MapLibre-free so the math and the emitted GeoJSON
 * are unit-testable without a device. All distances are kilometres, elevations
 * metres. The track array is whatever the caller draws + snaps against (the
 * guide passes `displayPoints`), so the emitted span polylines line up exactly
 * with the rendered trail line.
 */

import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { haversineDistance } from '@lib/distance';
import { calculateElevationBetween, findNearestByDistance } from '@lib/track-geometry';
import { snapToTrail, type SnapPoint } from '../../services/position-on-trail';

/** A track point the route is drawn over. */
export interface RouteTrackPoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance along the trail in km. */
  dist: number;
}

/** One ordered route vertex (matches the persisted `route_points` shape). */
export interface RoutePointInput {
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  /** Trail km for snap points; null for sketch points. */
  km: number | null;
}

/** A tap within this many metres of the track snaps onto the trail. */
export const SNAP_THRESHOLD_M = 200;

/**
 * Classify a map tap into a route point. A tap within `thresholdM` of the
 * track becomes a 'snap' point on the nearest track vertex (lat/lon + km taken
 * from that vertex so it sits exactly on the drawn line); a farther tap keeps
 * its raw lat/lon as a 'sketch' point (km null). Reuses the proven
 * `snapToTrail` search from position-on-trail.
 */
export function classifyTap(
  lat: number,
  lon: number,
  track: RouteTrackPoint[],
  thresholdM: number = SNAP_THRESHOLD_M,
): RoutePointInput {
  const snap = snapToTrail(lat, lon, track as unknown as SnapPoint[]);
  if (snap && snap.offTrailMeters <= thresholdM) {
    const pt = track[snap.index];
    return { kind: 'snap', lat: pt.lat, lon: pt.lon, km: pt.dist };
  }
  return { kind: 'sketch', lat, lon, km: null };
}

/** Whether a route point sits on the trail (drives snap→snap span legs). */
function isSnap(p: RoutePointInput): boolean {
  return p.kind === 'snap' && p.km != null;
}

/** Metrics + shape for one leg between two consecutive route points. */
export interface RouteLeg {
  /** Index of the leg's start point in the route's point list. */
  fromIndex: number;
  toIndex: number;
  /** True when either endpoint is a sketch point (haversine, not trail-accurate). */
  straight: boolean;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  /** On-trail span range (present only for snap→snap legs), lo → hi km. */
  startKm?: number;
  endKm?: number;
}

/** Haversine distance between two vertices, in km. */
function legHaversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000;
}

/**
 * Derive the ordered legs of a route. Snap→snap legs measure along the track
 * (with direction-corrected ascent/descent); any leg touching a sketch point
 * is a straight haversine line contributing no elevation.
 */
export function computeRouteLegs(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];

    if (isSnap(from) && isSnap(to)) {
      const kmA = from.km as number;
      const kmB = to.km as number;
      const lo = Math.min(kmA, kmB);
      const hi = Math.max(kmA, kmB);
      const { gain, loss } = calculateElevationBetween(lo, hi, track);
      // calculateElevationBetween accumulates low→high; a leg walked high→low
      // swaps climb and descent.
      const ascending = kmB >= kmA;
      legs.push({
        fromIndex: i - 1,
        toIndex: i,
        straight: false,
        distanceKm: hi - lo,
        ascentM: ascending ? gain : loss,
        descentM: ascending ? loss : gain,
        startKm: lo,
        endKm: hi,
      });
    } else {
      legs.push({
        fromIndex: i - 1,
        toIndex: i,
        straight: true,
        distanceKm: legHaversineKm(from, to),
        ascentM: 0,
        descentM: 0,
      });
    }
  }
  return legs;
}

/** Denormalized route stats (stored on the route row at save time). */
export interface RouteStats {
  totalKm: number;
  ascentM: number;
  descentM: number;
}

/** Sum a route's legs into total distance + ascent + descent. */
export function computeRouteStats(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
): RouteStats {
  const legs = computeRouteLegs(points, track);
  let totalKm = 0;
  let ascentM = 0;
  let descentM = 0;
  for (const leg of legs) {
    totalKm += leg.distanceKm;
    ascentM += leg.ascentM;
    descentM += leg.descentM;
  }
  return { totalKm, ascentM, descentM };
}

/**
 * On-trail km ranges of a route, for the elevation-profile highlight bands.
 * Straight (sketch) legs contribute nothing — only trail spans are highlighted.
 */
export function routeHighlightRanges(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
): { startKm: number; endKm: number }[] {
  return computeRouteLegs(points, track)
    .filter((leg) => !leg.straight)
    .map((leg) => ({ startKm: leg.startKm as number, endKm: leg.endKm as number }));
}

export interface RouteOverlayOptions {
  /** Also emit a Point feature per vertex (used for the live builder). */
  includeVertices?: boolean;
}

/**
 * Map-overlay GeoJSON for a route:
 *   - snap→snap legs emit the actual track slice as a LineString
 *     (`straight: false`) so the overlay hugs the trail;
 *   - straight legs emit a 2-point LineString (`straight: true`) the map draws
 *     dashed, so an off-trail leg is never read as trail-accurate;
 *   - with `includeVertices`, each route point is emitted as a Point feature
 *     (`kind` property) for the builder's tapped-dot markers.
 *
 * Mixed geometry in one collection is intentional: the map filters layers by
 * `['geometry-type']` so lines and vertices paint from one GeoJSONSource.
 */
export function buildRouteOverlayGeoJSON(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
  options: RouteOverlayOptions = {},
): FeatureCollection {
  const features: Feature[] = [];

  for (const leg of computeRouteLegs(points, track)) {
    const from = points[leg.fromIndex];
    const to = points[leg.toIndex];

    if (!leg.straight) {
      const loIdx = findNearestByDistance(track, leg.startKm as number);
      const hiIdx = findNearestByDistance(track, leg.endKm as number);
      const slice = track.slice(Math.min(loIdx, hiIdx), Math.max(loIdx, hiIdx) + 1);
      if (slice.length >= 2) {
        features.push(lineFeature(slice.map((p) => [p.lon, p.lat]), false));
        continue;
      }
      // Degenerate span (both endpoints resolve to the same track point) —
      // fall back to a straight segment between the vertices.
    }

    features.push(
      lineFeature(
        [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ],
        leg.straight,
      ),
    );
  }

  if (options.includeVertices) {
    for (const p of points) {
      features.push(vertexFeature(p));
    }
  }

  return { type: 'FeatureCollection', features };
}

function lineFeature(coordinates: number[][], straight: boolean): Feature<LineString> {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { straight },
  };
}

function vertexFeature(p: RoutePointInput): Feature<Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { kind: p.kind },
  };
}
