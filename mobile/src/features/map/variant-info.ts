/**
 * Read-out for a tapped route variant (an alternate or a side trip).
 *
 * Pure + React-free: turns the raw bundled variant object into the handful of
 * unit-aware lines VariantInfoCard shows, so the wording and the km/mi handling
 * are testable without mounting a map.
 *
 * Shape notes from the bundled data (`assets/trails/*.json`), which the build
 * pipeline produces:
 *  - `distance` is the variant's own length in km, `elevation.ascent/descent` its
 *    gain/loss in metres;
 *  - `startDistance` is where it leaves the main track (km along the trail) and
 *    `endDistance` where it rejoins;
 *  - side trips carry no `endDistance` (they are out-and-back spurs), and some
 *    alternates are missing it too (e.g. Bibbulmun's "hitch into Denmark",
 *    which leaves the trail and does not come back), so a rejoin point is
 *    always optional.
 */

import { formatDistance, formatElevation, type DistanceUnit } from '@lib/format-distance';
import type { MapVariant, VariantKind } from './map-geojson';

/** A variant resolved for display, with only the fields the card can show. */
export interface VariantInfo {
  /** Feature id — matches the tapped feature's `id` (see variantFeatureId). */
  id: string;
  kind: VariantKind;
  name: string;
  /** The variant's own length, km. */
  distanceKm?: number;
  ascentM?: number;
  descentM?: number;
  /** Km along the main track where the variant branches off. */
  startKm?: number;
  /** Km along the main track where it rejoins (absent for out-and-back spurs). */
  endKm?: number;
  /** Waypoints carried on the variant itself (0 when it has none). */
  waypointCount: number;
}

/** Human label for the class of variant. */
export function variantKindLabel(kind: VariantKind): string {
  return kind === 'alternate' ? 'Alternate' : 'Side trip';
}

/** Only finite numbers are worth showing; the bundled data omits unknown fields. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the display model from a bundled variant. `id`/`kind` come from the
 * caller because they are the map's identity for the feature, not data fields.
 */
export function variantInfo(variant: MapVariant, kind: VariantKind, id: string): VariantInfo {
  return {
    id,
    kind,
    name: variant.name?.trim() || variantKindLabel(kind),
    distanceKm: num(variant.distance),
    ascentM: num(variant.elevation?.ascent),
    descentM: num(variant.elevation?.descent),
    startKm: num(variant.startDistance),
    endKm: num(variant.endDistance),
    waypointCount: variant.waypoints?.length ?? 0,
  };
}

/** "14.7 km" — the variant's own length, or null when the data has none. */
export function variantLengthLine(info: VariantInfo, unit: DistanceUnit): string | null {
  if (info.distanceKm == null) return null;
  return formatDistance(info.distanceKm, unit);
}

/** "+973 m · −962 m" — ascent/descent, or null when neither is known. */
export function variantElevationLine(info: VariantInfo, unit: DistanceUnit): string | null {
  const parts: string[] = [];
  if (info.ascentM != null) parts.push(`+${formatElevation(info.ascentM, unit)}`);
  // U+2212 minus, so the descent reads as a sign rather than a hyphen.
  if (info.descentM != null) parts.push(`−${formatElevation(info.descentM, unit)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Where the variant meets the trail:
 *   "Branches at 54.8 km · Rejoins at 58.8 km"   (alternate with a rejoin)
 *   "Branches at 215.8 km · out-and-back"        (spur, or start == end)
 *   "Branches at 909.5 km"                       (leaves the trail for good)
 * Null when the data has no junction distance at all.
 */
export function variantJunctionLine(info: VariantInfo, unit: DistanceUnit): string | null {
  if (info.startKm == null) return null;
  const branches = `Branches at ${formatDistance(info.startKm, unit)}`;
  if (info.endKm != null && info.endKm !== info.startKm) {
    return `${branches} · Rejoins at ${formatDistance(info.endKm, unit)}`;
  }
  // A spur returns the way it came; an alternate with no rejoin recorded is not
  // out-and-back, it simply leaves the trail, so only side trips say so.
  if (info.kind === 'side-trip' || info.endKm === info.startKm) {
    return `${branches} · out-and-back`;
  }
  return branches;
}

/** "3 waypoints" — null when the variant carries none. */
export function variantWaypointLine(info: VariantInfo): string | null {
  if (info.waypointCount <= 0) return null;
  return `${info.waypointCount} ${info.waypointCount === 1 ? 'waypoint' : 'waypoints'}`;
}
