import {
  getOnlineMapStyle,
  getOnlineStyleWithContours,
  clearStyleCache,
} from '../online-style-service';

// ---------------------------------------------------------------------------
// Mock Liberty style — minimal but structurally representative
// ---------------------------------------------------------------------------

const MOCK_LIBERTY_STYLE = {
  version: 8,
  name: 'Liberty',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://example.com/tiles.json' },
  },
  layers: [
    { id: 'background', type: 'background', paint: {} },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: {} },
    { id: 'road_minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: {} },
    { id: 'road_major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: {} },
    { id: 'place_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: {} },
  ],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const CONTOUR_URL = 'https://contour-tiles.example.workers.dev';

beforeEach(() => {
  clearStyleCache();
  process.env.EXPO_PUBLIC_CONTOUR_TILE_URL = CONTOUR_URL;
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url === `${CONTOUR_URL}/health`) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(JSON.parse(JSON.stringify(MOCK_LIBERTY_STYLE))),
    });
  });
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getOnlineStyleWithContours', () => {
  it('returns null when EXPO_PUBLIC_CONTOUR_TILE_URL is not set', async () => {
    delete process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;
    const result = await getOnlineStyleWithContours();
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches Liberty style and injects contour source', async () => {
    const style = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    expect(style).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://tiles.openfreemap.org/styles/liberty',
    );

    const sources = style.sources as Record<string, unknown>;
    expect(sources.contour).toEqual({
      type: 'vector',
      tiles: [`${CONTOUR_URL}/contours/{z}/{x}/{y}.pbf`],
      minzoom: 9,
      maxzoom: 15,
    });
  });

  it('injects four contour layers before the first road layer', async () => {
    const style = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    const layers = style.layers as { id: string }[];
    const layerIds = layers.map((l) => l.id);

    // Should contain all four contour layers
    expect(layerIds).toContain('contour-regular');
    expect(layerIds).toContain('contour-index');
    expect(layerIds).toContain('contour-major-index');
    expect(layerIds).toContain('contour-label');

    // All contour layers should appear before road layers
    const firstContourIdx = layerIds.indexOf('contour-regular');
    const firstRoadIdx = layerIds.indexOf('road_minor');
    expect(firstContourIdx).toBeLessThan(firstRoadIdx);
  });

  it('returns valid MapLibre style structure', async () => {
    const style = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    expect(style.version).toBe(8);
    expect(style.sources).toBeDefined();
    expect(Array.isArray(style.layers)).toBe(true);
    expect((style.layers as unknown[]).length).toBeGreaterThan(0);
  });

  it('uses Noto Sans Regular for contour labels', async () => {
    const style = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    const layers = style.layers as { id: string; layout?: { 'text-font'?: string[] } }[];
    const labelLayer = layers.find((l) => l.id === 'contour-label');
    expect(labelLayer).toBeDefined();
    expect(labelLayer!.layout!['text-font']).toEqual(['Noto Sans Regular']);
  });

  it('caches the Liberty style and does not re-fetch', async () => {
    await getOnlineStyleWithContours();
    await getOnlineStyleWithContours();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the cached style on repeated calls', async () => {
    const style1 = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    const style2 = (await getOnlineStyleWithContours()) as Record<string, unknown>;

    // Both should have the same structure
    const layers1 = (style1.layers as { id: string }[]).map((l) => l.id);
    const layers2 = (style2.layers as { id: string }[]).map((l) => l.id);
    expect(layers1).toEqual(layers2);

    // Contour layers should appear exactly once
    const contourCount = layers2.filter((id) => id.startsWith('contour-')).length;
    expect(contourCount).toBe(4);
  });

  it('preserves original Liberty layers', async () => {
    const style = (await getOnlineStyleWithContours()) as Record<string, unknown>;
    const layerIds = (style.layers as { id: string }[]).map((l) => l.id);
    expect(layerIds).toContain('background');
    expect(layerIds).toContain('water');
    expect(layerIds).toContain('road_minor');
    expect(layerIds).toContain('place_label');
  });

  it('clears cache on clearStyleCache', async () => {
    await getOnlineStyleWithContours();
    clearStyleCache();
    await getOnlineStyleWithContours();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Contour zoom/filter alignment
//
// The contour tile data is emitted in zoom tiers by classifyAndTileContours()
// in scripts/tile-pipeline.ts. If a style layer's minzoom is later than the
// zoom at which its filtered elevation class first appears in the data, the
// device downloads and decodes those features and never draws them.
//
// The tier table below mirrors scripts/tile-pipeline.ts — a drift in either
// place fails these tests.
// ---------------------------------------------------------------------------

const CONTOUR_SOURCE_MIN_ZOOM = 9; // tippecanoe -Z9
const CONTOUR_SOURCE_MAX_ZOOM = 15; // tippecanoe -z15

/** Mirrors the `tiers` array in classifyAndTileContours(). */
const CONTOUR_DATA_TIERS: { minZoom: number; matches: (elevation: number) => boolean }[] = [
  { minZoom: 9, matches: (e) => e % 100 === 0 },
  { minZoom: 10, matches: (e) => e % 50 === 0 && e % 100 !== 0 },
  { minZoom: 12, matches: (e) => e % 20 === 0 && e % 50 !== 0 },
  { minZoom: 13, matches: (e) => e % 20 !== 0 && e % 50 !== 0 },
];

/** Mirrors the `is_index` column added by classifyAndTileContours(). */
const isIndex = (elevation: number): boolean => elevation % 50 === 0;

/**
 * Candidate elevations covering every tier, including the sea-level and
 * sub-zero values that exist in the source DEM.
 */
const SAMPLE_ELEVATIONS: number[] = [];
for (let e = -200; e <= 2000; e += 10) SAMPLE_ELEVATIONS.push(e);

/** The lowest zoom at which any elevation matching `predicate` exists in a tile. */
function firstAvailableZoom(predicate: (elevation: number) => boolean): number {
  const zooms = CONTOUR_DATA_TIERS.filter((tier) =>
    SAMPLE_ELEVATIONS.some((e) => tier.matches(e) && predicate(e)),
  ).map((tier) => tier.minZoom);
  if (zooms.length === 0) throw new Error('predicate matches no contour data');
  return Math.min(...zooms);
}

/**
 * Predicates matching each layer's style filter. Kept as plain JS rather than
 * evaluating MapLibre expressions so the intent of each layer is explicit; the
 * `filter` arrays themselves are compared between the two styles below.
 */
const LAYER_EXPECTATIONS: Record<
  string,
  { matches: (elevation: number) => boolean; minzoom: number; alignedToData: boolean }
> = {
  'contour-major-index': {
    matches: (e) => e % 200 === 0 && e > 0,
    minzoom: 9,
    alignedToData: true,
  },
  'contour-index': {
    matches: (e) => isIndex(e) && e % 200 !== 0 && e > 0,
    minzoom: 9,
    alignedToData: true,
  },
  'contour-regular': {
    matches: (e) => !isIndex(e) && e > 0,
    minzoom: 12,
    alignedToData: true,
  },
  // Labels are deliberately held back below their data availability (z9) so
  // that z9-z11 are not carpeted in "100m" text.
  'contour-label': {
    matches: (e) => isIndex(e) && e > 0,
    minzoom: 12,
    alignedToData: false,
  },
};

type ContourLayer = {
  id: string;
  minzoom?: number;
  filter?: unknown;
};

// The bundled offline template, loaded exactly the way tile-service.ts loads it.
const OFFLINE_STYLE = require('../../../assets/topo-style.json') as {
  sources: Record<string, { minzoom?: number; maxzoom?: number }>;
  layers: ContourLayer[];
};

describe('contour layer zooms match the tile data tiers', () => {
  let onlineContourLayers: ContourLayer[];

  beforeEach(async () => {
    const style = (await getOnlineStyleWithContours()) as { layers: ContourLayer[] };
    onlineContourLayers = style.layers.filter((l) => l.id.startsWith('contour-'));
  });

  const offlineContourLayers = (): ContourLayer[] =>
    OFFLINE_STYLE.layers.filter((l) => l.id.startsWith('contour-'));

  it('covers every contour layer in both styles', () => {
    const expected = Object.keys(LAYER_EXPECTATIONS).sort();
    expect(onlineContourLayers.map((l) => l.id).sort()).toEqual(expected);
    expect(offlineContourLayers().map((l) => l.id).sort()).toEqual(expected);
  });

  describe.each(Object.entries(LAYER_EXPECTATIONS))(
    '%s',
    (layerId, { matches, minzoom, alignedToData }) => {
      const dataZoom = () => firstAvailableZoom(matches);

      it('pins the expected minzoom against the data tiers', () => {
        if (alignedToData) {
          // Rendering must start exactly where the data starts: later wastes
          // decoded tile bytes, earlier renders an incomplete contour set.
          expect(minzoom).toBe(dataZoom());
        } else {
          // Deliberately deferred, but never earlier than the data exists.
          expect(minzoom).toBeGreaterThan(dataZoom());
        }
      });

      it('online style uses that minzoom', () => {
        const layer = onlineContourLayers.find((l) => l.id === layerId);
        expect(layer?.minzoom).toBe(minzoom);
      });

      it('offline style uses that minzoom', () => {
        const layer = offlineContourLayers().find((l) => l.id === layerId);
        expect(layer?.minzoom).toBe(minzoom);
      });

      it('online and offline filters are identical', () => {
        const online = onlineContourLayers.find((l) => l.id === layerId);
        const offline = offlineContourLayers().find((l) => l.id === layerId);
        expect(online?.filter).toEqual(offline?.filter);
      });

      it('excludes sea-level and sub-zero contours', () => {
        const filter = JSON.stringify(
          onlineContourLayers.find((l) => l.id === layerId)?.filter,
        );
        expect(filter).toContain('[">",["to-number",["get","elevation"]],0]');
        expect(matches(0)).toBe(false);
        expect(matches(-10)).toBe(false);
        expect(matches(-200)).toBe(false);
      });
    },
  );

  it('offline contour source declares the tippecanoe zoom range', () => {
    expect(OFFLINE_STYLE.sources.contour.minzoom).toBe(CONTOUR_SOURCE_MIN_ZOOM);
    expect(OFFLINE_STYLE.sources.contour.maxzoom).toBe(CONTOUR_SOURCE_MAX_ZOOM);
  });

  it('online contour source declares the same zoom range as the offline source', async () => {
    const style = (await getOnlineStyleWithContours()) as {
      sources: Record<string, { minzoom?: number; maxzoom?: number }>;
    };
    expect(style.sources.contour.minzoom).toBe(CONTOUR_SOURCE_MIN_ZOOM);
    expect(style.sources.contour.maxzoom).toBe(CONTOUR_SOURCE_MAX_ZOOM);
  });

  it('no contour layer renders below the source minzoom', () => {
    for (const layer of [...onlineContourLayers, ...offlineContourLayers()]) {
      expect(layer.minzoom).toBeGreaterThanOrEqual(CONTOUR_SOURCE_MIN_ZOOM);
    }
  });
});

describe('getOnlineMapStyle', () => {
  it('resolves the Liberty style object even when contours are not configured', async () => {
    delete process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;

    const style = (await getOnlineMapStyle()) as Record<string, unknown>;

    expect(global.fetch).toHaveBeenCalledWith(
      'https://tiles.openfreemap.org/styles/liberty',
    );
    expect(style.version).toBe(8);
    expect((style.sources as Record<string, unknown>).contour).toBeUndefined();
  });

  it('warns when EXPO_PUBLIC_CONTOUR_TILE_URL is not set', async () => {
    delete process.env.EXPO_PUBLIC_CONTOUR_TILE_URL;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await getOnlineMapStyle();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('EXPO_PUBLIC_CONTOUR_TILE_URL is not set'),
    );
  });

  it('does not warn when contours are configured and healthy', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await getOnlineMapStyle();

    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves one complete style object with contours when configured', async () => {
    const style = (await getOnlineMapStyle()) as Record<string, unknown>;
    const sources = style.sources as Record<string, unknown>;
    const layerIds = (style.layers as { id: string }[]).map((layer) => layer.id);

    expect(sources.contour).toBeDefined();
    expect(layerIds).toContain('contour-regular');
    expect(layerIds).toContain('contour-label');
  });

  it('keeps the base map but omits contours when the archive health check fails', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === `${CONTOUR_URL}/health`) {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(JSON.parse(JSON.stringify(MOCK_LIBERTY_STYLE))),
      });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const style = (await getOnlineMapStyle()) as Record<string, unknown>;
    const sources = style.sources as Record<string, unknown>;
    const layerIds = (style.layers as { id: string }[]).map((layer) => layer.id);

    expect(sources.contour).toBeUndefined();
    expect(layerIds).not.toContain('contour-regular');
    expect(layerIds).toContain('road_minor');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('health check failed'),
    );
  });
});
