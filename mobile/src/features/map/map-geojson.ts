/**
 * Pure GeoJSON builders for the guide map's ShapeSources.
 *
 * React-free and side-effect-free so every geometry transform is unit-testable.
 * Marker colours are injected via a `colorForType` resolver rather than read
 * from a theme here — that keeps this module pure while still routing every
 * colour through the theme tokens at the call site.
 */

import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { calculateTrailBounds, type TrackPoint } from '../../services/trail-bounds';

/** Minimal track-point shape used for polyline geometry. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Camera fit corners in MapLibre's [lon, lat] order. */
export interface CameraBounds {
  ne: [number, number];
  sw: [number, number];
}

/**
 * Fit corners for the initial camera, derived from the trail's own points via
 * the shared `calculateTrailBounds`. Returns null when there is no geometry to
 * fit (the caller then falls back to a continental default view). The buffer is
 * left at zero here; the camera adds pixel padding instead.
 */
export function trailCameraBounds(points: LatLon[]): CameraBounds | null {
  if (points.length === 0) return null;
  // Bounds only reads lat/lon; widen structurally to the richer TrackPoint the
  // shared helper expects (display points carry ele/dist, LatLon may not).
  const b = calculateTrailBounds(points as unknown as TrackPoint[], 0);
  return { ne: [b.east, b.north], sw: [b.west, b.south] };
}

/** A route variant (alternate or side trip) with its own point list. */
export interface MapVariant {
  name?: string;
  type?: string;
  points?: LatLon[];
}

/** Minimal waypoint shape needed to place and colour a marker. */
export interface MapWaypoint {
  /** Stable bundled id (e.g. "w_766c3fd2"); falls back to name when absent. */
  id?: string;
  name: string;
  lat: number;
  lon: number;
  type: string;
}

/**
 * Main-track polyline as a single LineString feature, or null when there is
 * not enough geometry to draw a line.
 */
export function buildTrailLine(points: LatLon[]): Feature<LineString> | null {
  if (points.length < 2) return null;
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [p.lon, p.lat]),
    },
    properties: {},
  };
}

/**
 * Variant polylines (alternates or side trips) as a FeatureCollection. Each
 * variant needs at least two points to form a line; degenerate variants are
 * dropped so the dashed overlay never renders a zero-length artefact.
 */
export function buildVariantCollection(variants: MapVariant[]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = variants
    .filter((v) => (v.points?.length ?? 0) >= 2)
    .map((v) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: v.points!.map((p) => [p.lon, p.lat]),
      },
      properties: { name: v.name ?? '', type: v.type ?? '' },
    }));
  return { type: 'FeatureCollection', features };
}

/**
 * Stable feature id for a waypoint. Prefers the bundled id; falls back to a
 * name+index composite so tap-routing and clustering still have a unique key
 * for legacy data without ids.
 */
export function waypointFeatureId(wp: MapWaypoint, index: number): string {
  return wp.id ?? `${wp.name}-${index}`;
}

/**
 * Waypoint markers as a FeatureCollection. Every feature carries:
 *  - a top-level `id` (the stable waypoint id) so MapLibre keeps identity
 *    across cluster/label re-layouts and tap events resolve back to it;
 *  - a `color` property (resolved from the theme via `colorForType`) so a
 *    single data-driven CircleLayer can paint every category correctly.
 */
export function buildWaypointCollection(
  waypoints: MapWaypoint[],
  colorForType: (type: string) => string,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = waypoints.map((wp, i) => {
    const id = waypointFeatureId(wp, i);
    return {
      type: 'Feature',
      id,
      geometry: {
        type: 'Point',
        coordinates: [wp.lon, wp.lat],
      },
      properties: {
        id,
        name: wp.name,
        type: wp.type,
        color: colorForType(wp.type),
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

/**
 * Single-point feature for the user-location puck. Carries the fix's accuracy
 * (metres) so the accuracy-circle layer can size itself in map pixels.
 */
export function buildUserLocationGeoJSON(
  lat: number,
  lon: number,
  accuracy: number | null,
): Feature<Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { accuracy: accuracy ?? 0 },
  };
}

/**
 * MapLibre zoom-interpolated expression converting a fix's accuracy (metres,
 * read from the feature's `accuracy` property) into a screen-pixel circle
 * radius, clamped to [2, 200] px. With `circlePitchAlignment: 'map'` the circle
 * sits on the map plane; radius is still in pixels at the current zoom, so we
 * precompute pixels-per-metre at each discrete zoom.
 *
 *   metresPerPixel(z) = cos(lat) · 40075017 / (256 · 2^z)
 *   pixelsPerMetre(z) = 256 · 2^z / (cos(lat) · 40075017)
 */
export function accuracyCircleRadiusExpression(latDegrees: number): unknown[] {
  const latRad = (latDegrees * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  const base = 256 / (cosLat * 40075017);
  const stops: unknown[] = [];
  for (let z = 5; z <= 20; z++) {
    const ppm = base * Math.pow(2, z);
    stops.push(z, ['min', 200, ['max', 2, ['*', ['get', 'accuracy'], ppm]]]);
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}
