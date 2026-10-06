/**
 * The glyph each waypoint type is drawn with, on the trail page and the plan
 * page alike. One table, so a type added for one page cannot be missing from
 * the other. (OSM POIs have a deliberately different set: `trail-pois-ui.ts`.)
 */

import { baseWaypointType } from '@lib/waypoint-taxonomy';

export const WAYPOINT_ICONS: Readonly<Record<string, string>> = {
  town: '\u{1F3D8}\u{FE0F}',
  hut: '\u{1F6D6}',
  campsite: '⛺',
  water: '\u{1F4A7}',
  'water-tank': '\u{1F6B0}',
  mountain: '⛰\u{FE0F}',
  'side-trip': '\u{1F97E}',
  accommodation: '\u{1F3E8}',
  'caravan-park': '\u{1F3D5}\u{FE0F}',
  trailhead: '\u{1F697}',
  food: '\u{1F374}',
  'road-crossing': '\u{1F6E3}\u{FE0F}',
  'inlet-crossing': '\u{1F30A}',
  beach: '\u{1F3D6}\u{FE0F}',
  poi: '\u{2B50}',
  resupply: '\u{1F4E6}',
  endpoint: '\u{1F6A9}',
  // Branch/rejoin points where an alternate leaves or meets the main line.
  junction: '\u{1F500}',
  // A distance marker placed along the route (the CDT's every-10-mile posts).
  milestone: '\u{1FAA7}',
  // Vocabulary from curated third-party data (the CDT build): kept here rather
  // than left to fall through to the generic pin, so each reads distinctly.
  gap: '\u{1F6A7}',
  'ley-note': '\u{1F5D2}\u{FE0F}',
  'ley-waypoint': '\u{1F53A}',
  'camp-2018': '\u{1F525}',
  waypoint: '\u{1F4CD}',
};

/** The glyph for a type; a turn-off shows its served type's (`hut-access` → the hut). */
export function waypointIcon(type?: string): string {
  return WAYPOINT_ICONS[type || 'waypoint'] ?? WAYPOINT_ICONS[baseWaypointType(type)] ?? WAYPOINT_ICONS.waypoint;
}
