/**
 * Pure helpers for the waypoint list's category filter chips and the signed,
 * unit-aware distance-from-me shown on each row.
 *
 * React-free so both the grouping and the formatting are unit-testable; the
 * families are derived from the same `waypoint-category` token registry the map
 * and datasheet use, so a type only ever belongs to one family.
 */

import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { categoryToken, type WaypointColorToken } from '../elevation/waypoint-category';

/** Filter families surfaced as chips. 'all' shows every waypoint. */
export type WaypointFamily = 'all' | 'water' | 'camp' | 'town' | 'shelter';

/** The chips, in display order. */
export const FILTER_FAMILIES: { value: WaypointFamily; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'water', label: 'Water' },
  { value: 'camp', label: 'Camp' },
  { value: 'town', label: 'Town' },
  { value: 'shelter', label: 'Shelter' },
];

/** The four filterable families, keyed by their waypoint-category token. */
const TOKEN_TO_FAMILY: Partial<Record<WaypointColorToken, Exclude<WaypointFamily, 'all'>>> = {
  waypointWater: 'water',
  waypointCamp: 'camp',
  waypointTown: 'town',
  waypointShelter: 'shelter',
};

/**
 * The filterable family a waypoint type belongs to, or 'other' for types that
 * only appear under the 'all' chip (junctions, hazards, POIs…).
 */
export function familyForType(type: string): Exclude<WaypointFamily, 'all'> | 'other' {
  return TOKEN_TO_FAMILY[categoryToken(type)] ?? 'other';
}

/** Whether a waypoint type is shown under the given family filter. */
export function matchesFamily(type: string, family: WaypointFamily): boolean {
  if (family === 'all') return true;
  return familyForType(type) === family;
}

export interface SignedDistance {
  /** Human-readable, unit-aware label. */
  label: string;
  /** Sign of the delta relative to the hiker. */
  direction: 'ahead' | 'behind' | 'here';
}

/**
 * Format a waypoint's signed distance from the current km position.
 *
 * @example formatSignedDistance(12.4, 'km')  // "12.4 km ahead"
 * @example formatSignedDistance(-3.1, 'km')  // "3.1 km behind"
 * @example formatSignedDistance(0, 'km')     // "Here"
 */
export function formatSignedDistance(deltaKm: number, unit: DistanceUnit): SignedDistance {
  // Collapse sub-50 m deltas to "Here" — GPS and snap noise make a sign
  // meaningless that close.
  if (Math.abs(deltaKm) < 0.05) {
    return { label: 'Here', direction: 'here' };
  }
  const magnitude = formatDistance(Math.abs(deltaKm), unit);
  if (deltaKm > 0) {
    return { label: `${magnitude} ahead`, direction: 'ahead' };
  }
  return { label: `${magnitude} behind`, direction: 'behind' };
}
