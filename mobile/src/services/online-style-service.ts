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

// Font available in Liberty style
const LIBERTY_FONT = 'Noto Sans Regular';

/**
 * Contour layers styled for visibility on the Liberty basemap.
 * Opacity and width are tuned upward compared to the offline topo style
 * because Liberty's background is busier.
 */
function getContourLayers(): object[] {
  return [
    {
      id: 'contour-regular',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      minzoom: 13,
      filter: ['!=', ['to-number', ['get', 'is_index']], 1],
      paint: {
        'line-color': 'rgb(179, 134, 89)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 14, 0.7, 15, 1.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.25, 14, 0.4, 15, 0.55],
      },
    },
    {
      id: 'contour-index',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      minzoom: 11,
      filter: [
        'all',
        ['==', ['to-number', ['get', 'is_index']], 1],
        ['!=', ['%', ['to-number', ['get', 'elevation']], 200], 0],
      ],
      paint: {
        'line-color': 'rgb(166, 116, 66)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 12, 0.9, 14, 2.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.25, 12, 0.4, 14, 0.7],
      },
    },
    {
      id: 'contour-major-index',
      type: 'line',
      source: 'contour',
      'source-layer': 'contour',
      minzoom: 9,
      filter: ['==', ['%', ['to-number', ['get', 'elevation']], 200], 0],
      paint: {
        'line-color': 'rgb(150, 100, 50)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 11, 1.2, 13, 1.6, 15, 2.4],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.25, 11, 0.45, 13, 0.6, 15, 0.75],
      },
    },
    {
      id: 'contour-label',
      type: 'symbol',
      source: 'contour',
      'source-layer': 'contour',
      minzoom: 12,
      filter: ['==', ['to-number', ['get', 'is_index']], 1],
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

  const style = await fetchLibertyStyle();

  // Clone sources and layers so we don't mutate the cached style object
  const sources = { ...(style.sources as Record<string, unknown>) };
  sources.contour = {
    type: 'vector',
    tiles: [`${contourTileUrl}/contours/{z}/{x}/{y}.pbf`],
    minzoom: 9,
    maxzoom: 15,
  };

  // Inject contour layers at the right position
  const layers = [...(style.layers as { id: string }[])];
  const insertIndex = findContourInsertIndex(layers);
  const contourLayers = getContourLayers();
  layers.splice(insertIndex, 0, ...(contourLayers as { id: string }[]));

  return { ...style, sources, layers };
}

/**
 * Clear the cached style (useful for testing or force-refresh).
 */
export function clearStyleCache(): void {
  cachedStyle = null;
  cacheTimestamp = 0;
}
