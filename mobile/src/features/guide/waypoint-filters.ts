/**
 * Pure helpers for the waypoint list's category filter chips and the signed,
 * unit-aware distance-from-me shown on each row.
 *
 * React-free so both the grouping and the formatting are unit-testable; the
 * families are derived from the same `waypoint-category` token registry the map
 * and datasheet use, so a type only ever belongs to one family.
 *
 * The chips scope the OpenStreetMap rows the list interleaves too, which is a
 * separate mapping (`poiCategoriesForFamily`): POI categories are their own
 * vocabulary, and two of the families have no OSM equivalent at all.
 */

import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { POI_CATEGORIES } from '@lib/poi-display';
import type { TrailPOICategory } from '@lib/trail-types';
import { categoryToken, type WaypointColorToken } from '../elevation/waypoint-category';

/**
 * Filter families surfaced as chips. 'all' shows every waypoint; 'favorites'
 * shows only starred waypoints (an id-based, not type-based, cut).
 */
export type WaypointFamily = 'all' | 'favorites' | 'water' | 'camp' | 'town' | 'shelter';

/** The chips, in display order. */
export const FILTER_FAMILIES: { value: WaypointFamily; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'favorites', label: 'Favorites' },
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

/**
 * Whether a waypoint is shown under the given family filter. `isFavorite` is
 * only consulted for the 'favorites' family (an id-based cut); the type-based
 * families ignore it.
 */
export function matchesFamily(type: string, family: WaypointFamily, isFavorite = false): boolean {
  if (family === 'all') return true;
  if (family === 'favorites') return isFavorite;
  return familyForType(type) === family;
}

const FAMILY_TO_POI_CATEGORIES: Record<WaypointFamily, readonly TrailPOICategory[]> = {
  all: POI_CATEGORIES,
  favorites: [],
  water: ['water'],
  camp: ['camping'],
  town: ['resupply', 'restaurant'],
  shelter: [],
};

/**
 * The OSM POI categories a chip shows.
 *
 * 'shelter' has no OSM counterpart the enrichment produces (a hut is either a
 * curated waypoint or nothing), and 'favorites' is an id-based cut over curated
 * waypoints — a POI can never be starred — so both show no POI rows at all.
 * 'town' is the one family that spans two categories: a supermarket and a pub
 * are the same errand to a walker.
 */
export function poiCategoriesForFamily(family: WaypointFamily): readonly TrailPOICategory[] {
  return FAMILY_TO_POI_CATEGORIES[family];
}

/**
 * Whether a POI is shown under the given family filter.
 *
 * 'all' takes an unknown category too, matching `visiblePois`: no chip could
 * ever reach it, so filtering it out would make it unreachable rather than
 * merely unfiltered.
 */
export function matchesPoiFamily(category: string, family: WaypointFamily): boolean {
  if (family === 'all') return true;
  return (poiCategoriesForFamily(family) as readonly string[]).includes(category);
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
