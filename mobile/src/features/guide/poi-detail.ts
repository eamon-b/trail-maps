/**
 * Pure, React-free helpers for the POI detail screen.
 *
 * The screen itself is a thin render over `@lib/poi-display`; the one piece of
 * logic worth testing without a renderer is the "Open in Maps" hand-off, which
 * is platform-shaped and involves URL building — the place a stray unescaped
 * `&` or `)` in an OSM `name` would break a link (or, worse, smuggle extra
 * query parameters into the maps app). Everything user-supplied that reaches a
 * URL here goes through `encodeURIComponent`.
 *
 * Note what is deliberately NOT here: any function that turns an OSM tag into
 * a tappable link. `summarisePoiTags` in `@lib/poi-display` is the only thing
 * allowed to produce an `href`, because it is the only thing that scheme-checks
 * (`http:`/`https:`/`tel:` — an OSM `website` tag is free text and can hold
 * `javascript:`). The screen opens `line.href` and nothing else.
 */

import { summarisePoiTags, type PoiTagLine } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';

/**
 * A URL that opens the platform's maps app at a point, with a label.
 *
 * - Android: the `geo:` scheme. The bare coordinate positions the map; the
 *   `q=lat,lon(label)` form is what makes a *pin* appear with a name on it
 *   (a `geo:` URI without `q` drops the marker entirely on Google Maps).
 * - iOS: `maps:` opens Apple Maps; `ll` positions it and `q` names the pin.
 * - Anything else (web, an unknown platform): fall back to OpenStreetMap's own
 *   map view, which needs no app at all.
 *
 * The caller is expected to `Linking.canOpenURL` the result and fall back to
 * the OSM URL — a device with no maps app installed is unusual but real.
 */
export function mapsUrlFor(
  lat: number,
  lon: number,
  label: string,
  platform: 'ios' | 'android' | string,
): string {
  const coords = `${lat},${lon}`;
  const q = encodeURIComponent(label);
  if (platform === 'android') return `geo:${coords}?q=${coords}(${q})`;
  if (platform === 'ios') return `maps:?ll=${coords}&q=${q}`;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
}

/**
 * The tag lines the detail screen lists, in display order.
 *
 * A one-line wrapper over the shared summariser so the screen has a single
 * import for "what do I render", and so a future screen-only line (nothing
 * needs one yet) has an obvious home that is still unit-testable.
 */
export function poiDetailLines(poi: Pick<TrailPOI, 'tags'>): PoiTagLine[] {
  return summarisePoiTags(poi.tags);
}
