/**
 * Map a bundled waypoint `type` string to one of the theme's waypoint color
 * tokens. The old app kept literal hex per type; the new app routes marker
 * colors through `useTheme().colors` so they adapt to dark mode, so types are
 * grouped into the six semantic categories the theme exposes.
 *
 * Pure + React-free so the grouping is unit-testable; the component resolves
 * `colors[categoryToken(type)]` at render time.
 */

import type { ThemeColors } from '../../tokens';

/** Theme token keys that carry a waypoint category color. */
export type WaypointColorToken =
  | 'waypointWater'
  | 'waypointCamp'
  | 'waypointTown'
  | 'waypointShelter'
  | 'waypointJunction'
  | 'waypointHazard';

const TYPE_TO_TOKEN: Record<string, WaypointColorToken> = {
  // Water
  water: 'waypointWater',
  'water-tank': 'waypointWater',
  spring: 'waypointWater',
  creek: 'waypointWater',
  // Camp
  campsite: 'waypointCamp',
  camp: 'waypointCamp',
  campground: 'waypointCamp',
  // Town / resupply
  town: 'waypointTown',
  food: 'waypointTown',
  resupply: 'waypointTown',
  // Shelter / accommodation
  shelter: 'waypointShelter',
  hut: 'waypointShelter',
  accommodation: 'waypointShelter',
  'caravan-park': 'waypointShelter',
  // Hazard
  hazard: 'waypointHazard',
  danger: 'waypointHazard',
  // Everything else (junctions, crossings, POIs, lookouts…) reads as neutral.
  junction: 'waypointJunction',
  road: 'waypointJunction',
  'road-crossing': 'waypointJunction',
  'inlet-crossing': 'waypointJunction',
  bridge: 'waypointJunction',
  trailhead: 'waypointJunction',
  endpoint: 'waypointJunction',
  poi: 'waypointJunction',
  lookout: 'waypointJunction',
  information: 'waypointJunction',
};

/** The theme color token for a waypoint type (neutral fallback for unknowns). */
export function categoryToken(type: string): WaypointColorToken {
  return TYPE_TO_TOKEN[type] ?? 'waypointJunction';
}

/** Resolve a waypoint type to its themed marker color. */
export function waypointColor(type: string, colors: ThemeColors): string {
  return colors[categoryToken(type)];
}

/**
 * OSM POI categories share the waypoint palette rather than adding tokens of
 * their own: what marks a POI as uncurated is its treatment (smaller, tinted
 * fill, thin ring, "OSM" badge), not a colour nobody could learn. Resupply and
 * food both read as "town business"; transport falls in with the neutral
 * junction colour.
 */
const POI_CATEGORY_TO_TOKEN: Record<string, WaypointColorToken> = {
  water: 'waypointWater',
  camping: 'waypointCamp',
  resupply: 'waypointTown',
  restaurant: 'waypointTown',
  transport: 'waypointJunction',
  emergency: 'waypointHazard',
};

/** The theme color token for a POI category (neutral fallback for unknowns). */
export function poiColorToken(category: string): WaypointColorToken {
  return POI_CATEGORY_TO_TOKEN[category] ?? 'waypointJunction';
}

/** Resolve a POI category to its themed marker color. */
export function poiColor(category: string, colors: ThemeColors): string {
  return colors[poiColorToken(category)];
}
