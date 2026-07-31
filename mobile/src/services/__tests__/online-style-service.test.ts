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
