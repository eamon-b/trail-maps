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
 * - Anything else (web, an unknown platform): the Google Maps web link.
 *
 * The caller opens it through `openUrlWithFallback`, with `googleMapsUrl` as
 * the fallback — a device with nothing to handle `geo:`/`maps:` is unusual but
 * real, and the web link still opens the Google Maps app where it is installed.
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
  return googleMapsUrl(lat, lon);
}

/**
 * Google Maps' cross-platform search link, pinned at the coordinates.
 *
 * The query is the coordinates alone, not the name: a name turns it into a
 * place search, which can land on a different place that shares the name.
 * Android and iOS hand this URL to the Google Maps app when it is installed
 * and to the browser otherwise.
 */
export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
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

/**
 * Open `primary`, and `fallback` if that is refused; resolves to whether
 * either opened, and never rejects (every caller is an `onPress`).
 *
 * Deliberately not gated on `Linking.canOpenURL`: on Android 11+ that answers
 * `false` for `geo:` unless the manifest declares a matching `<queries>`
 * intent (package visibility), and on iOS for `maps:` unless the scheme is in
 * `LSApplicationQueriesSchemes` — so the check sent every hiker to the web map
 * even with a maps app installed. Opening directly needs neither declaration;
 * a device with nothing to handle the URL rejects, and that is the fallback's
 * cue.
 */
export async function openUrlWithFallback(
  open: (url: string) => Promise<unknown>,
  primary: string,
  fallback?: string,
): Promise<boolean> {
  try {
    await open(primary);
    return true;
  } catch {
    if (fallback == null || fallback === primary) return false;
  }
  try {
    await open(fallback);
    return true;
  } catch {
    return false;
  }
}
