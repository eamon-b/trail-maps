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
import { waypointIconName } from './waypoint-icons';

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

/** Which class of variant a collection holds. Also the feature-id prefix. */
export type VariantKind = 'alternate' | 'side-trip';

/**
 * A route variant (alternate or side trip) with its own point list. Everything
 * past `points` is the read-out the info card shows when the line is tapped; all
 * of it is optional because the bundled data omits what the pipeline could not
 * compute (see variant-info for the per-field notes).
 */
export interface MapVariant {
  name?: string;
  type?: string;
  points?: LatLon[];
  /** The variant's own length, km. */
  distance?: number;
  elevation?: { ascent?: number; descent?: number };
  /** Km along the main track where the variant leaves it. */
  startDistance?: number;
  /** Km along the main track where it rejoins (absent for out-and-back spurs). */
  endDistance?: number;
  /** Waypoints that sit on the variant rather than the main track. */
  waypoints?: unknown[];
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
 * Stable feature id for a variant line. The index is the variant's position in
 * its *own* class list, so the id round-trips a tap back to the source object
 * (`alternates[2]` → "alternate-2") without depending on names being unique.
 */
export function variantFeatureId(kind: VariantKind, index: number): string {
  return `${kind}-${index}`;
}

/**
 * Variant polylines (alternates or side trips) as a FeatureCollection. Each
 * variant needs at least two points to form a line; degenerate variants are
 * dropped so the dashed overlay never renders a zero-length artefact.
 *
 * Ids are assigned from the *unfiltered* index so a dropped degenerate variant
 * never shifts the ids of the ones after it — the id is how a tap finds its
 * variant again.
 */
export function buildVariantCollection(
  variants: MapVariant[],
  kind: VariantKind,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = variants
    .map((v, index) => ({ v, index }))
    .filter(({ v }) => (v.points?.length ?? 0) >= 2)
    .map(({ v, index }) => {
      const id = variantFeatureId(kind, index);
      return {
        type: 'Feature' as const,
        id,
        geometry: {
          type: 'LineString' as const,
          coordinates: v.points!.map((p) => [p.lon, p.lat]),
        },
        // Only identity travels through the map: the tap handler resolves `id`
        // back to the variant object, so the numeric read-out never has to
        // survive a round trip through native feature properties.
        properties: { id, kind, name: v.name ?? '', type: v.type ?? '' },
      };
    });
  return { type: 'FeatureCollection', features };
}

/**
 * Whether any variant in the list can actually be drawn (same >= 2 point rule
 * `buildVariantCollection` applies). Drives the map key: a class that renders no
 * line must not appear in the legend.
 */
export function hasDrawableVariant(variants: MapVariant[] | undefined): boolean {
  return (variants ?? []).some((v) => (v.points?.length ?? 0) >= 2);
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
 *    single data-driven CircleLayer can paint every category correctly;
 *  - an `icon` property (the glyph name from waypoint-icons) so a single
 *    data-driven SymbolLayer can draw every type's marker glyph via
 *    `iconImage: ['get', 'icon']`;
 *  - a `favorite` boolean (true when the id is in `favoriteIds`) so the same
 *    CircleLayer can enlarge/ring starred markers via a `case` paint
 *    expression, without a second source or breaking clustering.
 */
export function buildWaypointCollection(
  waypoints: MapWaypoint[],
  colorForType: (type: string) => string,
  favoriteIds?: ReadonlySet<string>,
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
        icon: waypointIconName(wp.type),
        favorite: favoriteIds?.has(id) ?? false,
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
