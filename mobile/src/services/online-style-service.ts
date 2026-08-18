/**
 * Online Style Service
 *
 * Fetches the Liberty basemap style and injects contour tile layers
 * so users see terrain contours on online maps without downloading
 * offline tiles.
 */

const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

function getContourTileUrl(): string | undefined {
  return process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;
}

// Cache the style for 24h
let cachedStyle: object | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONTOUR_HEALTH_TIMEOUT_MS = 2500;

// Font available in Liberty style
const LIBERTY_FONT = 'Noto Sans Regular';

/**
 * Contour layers styled for visibility on the Liberty basemap.
 * Opacity and width are tuned upward compared to the offline topo style
 * because Liberty's background is busier.
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
function getContourLayers(): object[] {
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
        'line-color': 'rgb(179, 134, 89)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 13, 0.4, 14, 0.7, 15, 1.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.18, 13, 0.25, 14, 0.4, 15, 0.55],
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
        'line-color': 'rgb(166, 116, 66)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 11, 0.7, 12, 1.1, 14, 2.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.25, 11, 0.35, 12, 0.5, 14, 0.7],
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
        'line-color': 'rgb(150, 100, 50)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.9, 11, 1.5, 13, 1.8, 15, 2.4],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 11, 0.6, 13, 0.7, 15, 0.8],
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
        'text-font': [LIBERTY_FONT],
      },
      paint: {
        'text-color': 'rgb(131, 66, 37)',
        'text-halo-color': 'rgba(255, 255, 255, 0.85)',
        'text-halo-width': 2,
      },
    },
  ];
}

/**
 * Find the insertion index for contour layers in the Liberty style.
 * Contours should appear after water/landcover but before roads,
 * so they don't obscure road labels.
 */
function findContourInsertIndex(layers: { id: string }[]): number {
  // Look for first road-like layer
  for (let i = 0; i < layers.length; i++) {
    const id = layers[i].id;
    if (id.includes('road') || id.includes('highway') || id.includes('bridge') || id.includes('tunnel')) {
      return i;
    }
  }
  // Fallback: insert before the last quarter of layers (likely labels)
  return Math.floor(layers.length * 0.75);
}

/**
 * Fetch the Liberty style JSON from OpenFreeMap.
 * Returns cached version if available and fresh.
 */
async function fetchLibertyStyle(): Promise<Record<string, unknown>> {
  if (cachedStyle && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStyle as Record<string, unknown>;
  }

  const response = await fetch(LIBERTY_STYLE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Liberty style: ${response.status}`);
  }

  const style = await response.json();
  cachedStyle = style;
  cacheTimestamp = Date.now();
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
async function isContourServiceHealthy(contourTileUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTOUR_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(`${contourTileUrl.replace(/\/$/, '')}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;

    const body = await response.json() as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function injectContours(
  style: Record<string, unknown>,
  contourTileUrl: string,
): Record<string, unknown> {
  const cloned = cloneStyle(style);
  const sources = cloned.sources as Record<string, unknown>;
  sources.contour = {
    type: 'vector',
    tiles: [`${contourTileUrl.replace(/\/$/, '')}/contours/{z}/{x}/{y}.pbf`],
    minzoom: 9,
    maxzoom: 15,
  };

  const layers = cloned.layers as { id: string }[];
  const insertIndex = findContourInsertIndex(layers);
  layers.splice(insertIndex, 0, ...(getContourLayers() as { id: string }[]));
  return cloned;
}

/**
 * Resolve the complete online style in JavaScript before mounting MapLibre.
 * Passing a URL first and replacing it with a style object later forces a
 * native style reload while the map is live, which can terminate the native
 * renderer on some devices. This function also returns the plain Liberty
 * style when contours are not configured.
 */
export async function getOnlineMapStyle(): Promise<object> {
  const contourTileUrl = getContourTileUrl();
  if (!contourTileUrl) {
    console.warn(
      'Contours disabled: EXPO_PUBLIC_CONTOUR_TILE_URL is not set. ' +
        'Set it in mobile/.env.local (see CLAUDE.md "Mobile Environment Variables") and restart Metro.',
    );
  }

  const [style, contoursHealthy] = await Promise.all([
    fetchLibertyStyle(),
    contourTileUrl ? isContourServiceHealthy(contourTileUrl) : Promise.resolve(false),
  ]);

  if (contourTileUrl && !contoursHealthy) {
    console.warn(`Contours disabled: health check failed for ${contourTileUrl}`);
  }

  return contourTileUrl && contoursHealthy
    ? injectContours(style, contourTileUrl)
    : cloneStyle(style);
}

/**
 * Get the Liberty style with contour tile source and layers injected.
 * Returns a complete MapLibre style object ready for use.
 *
 * Returns null if the contour tile URL is not configured.
 */
export async function getOnlineStyleWithContours(): Promise<object | null> {
  const contourTileUrl = getContourTileUrl();
  if (!contourTileUrl) {
    return null;
  }

  return injectContours(await fetchLibertyStyle(), contourTileUrl);
}

/**
 * Clear the cached style (useful for testing or force-refresh).
 */
export function clearStyleCache(): void {
  cachedStyle = null;
  cacheTimestamp = 0;
}
