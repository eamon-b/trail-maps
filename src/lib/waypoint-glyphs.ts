/**
 * Waypoint type / OSM POI category → map glyph → colour family.
 *
 * The one table both platforms draw from: the phone's map markers, list rows,
 * elevation ticks and filter chips, and the web's map markers, datasheet and
 * Stops tab. The colour family is derived from the glyph, never listed per
 * type, so a type cannot get the water drop with a grey ring (or a hut glyph
 * with the town colour) — the drift two separate tables used to allow.
 *
 * The glyph shapes themselves are `map-glyphs.ts`.
 */

import { MAP_GLYPHS, type MapGlyphName } from './map-glyphs';
import { baseWaypointType } from './waypoint-taxonomy';

/**
 * The six colour families a marker ring can carry. `neutral` is the
 * navigation/everything-else grey; each platform resolves a family to its own
 * themed colour (mobile `waypoint*` tokens, web `--wp-*` custom properties).
 */
export type GlyphFamily = 'water' | 'camp' | 'town' | 'shelter' | 'hazard' | 'neutral';

/** Glyph for any type not listed below (and for `poi` itself). */
export const FALLBACK_GLYPH: MapGlyphName = 'poi';

/**
 * `type` strings → glyph. Covers every type the bundled trails use plus the
 * waypoint classifier's vocabulary and the aliases real-world GPX carries,
 * grouped onto the nearest glyph so a data update never falls all the way
 * through to the generic dot.
 */
const TYPE_TO_GLYPH: Record<string, MapGlyphName> = {
  // Water sources
  water: 'water',
  spring: 'water',
  creek: 'water',
  stream: 'water',
  river: 'water',
  tap: 'water',
  'water-tank': 'water-tank',
  tank: 'water-tank',
  rainwater: 'water-tank',

  // Camping
  campsite: 'campsite',
  camp: 'campsite',
  campground: 'campsite',
  camping: 'campsite',

  // Roofed shelter
  hut: 'hut',
  shelter: 'hut',

  // Beds you pay for
  accommodation: 'bed',
  'caravan-park': 'bed',
  hostel: 'bed',
  hotel: 'bed',
  motel: 'bed',

  // A lodge on a teahouse trek: bed, meals and water in one (its own glyph,
  // because it is resupply and water as well as a bed).
  teahouse: 'teahouse',
  'tea-house': 'teahouse',

  // Towns and supplies
  town: 'town',
  resupply: 'resupply',
  food: 'resupply',
  store: 'resupply',
  shop: 'resupply',
  supermarket: 'resupply',
  'post-office': 'resupply',

  // Meals out (shared with the `restaurant` POI category)
  restaurant: 'restaurant',
  cafe: 'restaurant',
  pub: 'restaurant',

  // Trail ends
  trailhead: 'trailhead',
  endpoint: 'endpoint',
  terminus: 'endpoint',
  start: 'endpoint',
  finish: 'endpoint',

  // Navigation features
  junction: 'junction', // the CDT's alternate branch/rejoin points
  'side-trip': 'junction',
  fork: 'junction',
  gate: 'junction',
  stile: 'junction',
  milestone: 'milestone', // the CDT's every-10-mile markers
  milepost: 'milestone',
  marker: 'milestone',
  road: 'road',
  'road-crossing': 'road',
  highway: 'road',
  parking: 'road',
  'car-park': 'road',

  // Public transport (shared with the `transport` POI category)
  'bus-stop': 'transport',
  station: 'transport',
  ferry: 'transport',

  // Wet crossings
  'inlet-crossing': 'ford',
  ford: 'ford',
  'river-crossing': 'ford',
  'creek-crossing': 'ford',
  bridge: 'ford',

  // Views
  lookout: 'summit',
  summit: 'summit',
  peak: 'summit',
  mountain: 'summit',
  viewpoint: 'summit',
  view: 'summit',

  // Warnings, help and notices
  hazard: 'hazard',
  danger: 'hazard',
  warning: 'hazard',
  emergency: 'emergency',
  hospital: 'emergency',
  'first-aid': 'emergency',
  information: 'info',
  info: 'info',
  sign: 'info',

  // Coast
  beach: 'beach',

  // Curated third-party vocabulary (the CDT build's Ley map-set and 2018-walk
  // files). `camp-2018` shares the campsite glyph, because that is what it is.
  gap: 'gap',
  'ley-note': 'note',
  'ley-waypoint': 'info',
  'camp-2018': 'campsite',

  // Generic
  poi: 'poi',
  waypoint: 'poi',
  other: 'poi',
};

/**
 * A table's own entry for `key`. Types come from user GPX, so a plain index
 * would hand `<type>constructor</type>` the prototype's function.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The glyph for a waypoint type (generic point-of-interest for unknowns). */
export function waypointGlyph(type: string | undefined): MapGlyphName {
  // A turn-off shows the glyph of the place it serves: `hut-access` is the hut.
  return own(TYPE_TO_GLYPH, type ?? '') ?? own(TYPE_TO_GLYPH, baseWaypointType(type)) ?? FALLBACK_GLYPH;
}

/**
 * `TrailPOICategory` → glyph. Takes a plain `string` so a trail JSON carrying
 * a category this build does not know still gets a marker.
 */
const POI_CATEGORY_TO_GLYPH: Record<string, MapGlyphName> = {
  water: 'water',
  camping: 'campsite',
  resupply: 'resupply',
  restaurant: 'restaurant',
  transport: 'transport',
  emergency: 'emergency',
};

/** The glyph for an OpenStreetMap POI category. */
export function poiGlyph(category: string): MapGlyphName {
  return own(POI_CATEGORY_TO_GLYPH, category) ?? FALLBACK_GLYPH;
}

/** Glyph → colour family. Exhaustive, so a new glyph must pick one. */
const GLYPH_FAMILY: Readonly<Record<MapGlyphName, GlyphFamily>> = {
  water: 'water',
  'water-tank': 'water',
  campsite: 'camp',
  hut: 'shelter',
  bed: 'shelter',
  teahouse: 'shelter',
  town: 'town',
  resupply: 'town',
  restaurant: 'town',
  hazard: 'hazard',
  emergency: 'hazard',
  trailhead: 'neutral',
  endpoint: 'neutral',
  junction: 'neutral',
  milestone: 'neutral',
  gap: 'neutral',
  note: 'neutral',
  road: 'neutral',
  ford: 'neutral',
  summit: 'neutral',
  info: 'neutral',
  beach: 'neutral',
  transport: 'neutral',
  poi: 'neutral',
};

export function glyphFamily(glyph: MapGlyphName): GlyphFamily {
  return GLYPH_FAMILY[glyph];
}

/** The colour family of a waypoint type (a turn-off takes its served type's). */
export function waypointFamily(type: string | undefined): GlyphFamily {
  return GLYPH_FAMILY[waypointGlyph(type)];
}

/** The colour family of an OpenStreetMap POI category. */
export function poiFamily(category: string): GlyphFamily {
  return GLYPH_FAMILY[poiGlyph(category)];
}

/**
 * A glyph as inline SVG markup, sized by CSS (`1em` square by default) and
 * inked with `currentColor`. Decorative: the caller carries the accessible
 * name (a `title` on the wrapper, or the row's text).
 */
export function glyphSvg(glyph: MapGlyphName, className = 'map-glyph'): string {
  return (
    `<svg class="${className}" viewBox="0 0 96 96" aria-hidden="true" focusable="false">` + `${MAP_GLYPHS[glyph]}</svg>`
  );
}
