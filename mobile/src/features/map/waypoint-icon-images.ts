/**
 * MapLibre image registry for the waypoint marker glyphs.
 *
 * Kept apart from `waypoint-icons.ts` so the type → glyph mapping stays a pure
 * module: this one is a table of bundled asset requires, which is what
 * `<Images>` hands to the native style. Static `require` calls (not a computed
 * path) are required — Metro resolves bundled assets at build time.
 *
 * Because the images are bundled assets, they resolve with no network access,
 * which is what keeps per-type iconography working on an offline map.
 */

import type { ImageRequireSource } from 'react-native';
import type { WaypointIconName } from './waypoint-icons';

/**
 * Every glyph in WAYPOINT_ICON_NAMES, keyed by the same name a feature's `icon`
 * property carries — so `iconImage: ['get', 'icon']` resolves directly.
 *
 * Typed as `ImageRequireSource` (the opaque asset id Metro's `require` returns)
 * rather than the wider `ImageSourcePropType`: MapLibre RN 11's `<Images>`
 * accepts a require, a native asset name, or `{ source, sdf }` — but not the
 * `{ uri }` object that `ImageSourcePropType` also admits.
 */
export const WAYPOINT_ICON_IMAGES: Record<WaypointIconName, ImageRequireSource> = {
  water: require('../../../assets/map-icons/water.png'),
  'water-tank': require('../../../assets/map-icons/water-tank.png'),
  campsite: require('../../../assets/map-icons/campsite.png'),
  hut: require('../../../assets/map-icons/hut.png'),
  bed: require('../../../assets/map-icons/bed.png'),
  town: require('../../../assets/map-icons/town.png'),
  resupply: require('../../../assets/map-icons/resupply.png'),
  trailhead: require('../../../assets/map-icons/trailhead.png'),
  endpoint: require('../../../assets/map-icons/endpoint.png'),
  junction: require('../../../assets/map-icons/junction.png'),
  road: require('../../../assets/map-icons/road.png'),
  ford: require('../../../assets/map-icons/ford.png'),
  summit: require('../../../assets/map-icons/summit.png'),
  hazard: require('../../../assets/map-icons/hazard.png'),
  info: require('../../../assets/map-icons/info.png'),
  beach: require('../../../assets/map-icons/beach.png'),
  poi: require('../../../assets/map-icons/poi.png'),
};
