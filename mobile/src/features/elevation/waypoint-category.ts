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
import { baseWaypointType } from '@lib/waypoint-taxonomy';

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
  // A turn-off is coloured as the place it serves. This is a *colour* rule, not
  // a semantic one — see `overnightWaypoints`, which has to exclude turn-offs
  // explicitly because you cannot sleep at a roadside.
  return TYPE_TO_TOKEN[type] ?? TYPE_TO_TOKEN[baseWaypointType(type)] ?? 'waypointJunction';
}

/** Resolve a waypoint type to its themed marker color. */
export function waypointColor(type: string, colors: ThemeColors): string {
  return colors[categoryToken(type)];
}
