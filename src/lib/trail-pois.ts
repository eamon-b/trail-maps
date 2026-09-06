/**
 * Placing OpenStreetMap POIs on a trail's own km scale.
 *
 * Shared by `scripts/fetch-pois.ts` (bundled trails, Node) and the in-browser
 * enrichment of imported trails, so a POI lands on the same km whichever path
 * found it. Deliberately free of `gpx-tools` imports: this module is bundled
 * for mobile via `@lib`, where that package is not installed. The library's
 * result shape is accepted structurally (`RouteProximityLike`).
 *
 * The route handed to the enrichment library is the main track first, then
 * every alternate and side trip, so POIs beside a variant are found too. The
 * library reports `segmentIndex` into the *flattened* route, so the km scale
 * is flattened the same way. Points are pre-filtered here exactly as the
 * library's `buildRouteGeometry` filters them (non-finite coordinates dropped,
 * empty polylines skipped) so the two indexings cannot drift apart.
 */

import { haversineDistance } from './distance';
import type { ProcessedTrail, RouteVariant, TrackPoint, TrailPOI, TrailPOICategory } from './trail-types';

export interface LatLon {
  lat: number;
  lon: number;
}

/** The subset of the enrichment library's `EnrichedPOI` this module reads. */
export interface RouteProximityLike {
  id: number;
  type: string;
  category: TrailPOICategory;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  /** Index of the closest segment (segmentIndex, segmentIndex + 1) in the flattened route. */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
  /** The library's own distance along the flattened route, km. */
  distanceAlongRoute: number;
  /** Cross-track distance from the route, km. */
  distanceFromRoute: number;
}

/** The route handed to the library, plus the trail km of every route point. */
export interface RouteScale {
  polylines: LatLon[][];
  /** Trail km at each flattened route point; NaN where the trail has no scale. */
  kmScale: number[];
  /** Flattened indices that end a polyline — there is no segment to index + 1. */
  breaks: Set<number>;
}

function isFinitePoint(p: { lat: number; lon: number }): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/** Cumulative km along a polyline, starting at 0. */
export function cumulativeKm(points: LatLon[]): number[] {
  const out = new Array<number>(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      total += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / 1000;
    }
    out[i] = total;
  }
  return out;
}

/**
 * Build the search route and its km scale.
 *
 * Main-track points carry their own cumulative `dist`. A variant has no km of
 * its own, so its points are placed at `startDistance + km along the variant` —
 * the same convention `VariantWaypoint.totalDistance` already uses. A variant
 * with no junction km gets NaN, which falls back to the library's own
 * along-route distance.
 */
export function buildRouteScale(
  trail: Pick<ProcessedTrail, 'track' | 'alternates' | 'sideTrips'>
): RouteScale {
  const polylines: LatLon[][] = [];
  const kmScale: number[] = [];
  const breaks = new Set<number>();

  const addPolyline = (points: LatLon[], km: number[]): void => {
    if (points.length === 0) {
      return;
    }
    if (kmScale.length > 0) {
      breaks.add(kmScale.length - 1);
    }
    polylines.push(points);
    kmScale.push(...km);
  };

  const trackPoints: TrackPoint[] = (trail.track?.points ?? []).filter(isFinitePoint);
  addPolyline(
    trackPoints.map(p => ({ lat: p.lat, lon: p.lon })),
    trackPoints.map(p => (Number.isFinite(p.dist) ? p.dist : NaN))
  );

  const variants: RouteVariant[] = [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])];
  for (const variant of variants) {
    const points = (variant.points ?? []).filter(isFinitePoint).map(p => ({ lat: p.lat, lon: p.lon }));
    if (points.length === 0) {
      continue;
    }
    const base = variant.startDistance;
    const cumulative = cumulativeKm(points);
    addPolyline(
      points,
      Number.isFinite(base) ? cumulative.map(km => (base as number) + km) : cumulative.map(() => NaN)
    );
  }

  return { polylines, kmScale, breaks };
}

/**
 * Translate a library POI's position into the trail's km scale by interpolating
 * between the two route points bracketing it. Falls back to the library's own
 * along-route distance where the trail has no scale for that point.
 */
export function trailKmFor(poi: Pick<RouteProximityLike, 'segmentIndex' | 't' | 'distanceAlongRoute'>, scale: RouteScale): number {
  const start = scale.kmScale[poi.segmentIndex];
  if (start === undefined || !Number.isFinite(start)) {
    return poi.distanceAlongRoute;
  }
  // At a polyline boundary `segmentIndex + 1` belongs to the next polyline;
  // the library reports t = 0 there, so the start point is the answer anyway.
  if (poi.t <= 0 || scale.breaks.has(poi.segmentIndex)) {
    return start;
  }
  const end = scale.kmScale[poi.segmentIndex + 1];
  if (end === undefined || !Number.isFinite(end)) {
    return start;
  }
  return start + poi.t * (end - start);
}

/** Convert enriched library POIs into `TrailPOI`s on the trail's km scale, sorted by trail km. */
export function toTrailPOIs(pois: RouteProximityLike[], scale: RouteScale): TrailPOI[] {
  const out: TrailPOI[] = pois.map(poi => ({
    id: poi.id,
    type: poi.type,
    category: poi.category,
    lat: poi.lat,
    lon: poi.lon,
    name: poi.tags.name ?? null,
    tags: poi.tags,
    distanceAlongTrail: trailKmFor(poi, scale),
    distanceFromTrail: poi.distanceFromRoute,
  }));
  out.sort((a, b) => a.distanceAlongTrail - b.distanceAlongTrail);
  return out;
}

/** Stable key for an OSM element: ids are only unique together with the element type. */
export function poiKey(poi: Pick<TrailPOI, 'type' | 'id'>): string {
  return `${poi.type}/${poi.id}`;
}
