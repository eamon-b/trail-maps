/**
 * Online Style Service
 *
 * Fetches an OpenFreeMap basemap style and injects contour tile layers so users
 * see terrain contours on online maps without downloading offline tiles.
 *
 * One base style for both app themes: OpenFreeMap's Liberty (cream,
 * topographic-ish). The dark theme is Liberty repainted by `applyNightPalette`
 * (services/night-style) rather than a second, separately designed style — the
 * night map keeps every layer the day map has (forest, parks, relief, paths),
 * because those are what a hiker reads the map for. It replaced OpenFreeMap's
 * Dark-Matter `dark` style, which dropped all of them and read as a black
 * rectangle with a red line on it.
 */

import type { MapTheme } from '../features/map/map-style';
import { applyNightPalette } from './night-style';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

function getContourTileUrl(): string | undefined {
  return process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;
}

// Cache the fetched base style for 24h. It is the light document as served; the
// night palette is applied to a clone on every call (see prepareBaseStyle).
let cachedStyle: { style: object; fetchedAt: number } | undefined;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONTOUR_HEALTH_TIMEOUT_MS = 2500;

/**
 * The contour worker's tilesets, by `{source}` path segment
 * (workers/contour-tiles SOURCES). `contours` is the SRTM Australia archive the
 * app has always drawn; `world` is the Copernicus GLO-30 build of everywhere
 * else. A tile request outside an archive's coverage comes back 204 (empty), so
 * a trail abroad on `contours` silently shows no contour lines at all.
 */
export type ContourSource = 'contours' | 'world';

/** [west, south, east, north], degrees. */
export type LonLatBounds = [number, number, number, number];

/** Coverage of contours/australia.pmtiles, as its /health header reports it. */
const AUSTRALIA_CONTOUR_BOUNDS: LonLatBounds = [112.921306, -43.8586, 154, -10];

/**
 * Which tileset to draw a trail's contours from. A trail wholly inside the
 * Australia archive keeps it (unchanged for every Australian guide); anything
 * else — Shikoku, Te Araroa, the CDT — reads the world archive. Without trail
 * bounds the Australia archive stays the default.
 */
export function contourSourceFor(bounds: LonLatBounds | null | undefined): ContourSource {
  if (!bounds) return 'contours';
  const [west, south, east, north] = bounds;
  const [aw, as, ae, an] = AUSTRALIA_CONTOUR_BOUNDS;
  return west >= aw && south >= as && east <= ae && north <= an ? 'contours' : 'world';
}

// Font served by the OpenFreeMap style
const OFM_FONT = 'Noto Sans Regular';

/**
 * Warm tan contour ink, per theme.
 *
 * The hue is the same brown in both — a contour line should look like a contour
 * line — but on the night basemap it lifts in value and opacity, because brown
 * on a dark ground has none of the contrast brown on cream gets for free. These
 * match the offline dark palette (assets/topo-style-dark.json) so the two base
 * maps agree about what a 200 m index line looks like.
 */
const CONTOUR_INK: Record<MapTheme, {
  regular: string;
  index: string;
  major: string;
  label: string;
  labelHalo: string;
  /** Multiplier on every line-opacity stop below. */
  opacityScale: number;
}> = {
  light: {
    regular: 'rgb(179, 134, 89)',
    index: 'rgb(166, 116, 66)',
    major: 'rgb(150, 100, 50)',
    label: 'rgb(131, 66, 37)',
    labelHalo: 'rgba(255, 255, 255, 0.85)',
    opacityScale: 1,
  },
  dark: {
    regular: 'rgb(150, 121, 92)',
    index: 'rgb(178, 143, 105)',
    major: 'rgb(205, 167, 124)',
    label: 'rgb(214, 180, 142)',
    labelHalo: 'rgba(0, 0, 0, 0.8)',
    opacityScale: 1.35,
  },
};

/**
 * Scale the opacity stops of an `interpolate` expression, clamped to 1.
 * Lets the dark theme reuse the light theme's zoom ramp (the shape of which is
 * tuned to the contour data tiers) instead of restating it at other values.
 */
function scaleOpacity(expression: unknown[], scale: number): unknown[] {
  if (scale === 1) return expression;
  // ['interpolate', ['linear'], ['zoom'], z0, o0, z1, o1, ...] — stops start at
  // index 3 and alternate zoom, opacity, so only the odd offsets are opacities.
  return expression.map((part, i) =>
    i >= 4 && (i - 3) % 2 === 1 && typeof part === 'number'
      ? Math.round(Math.min(1, part * scale) * 100) / 100
      : part,
  );
}

/**
 * Contour layers styled for visibility on the online basemap.
 * Opacity and width are tuned upward compared to the offline topo style
 * because the online basemaps have busier backgrounds.
 *
 * Zooms and filters MUST stay identical to the offline template in
 * scripts/topo-style.json (only widths/opacities differ) and MUST stay aligned
 * with the contour data tiers emitted by classifyAndTileContours() in
 * scripts/tile-pipeline.ts:
 *   z9+  elevation % 100 == 0            (100 m + 200 m lines)
 *   z10+ % 50 == 0 and % 100 != 0        (adds 50 m lines)
 *   z12+ % 20 == 0 and % 50 != 0         (adds 20 m lines)
 *   z13+ everything else                 (adds 10 m lines)
 * A layer's minzoom must be the first zoom at which its filter can match, or
 * the tiles carry bytes that are decoded and never drawn.
 *
 * elevation > 0 is required on every layer: sea-level (0 m) coastlines satisfy
 * both % 200 == 0 and is_index == 1, so without it they render as the heaviest
 * line on coastal trails, and sub-zero DEM values draw offshore bathymetry.
 */
function getContourLayers(theme: MapTheme): object[] {
  const ink = CONTOUR_INK[theme];
  return [
    {
      id: 'contour-regular',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      // 20 m lines arrive at z12; 10 m lines join at z13.
      minzoom: 12,
      filter: [
        'all',
        ['!=', ['to-number', ['get', 'is_index']], 1],
        ['>', ['to-number', ['get', 'elevation']], 0],
      ],
      paint: {
        'line-color': ink.regular,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 13, 0.4, 14, 0.7, 15, 1.0],
        'line-opacity': scaleOpacity(
          ['interpolate', ['linear'], ['zoom'], 12, 0.18, 13, 0.25, 14, 0.4, 15, 0.55],
          ink.opacityScale,
        ),
      },
    },
    {
      id: 'contour-index',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      // Odd hundreds (100, 300, ...) are index lines that ship in the z9 tier;
      // the 50 m index lines join at z10.
      minzoom: 9,
      filter: [
        'all',
        ['==', ['to-number', ['get', 'is_index']], 1],
        ['!=', ['%', ['to-number', ['get', 'elevation']], 200], 0],
        ['>', ['to-number', ['get', 'elevation']], 0],
      ],
      paint: {
        'line-color': ink.index,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 11, 0.7, 12, 1.1, 14, 2.0],
        'line-opacity': scaleOpacity(
          ['interpolate', ['linear'], ['zoom'], 9, 0.25, 11, 0.35, 12, 0.5, 14, 0.7],
          ink.opacityScale,
        ),
      },
    },
    {
      id: 'contour-major-index',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      // 200 m lines are a subset of the z9 (% 100 == 0) tier.
      minzoom: 9,
      filter: [
        'all',
        ['==', ['%', ['to-number', ['get', 'elevation']], 200], 0],
        ['>', ['to-number', ['get', 'elevation']], 0],
      ],
      paint: {
        'line-color': ink.major,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.9, 11, 1.5, 13, 1.8, 15, 2.4],
        'line-opacity': scaleOpacity(
          ['interpolate', ['linear'], ['zoom'], 9, 0.4, 11, 0.6, 13, 0.7, 15, 0.8],
          ink.opacityScale,
        ),
      },
    },
    {
      id: 'contour-label',
      type: 'symbol',
      source: 'contour',
      'source-layer': 'contour',
      // Index-line data exists from z9, but labels are deliberately held back
      // to z12 for legibility — labelling every 100 m line at z9/z10 is unreadable.
      minzoom: 12,
      filter: [
        'all',
        ['==', ['to-number', ['get', 'is_index']], 1],
        ['>', ['to-number', ['get', 'elevation']], 0],
      ],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['concat', ['to-string', ['get', 'elevation']], 'm'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 12],
        'text-max-angle': 25,
        'text-padding': 100,
        'text-font': [OFM_FONT],
      },
      paint: {
        'text-color': ink.label,
        'text-halo-color': ink.labelHalo,
        'text-halo-width': 2,
      },
    },
  ];
}

/**
 * Find the insertion index for contour layers in a base style.
 * Contours belong above water/landcover but below roads and every label, so
 * they never bury a road line or strike through a place name.
 *
 * The first road-like layer is the anchor in Liberty, where labels come last.
 * A symbol layer ends the search too, so a base style that orders a label
 * layer ahead of its roads never has contour lines drawn through its names.
 */
function findContourInsertIndex(layers: { id: string; type?: string }[]): number {
  for (let i = 0; i < layers.length; i++) {
    const { id, type } = layers[i];
    if (type === 'symbol') return i;
    if (id.includes('road') || id.includes('highway') || id.includes('bridge') || id.includes('tunnel')) {
      return i;
    }
  }
  // Fallback: insert before the last quarter of layers (likely labels)
  return Math.floor(layers.length * 0.75);
}

/**
 * Fetch the base style JSON from OpenFreeMap.
 * Returns the cached version if available and fresh.
 */
async function fetchBaseStyle(): Promise<Record<string, unknown>> {
  if (cachedStyle && Date.now() - cachedStyle.fetchedAt < CACHE_TTL_MS) {
    return cachedStyle.style as Record<string, unknown>;
  }

  const response = await fetch(STYLE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch base style: ${response.status}`);
  }

  const style = await response.json();
  cachedStyle = { style, fetchedAt: Date.now() };
  return style as Record<string, unknown>;
}

function cloneStyle(style: Record<string, unknown>): Record<string, unknown> {
  return {
    ...style,
    sources: { ...(style.sources as Record<string, unknown>) },
    layers: [...(style.layers as object[])],
  };
}

/**
 * Contours are an optional enhancement. Check the archive before adding its
 * source so a missing/corrupt R2 object cannot make MapLibre repeatedly request
 * failing tiles while the user pans.
 */
async function isContourServiceHealthy(
  contourTileUrl: string,
  source: ContourSource,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTOUR_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(`${contourTileUrl.replace(/\/$/, '')}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    // The top-level `ok` (and the 200/503 status) describes the default
    // (`contours`) archive only; each source's own health is under `sources`.
    // So a 503 still carries a usable body: the Australia archive being down
    // must not take the world contours off a trail abroad.
    const readable = response.ok || (source !== 'contours' && response.status === 503);
    if (!readable) return false;

    const body = await response.json() as {
      ok?: boolean;
      sources?: Partial<Record<ContourSource, { ok?: boolean }>>;
    };
    if (source === 'contours') return body.ok === true;
    return body.sources?.[source]?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Add the contour source and layers to an already-prepared style. Takes
 * ownership of `style` — it must be a clone from prepareBaseStyle, never the
 * cached document, or the injection would accumulate on every call.
 */
function injectContours(
  style: Record<string, unknown>,
  contourTileUrl: string,
  theme: MapTheme,
  source: ContourSource,
): Record<string, unknown> {
  const cloned = style;
  const sources = cloned.sources as Record<string, unknown>;
  sources.contour = {
    type: 'vector',
    tiles: [`${contourTileUrl.replace(/\/$/, '')}/${source}/{z}/{x}/{y}.pbf`],
    minzoom: 9,
    maxzoom: 15,
  };

  const layers = cloned.layers as { id: string }[];
  const insertIndex = findContourInsertIndex(layers);
  layers.splice(insertIndex, 0, ...(getContourLayers(theme) as { id: string }[]));
  return cloned;
}

/**
 * The base style for a theme, cloned and made ready to mount: the dark one is
 * repainted with the night palette (see services/night-style). Every path that
 * returns a style to the map goes through here, so the repaint cannot be missed
 * by the no-contours or unhealthy-archive branches. Contours are injected after
 * this, in their own per-theme ink, so the palette never touches them.
 */
function prepareBaseStyle(style: Record<string, unknown>, theme: MapTheme): Record<string, unknown> {
  const cloned = cloneStyle(style);
  if (theme === 'dark') applyNightPalette(cloned as { layers: { id: string }[] });
  return cloned;
}

/**
 * Resolve the complete online style in JavaScript before mounting MapLibre.
 * Passing a URL first and replacing it with a style object later forces a
 * native style reload while the map is live, which can terminate the native
 * renderer on some devices. This function also returns the plain base style
 * when contours are not configured.
 *
 * `theme` picks the palette (Liberty as served when light, the night repaint of
 * it when dark) and the ink the contour layers are drawn in. `source` picks the
 * contour tileset — see contourSourceFor.
 */
export async function getOnlineMapStyle(
  theme: MapTheme = 'light',
  source: ContourSource = 'contours',
): Promise<object> {
  const contourTileUrl = getContourTileUrl();
  if (!contourTileUrl) {
    console.warn(
      'Contours disabled: EXPO_PUBLIC_CONTOUR_TILE_URL is not set. ' +
        'Set it in mobile/.env.local (see CLAUDE.md "Mobile Environment Variables") and restart Metro.',
    );
  }

  const [style, contoursHealthy] = await Promise.all([
    fetchBaseStyle(),
    contourTileUrl ? isContourServiceHealthy(contourTileUrl, source) : Promise.resolve(false),
  ]);

  if (contourTileUrl && !contoursHealthy) {
    console.warn(`Contours disabled: health check failed for ${contourTileUrl} (${source})`);
  }

  const base = prepareBaseStyle(style, theme);
  return contourTileUrl && contoursHealthy
    ? injectContours(base, contourTileUrl, theme, source)
    : base;
}

/**
 * Get a theme's base style with the contour tile source and layers injected.
 * Returns a complete MapLibre style object ready for use.
 *
 * Returns null if the contour tile URL is not configured.
 */
export async function getOnlineStyleWithContours(
  theme: MapTheme = 'light',
  source: ContourSource = 'contours',
): Promise<object | null> {
  const contourTileUrl = getContourTileUrl();
  if (!contourTileUrl) {
    return null;
  }

  const base = prepareBaseStyle(await fetchBaseStyle(), theme);
  return injectContours(base, contourTileUrl, theme, source);
}

/**
 * Clear the cached base style (useful for testing or force-refresh).
 */
export function clearStyleCache(): void {
  cachedStyle = undefined;
}
