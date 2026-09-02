/**
 * Tests for tile-service.ts — buildTopoStyle, getTrailTileStatus, deleteTrailTiles.
 */

// ---------------------------------------------------------------------------
// Mock state shared between File / Directory mocks and the tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Imports — after mocks are set up
// ---------------------------------------------------------------------------

import {
  buildTopoStyle,
  getTrailTileStatus,
  deleteTrailTiles,
  downloadTrailTiles,
  validateMbtiles,
  validateMbtilesCached,
  clearMbtilesValidationCache,
} from '../tile-service';
import { Directory, File } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

const mockFiles: Record<string, { exists: boolean; size: number; md5?: string | null }> = {};
const mockDirs: Record<string, { exists: boolean; deleted: boolean }> = {};
const mockFileContents: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Local mocks — the global jest.setup.js only provides readAsStringAsync /
// writeAsStringAsync / documentDirectory / cacheDirectory.  tile-service.ts
// imports { File, Directory, Paths } which need to be mocked here.
// ---------------------------------------------------------------------------

jest.mock('expo-file-system', () => {
  const MockFile = jest.fn().mockImplementation((...args: unknown[]) => {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') {
        parts.push(a);
      } else if (a && typeof a === 'object' && 'uri' in a) {
        const dirUri = (a as { uri: string }).uri;
        parts.push(dirUri.replace('file://', '').replace(/\/$/, ''));
      }
    }
    let uri = 'file://' + parts.join('/');
    return {
      get uri() { return uri; },
      get exists() { return mockFiles[uri]?.exists ?? false; },
      get size() { return mockFiles[uri]?.size ?? 0; },
      // expo-file-system SDK 54 exposes a natively computed MD5 (null when the
      // file is missing or unreadable).
      get md5() { return mockFiles[uri]?.md5 ?? null; },
      textSync: jest.fn(() => mockFileContents[uri] ?? ''),
      delete: jest.fn(() => {
        mockFiles[uri] = { exists: false, size: 0 };
        delete mockFileContents[uri];
      }),
      write: jest.fn((data: string) => {
        mockFileContents[uri] = data;
        mockFiles[uri] = { exists: true, size: data.length };
      }),
      // Mirrors the native behaviour: throws when the source is missing or the
      // destination already exists, and moves both size and contents.
      rename: jest.fn((newName: string) => {
        const target = uri.slice(0, uri.lastIndexOf('/') + 1) + newName;
        if (!mockFiles[uri]?.exists) throw new Error('rename: source does not exist');
        if (mockFiles[target]?.exists) throw new Error('rename: destination already exists');
        mockFiles[target] = { ...mockFiles[uri] };
        if (mockFileContents[uri] !== undefined) mockFileContents[target] = mockFileContents[uri];
        mockFiles[uri] = { exists: false, size: 0 };
        delete mockFileContents[uri];
        uri = target;
      }),
    };
  });

  const MockDirectory = jest.fn().mockImplementation((...args: unknown[]) => {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') {
        parts.push(a);
      } else if (a && typeof a === 'object' && 'uri' in a) {
        const dirUri = (a as { uri: string }).uri;
        parts.push(dirUri.replace('file://', '').replace(/\/$/, ''));
      }
    }
    const uri = 'file://' + parts.join('/');
    const key = uri;
    return {
      get uri() { return uri; },
      get exists() { return mockDirs[key]?.exists ?? false; },
      create: jest.fn(() => { mockDirs[key] = { exists: true, deleted: false }; }),
      delete: jest.fn(() => { mockDirs[key] = { exists: false, deleted: true }; }),
      list: jest.fn(() => []),
      get name() { return parts[parts.length - 1]; },
    };
  });

  // Static download helper used by downloadTrailTiles
  (MockFile as unknown as { downloadFileAsync: jest.Mock }).downloadFileAsync = jest.fn();

  return {
    __esModule: true,
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      document: '/mock/document',
      cache: '/mock/cache',
    },
    readAsStringAsync: jest.fn(),
    writeAsStringAsync: jest.fn(),
    documentDirectory: '/mock/document/',
    cacheDirectory: '/mock/cache/',
  };
});

jest.mock('expo-asset', () => ({
  Asset: {
    loadAsync: jest.fn(),
    fromModule: jest.fn(() => ({
      downloadAsync: jest.fn().mockResolvedValue(undefined),
      localUri: 'file:///mock/asset/font.pbf',
    })),
  },
}));

// ---------------------------------------------------------------------------
// Reset mock state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  for (const key of Object.keys(mockDirs)) delete mockDirs[key];
  for (const key of Object.keys(mockFileContents)) delete mockFileContents[key];
  jest.clearAllMocks();
  clearMbtilesValidationCache();
});

// ---------------------------------------------------------------------------
// Fake expo-sqlite databases for mbtiles validation
// ---------------------------------------------------------------------------

const mockOpenDatabaseAsync = openDatabaseAsync as jest.MockedFunction<typeof openDatabaseAsync>;

type FakeDb = {
  execAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  getAllAsync: jest.Mock;
  closeAsync: jest.Mock;
};

/** A structurally valid mbtiles database (has tiles + sane metadata). */
function fakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ zoom_level: 9 }),
    getAllAsync: jest.fn().mockResolvedValue([
      { name: 'minzoom', value: '9' },
      { name: 'maxzoom', value: '15' },
      { name: 'bounds', value: '115.8,-35.1,117.9,-31.9' },
    ]),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function useDb(db: FakeDb): void {
  mockOpenDatabaseAsync.mockResolvedValue(db as never);
}

// ---------------------------------------------------------------------------
// buildTopoStyle
// ---------------------------------------------------------------------------

describe('buildTopoStyle', () => {
  const TRAIL_ID = 'heysen-trail';
  const GLYPHS_PATH = '/mock/document/fonts';

  it('returns a MapLibre style object with version 8', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH) as Record<string, unknown>;
    expect(style.version).toBe(8);
  });

  it('includes basemap and contour sources with mbtiles:// URLs containing trailId', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH) as Record<string, unknown>;
    const sources = style.sources as Record<string, { type: string; url: string }>;

    expect(sources.basemap).toBeDefined();
    expect(sources.basemap.type).toBe('vector');
    expect(sources.basemap.url).toContain('mbtiles://');
    expect(sources.basemap.url).toContain(TRAIL_ID);
    expect(sources.basemap.url).toContain('base.mbtiles');

    expect(sources.contour).toBeDefined();
    expect(sources.contour.type).toBe('vector');
    expect(sources.contour.url).toContain('mbtiles://');
    expect(sources.contour.url).toContain(TRAIL_ID);
    expect(sources.contour.url).toContain('contours.mbtiles');
  });

  it('includes glyphs URL from the provided glyphsPath', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH) as Record<string, unknown>;
    expect(style.glyphs).toBe('file:///mock/document/fonts/{fontstack}/{range}.pbf');
  });

  it('has expected layer types: background, fill, line, symbol', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH) as Record<string, unknown>;
    const layers = style.layers as { id: string; type: string }[];

    expect(Array.isArray(layers)).toBe(true);
    expect(layers.length).toBeGreaterThan(0);

    const layerTypes = new Set(layers.map((l) => l.type));
    expect(layerTypes.has('background')).toBe(true);
    expect(layerTypes.has('fill')).toBe(true);
    expect(layerTypes.has('line')).toBe(true);
    expect(layerTypes.has('symbol')).toBe(true);
  });

  // --- dark palette -------------------------------------------------------
  // The dark theme is a paint patch over the same template (see
  // assets/topo-style-dark.json): structure single-sourced, colours stated once
  // per theme.
  describe('dark theme', () => {
    const layersOf = (theme?: 'light' | 'dark') =>
      (buildTopoStyle(TRAIL_ID, GLYPHS_PATH, theme ? { theme } : undefined) as {
        layers: { id: string; type: string; paint?: Record<string, unknown> }[];
      }).layers;

    it('defaults to the light palette', () => {
      expect(layersOf()).toEqual(layersOf('light'));
    });

    it('repaints the ground dark without touching structure', () => {
      const light = layersOf('light');
      const dark = layersOf('dark');

      expect(dark.map((l) => l.id)).toEqual(light.map((l) => l.id));
      expect(dark.map((l) => l.type)).toEqual(light.map((l) => l.type));

      const background = dark.find((l) => l.id === 'background');
      expect(background?.paint?.['background-color']).toBe('#14161a');
      expect(dark.find((l) => l.id === 'earth')?.paint?.['fill-color']).toBe('#14161a');
    });

    it('leaves filters and zoom ranges to the light template', () => {
      // The dark file carries paint only. If it ever grows a filter, the two
      // themes can disagree about which contour lines exist at which zoom.
      const strip = (l: Record<string, unknown>) => {
        const { paint: _paint, ...rest } = l;
        return rest;
      };
      expect(layersOf('dark').map(strip)).toEqual(layersOf('light').map(strip));
    });

    it('patches every layer of the template, so nothing is left light on a dark map', () => {
      const light = layersOf('light');
      const dark = layersOf('dark');
      light.forEach((layer, i) => {
        expect(dark[i].paint).not.toEqual(layer.paint);
      });
    });

    it('has no stale layer ids — every palette entry still exists in the template', () => {
      // The other direction of the same contract: an id that no longer exists
      // silently paints nothing, and the map would look half-repainted.
      const palette = require('../../../assets/topo-style-dark.json') as Record<string, unknown>;
      const ids = new Set(layersOf('light').map((l) => l.id));
      const stale = Object.keys(palette).filter((k) => !k.startsWith('$') && !ids.has(k));
      expect(stale).toEqual([]);
    });

    it('still drops the contour layers when contours are unusable', () => {
      const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH, {
        theme: 'dark',
        includeContours: false,
      }) as { sources: Record<string, unknown>; layers: { source?: string }[] };
      expect(style.sources.contour).toBeUndefined();
      expect(style.layers.some((l) => l.source === 'contour')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getTrailTileStatus
// ---------------------------------------------------------------------------

describe('getTrailTileStatus', () => {
  const TRAIL_ID = 'bibbulmun';

  function fileKey(name: string): string {
    return `file:///mock/document/tiles/${TRAIL_ID}/${name}`;
  }

  it('returns complete: false when no files exist', () => {
    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.trailId).toBe(TRAIL_ID);
    expect(status.complete).toBe(false);
    expect(status.totalSizeBytes).toBe(0);
    expect(status.files).toHaveLength(2);
    expect(status.files[0]).toEqual({ name: 'base.mbtiles', exists: false, sizeBytes: 0 });
    expect(status.files[1]).toEqual({ name: 'contours.mbtiles', exists: false, sizeBytes: 0 });
  });

  it('returns complete: true when both base and contours exist with size > 0', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 2_000_000 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.complete).toBe(true);
    expect(status.files[0]).toEqual({ name: 'base.mbtiles', exists: true, sizeBytes: 5_000_000 });
    expect(status.files[1]).toEqual({ name: 'contours.mbtiles', exists: true, sizeBytes: 2_000_000 });
  });

  it('returns complete: false when one file is missing', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.complete).toBe(false);
    expect(status.files[0].exists).toBe(true);
    expect(status.files[1].exists).toBe(false);
  });

  it('calculates correct totalSizeBytes by summing file sizes', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 3_500_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 1_500_000 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.totalSizeBytes).toBe(5_000_000);
  });

  // ----- state tri-state (absent / partial / complete) -----

  function writeManifest(sizes: { base: number; contours: number }, version = 'v1') {
    const manifest = {
      trailId: TRAIL_ID,
      version,
      files: [
        { name: 'base.mbtiles', size: sizes.base, sha256: 'a' },
        { name: 'contours.mbtiles', size: sizes.contours, sha256: 'b' },
      ],
      totalSize: sizes.base + sizes.contours,
      bounds: [0, 0, 0, 0],
      zoomRange: [8, 14],
    };
    const key = fileKey('manifest.json');
    mockFiles[key] = { exists: true, size: 1 };
    mockFileContents[key] = JSON.stringify(manifest);
  }

  it('reports state "absent" and complete false when nothing is on disk', () => {
    const status = getTrailTileStatus(TRAIL_ID);
    expect(status.state).toBe('absent');
    expect(status.complete).toBe(false);
  });

  it('verifies against the manifest: complete only when sizes match exactly', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 2_000_000 };
    writeManifest({ base: 5_000_000, contours: 2_000_000 }, 'v3');

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.state).toBe('complete');
    expect(status.complete).toBe(true);
    expect(status.version).toBe('v3');
  });

  it('reports "partial" (not a false-positive complete) when a file is truncated vs the manifest', () => {
    // App killed mid-download of contours: base is whole, contours truncated.
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 512 };
    writeManifest({ base: 5_000_000, contours: 2_000_000 });

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.state).toBe('partial');
    expect(status.complete).toBe(false);
  });

  it('reports "partial" when the manifest expects a file that is missing', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    writeManifest({ base: 5_000_000, contours: 2_000_000 });

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.state).toBe('partial');
    expect(status.complete).toBe(false);
  });

  it('falls back to a presence heuristic with no manifest (custom grid downloads)', () => {
    // Both files present, no manifest → treated as complete (best effort).
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 2_000_000 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.state).toBe('complete');
    expect(status.complete).toBe(true);
  });

  it('reports "partial" with no manifest when only one file is present', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.state).toBe('partial');
    expect(status.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteTrailTiles
// ---------------------------------------------------------------------------

describe('deleteTrailTiles', () => {
  const TRAIL_ID = 'larapinta';

  function dirKey(): string {
    return `file:///mock/document/tiles/${TRAIL_ID}`;
  }

  it('calls directory.delete() when the directory exists', () => {
    mockDirs[dirKey()] = { exists: true, deleted: false };

    deleteTrailTiles(TRAIL_ID);

    expect(mockDirs[dirKey()]?.deleted).toBe(true);
    expect(mockDirs[dirKey()]?.exists).toBe(false);
  });

  it('does not call delete when the directory does not exist', () => {
    deleteTrailTiles(TRAIL_ID);

    const dirCalls = (Directory as unknown as jest.Mock).mock.results;
    const lastResult = dirCalls[dirCalls.length - 1]?.value;
    expect(lastResult.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateMbtiles — guards against files that crash MapLibre natively
// ---------------------------------------------------------------------------

describe('validateMbtiles', () => {
  const TRAIL_ID = 'aawt';

  beforeEach(() => {
    // validateMbtiles refuses to open a database for a file that isn't there,
    // so the files under test must exist on the mock filesystem.
    for (const name of ['base.mbtiles', 'contours.mbtiles']) {
      mockFiles[`file:///mock/document/tiles/${TRAIL_ID}/${name}`] = {
        exists: true,
        size: 5_000_000,
      };
    }
  });

  it('returns ok:false without creating the file when it does not exist', async () => {
    const uri = `file:///mock/document/tiles/${TRAIL_ID}/contours.mbtiles`;
    delete mockFiles[uri];
    useDb(fakeDb());

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('file does not exist');
    // openDatabaseAsync would CREATE an empty (crash-inducing) sqlite db here.
    expect(mockOpenDatabaseAsync).not.toHaveBeenCalled();
    expect(mockFiles[uri]).toBeUndefined();
  });

  it('accepts a healthy mbtiles file', async () => {
    useDb(fakeDb());

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(true);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith(
      'contours.mbtiles',
      { useNewConnection: true },
      '/mock/document/tiles/aawt',
    );
  });

  it('accepts a file with tiles but no zoom metadata (MapLibre derives zooms from tiles)', async () => {
    useDb(fakeDb({ getAllAsync: jest.fn().mockResolvedValue([]) }));

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(true);
  });

  it('rejects an empty tiles table (the AAWT stub that SIGABRTed MapLibre)', async () => {
    // Empty metadata + empty tiles: MapLibre falls back to
    // SELECT MIN(zoom_level) FROM tiles -> NULL -> std::stoi("") -> abort.
    useDb(fakeDb({
      getFirstAsync: jest.fn().mockResolvedValue(null),
      getAllAsync: jest.fn().mockResolvedValue([]),
    }));

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no tiles');
  });

  it('rejects a corrupt database whose queries throw (the bibbulmun case)', async () => {
    useDb(fakeDb({
      getFirstAsync: jest.fn().mockRejectedValue(new Error('database disk image is malformed')),
    }));

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  it('rejects when the file cannot be opened as a database', async () => {
    mockOpenDatabaseAsync.mockRejectedValue(new Error('file is not a database'));

    const result = await validateMbtiles(TRAIL_ID, 'base.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a database');
  });

  it.each([
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['float', '9.5'],
  ])('rejects non-integer minzoom metadata (%s) that std::stoi cannot parse', async (_label, value) => {
    useDb(fakeDb({
      getAllAsync: jest.fn().mockResolvedValue([{ name: 'minzoom', value }]),
    }));

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('minzoom');
  });

  it('rejects malformed bounds metadata', async () => {
    useDb(fakeDb({
      getAllAsync: jest.fn().mockResolvedValue([{ name: 'bounds', value: '1,2,3' }]),
    }));

    const result = await validateMbtiles(TRAIL_ID, 'contours.mbtiles');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('bounds');
  });

  it('closes the database even when validation fails', async () => {
    const db = fakeDb({
      getFirstAsync: jest.fn().mockRejectedValue(new Error('boom')),
    });
    useDb(db);

    await validateMbtiles(TRAIL_ID, 'base.mbtiles');

    expect(db.closeAsync).toHaveBeenCalled();
  });
});

describe('validateMbtilesCached', () => {
  const TRAIL_ID = 'aawt';
  const fileUri = `file:///mock/document/tiles/${TRAIL_ID}/contours.mbtiles`;

  it('caches results per file size and revalidates when the size changes', async () => {
    mockFiles[fileUri] = { exists: true, size: 1000 };
    useDb(fakeDb());

    const first = await validateMbtilesCached(TRAIL_ID, 'contours.mbtiles');
    const second = await validateMbtilesCached(TRAIL_ID, 'contours.mbtiles');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);

    // A re-download changes the size — the cache entry must not carry over.
    mockFiles[fileUri] = { exists: true, size: 2000 };
    await validateMbtilesCached(TRAIL_ID, 'contours.mbtiles');
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(2);
  });

  it('clearMbtilesValidationCache(trailId) drops only that trail', async () => {
    mockFiles[fileUri] = { exists: true, size: 1000 };
    mockFiles['file:///mock/document/tiles/other/contours.mbtiles'] = { exists: true, size: 500 };
    useDb(fakeDb());

    await validateMbtilesCached(TRAIL_ID, 'contours.mbtiles');
    await validateMbtilesCached('other', 'contours.mbtiles');
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(2);

    clearMbtilesValidationCache(TRAIL_ID);

    await validateMbtilesCached(TRAIL_ID, 'contours.mbtiles');   // revalidates
    await validateMbtilesCached('other', 'contours.mbtiles');    // still cached
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// buildTopoStyle with includeContours: false
// ---------------------------------------------------------------------------

describe('buildTopoStyle without contours', () => {
  const TRAIL_ID = 'aawt';
  const GLYPHS_PATH = '/mock/document/fonts';

  it('omits the contour source and all contour layers', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH, { includeContours: false }) as {
      sources: Record<string, unknown>;
      layers: { id: string; source?: string }[];
    };

    expect(style.sources.contour).toBeUndefined();
    expect(style.sources.basemap).toBeDefined();
    expect(style.layers.length).toBeGreaterThan(0);
    expect(style.layers.some((l) => l.source === 'contour')).toBe(false);
  });

  it('keeps contours by default', () => {
    const style = buildTopoStyle(TRAIL_ID, GLYPHS_PATH) as {
      sources: Record<string, unknown>;
      layers: { id: string; source?: string }[];
    };

    expect(style.sources.contour).toBeDefined();
    expect(style.layers.some((l) => l.source === 'contour')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// downloadTrailTiles — validation of downloaded files
// ---------------------------------------------------------------------------

describe('downloadTrailTiles validation', () => {
  const TRAIL_ID = 'aawt';
  const BASE_URL = 'https://tiles.example.com';

  function fileKey(name: string): string {
    return `file:///mock/document/tiles/${TRAIL_ID}/${name}`;
  }

  const mockDownloadFileAsync = (File as unknown as { downloadFileAsync: jest.Mock })
    .downloadFileAsync;

  beforeEach(() => {
    // No manifest available — files pass the size check at > 1000 bytes.
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    mockDownloadFileAsync.mockImplementation(async (_url: string, dest: { uri: string }) => {
      mockFiles[dest.uri] = { exists: true, size: 5_000_000 };
    });
  });

  it('accepts valid downloads', async () => {
    useDb(fakeDb());

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).resolves.toBeUndefined();

    expect(mockDownloadFileAsync).toHaveBeenCalledTimes(2);
    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBe(true);
    expect(mockFiles[fileKey('contours.mbtiles')]?.exists).toBe(true);
  });

  it('downloads to a .part file and validates it before renaming it into place', async () => {
    useDb(fakeDb());
    /** Order of interesting events, to prove validate-then-rename. */
    const events: string[] = [];
    mockDownloadFileAsync.mockImplementation(async (_url: string, dest: { uri: string }) => {
      // Every download must target a staging path, never the live file.
      expect(dest.uri.endsWith('.part')).toBe(true);
      mockFiles[dest.uri] = { exists: true, size: 5_000_000 };
      events.push(`download:${dest.uri.split('/').pop()}`);
    });
    mockOpenDatabaseAsync.mockImplementation(async (name: string) => {
      events.push(`validate:${name}`);
      return fakeDb() as never;
    });

    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    expect(events).toEqual([
      'download:base.mbtiles.part',
      'validate:base.mbtiles.part',
      'download:contours.mbtiles.part',
      'validate:contours.mbtiles.part',
    ]);

    // Staging files are gone; the final files are in place.
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBe(true);
    expect(mockFiles[fileKey('contours.mbtiles')]?.exists).toBe(true);
  });

  it('never creates the final file and cleans up .part when validation fails', async () => {
    useDb(fakeDb({ getFirstAsync: jest.fn().mockResolvedValue(null) }));

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(
      /not a usable tile database/,
    );

    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBeFalsy();
  });

  it('cleans up .part files when the network download itself fails', async () => {
    useDb(fakeDb());
    mockDownloadFileAsync
      .mockImplementationOnce(async (_url: string, dest: { uri: string }) => {
        mockFiles[dest.uri] = { exists: true, size: 5_000_000 };
      })
      .mockImplementationOnce(async (_url: string, dest: { uri: string }) => {
        // Android streams into the destination, so a partial file can remain.
        mockFiles[dest.uri] = { exists: true, size: 128 };
        throw new Error('network died');
      });

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(/network died/);

    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBeFalsy();
    // The first file was validated but never promoted — nothing half-installed.
    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles')]?.exists).toBeFalsy();
  });

  it('removes stray .part files left by an earlier interrupted run', async () => {
    useDb(fakeDb());
    // Both real files are already valid, so nothing is downloaded this run —
    // the strays can only disappear via the up-front sweep.
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 5_000_000 };
    mockFiles[fileKey('base.mbtiles.part')] = { exists: true, size: 42 };
    mockFiles[fileKey('contours.mbtiles.part')] = { exists: true, size: 42 };

    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    expect(mockDownloadFileAsync).not.toHaveBeenCalled();
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBe(false);
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBe(false);
  });

  it('ignores .part files in getTrailTileStatus size accounting', () => {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 3_000_000 };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: 1_000_000 };
    mockFiles[fileKey('base.mbtiles.part')] = { exists: true, size: 999_999 };

    const status = getTrailTileStatus(TRAIL_ID);

    expect(status.totalSizeBytes).toBe(4_000_000);
    expect(status.state).toBe('complete');
    expect(status.files.map((f) => f.name)).toEqual(['base.mbtiles', 'contours.mbtiles']);
  });

  it('re-downloads an existing file that matches size but fails validation', async () => {
    // Simulates the pre-fix bad file already on disk: size matches, content bad.
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: 5_000_000 };

    const invalid = fakeDb({ getFirstAsync: jest.fn().mockResolvedValue(null) });
    const valid = fakeDb();
    mockOpenDatabaseAsync
      .mockResolvedValueOnce(invalid as never) // skip-branch check on existing base
      .mockResolvedValue(valid as never);      // post-download checks

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).resolves.toBeUndefined();

    // base.mbtiles was re-downloaded despite its size matching
    const baseDownloads = mockDownloadFileAsync.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes('base.mbtiles'),
    );
    expect(baseDownloads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// downloadTrailTiles — atomic updates (manifest promotion is deferred)
// ---------------------------------------------------------------------------

describe('downloadTrailTiles atomic updates', () => {
  const TRAIL_ID = 'bibbulmun';
  const BASE_URL = 'https://tiles.example.com';

  const OLD_SIZES = { base: 5_000_000, contours: 2_000_000 };
  const NEW_SIZES = { base: 6_000_000, contours: 3_000_000 };

  function fileKey(name: string): string {
    return `file:///mock/document/tiles/${TRAIL_ID}/${name}`;
  }

  function makeManifest(sizes: { base: number; contours: number }, version: string) {
    return {
      trailId: TRAIL_ID,
      version,
      files: [
        { name: 'base.mbtiles', size: sizes.base, sha256: 'a' },
        { name: 'contours.mbtiles', size: sizes.contours, sha256: 'b' },
      ],
      totalSize: sizes.base + sizes.contours,
      bounds: [0, 0, 0, 0],
      zoomRange: [8, 14],
    };
  }

  /** Put a working v1 pack (files + manifest) on the mock filesystem. */
  function installOldPack() {
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: OLD_SIZES.base };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: OLD_SIZES.contours };
    const manifestJson = JSON.stringify(makeManifest(OLD_SIZES, 'v1'));
    mockFiles[fileKey('manifest.json')] = { exists: true, size: manifestJson.length };
    mockFileContents[fileKey('manifest.json')] = manifestJson;
  }

  /** Serve a v2 manifest with larger files from the network. */
  function serveNewManifest() {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => makeManifest(NEW_SIZES, 'v2'),
    }) as unknown as typeof fetch;
  }

  const mockDownloadFileAsync = (File as unknown as { downloadFileAsync: jest.Mock })
    .downloadFileAsync;

  beforeEach(() => {
    serveNewManifest();
    useDb(fakeDb());
  });

  it('leaves the old manifest and files intact when an update fails mid-way', async () => {
    installOldPack();
    mockDownloadFileAsync
      .mockImplementationOnce(async (_url: string, dest: { uri: string }) => {
        mockFiles[dest.uri] = { exists: true, size: NEW_SIZES.base };
      })
      .mockImplementationOnce(async () => {
        throw new Error('connection reset');
      });

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(/connection reset/);

    // Old files untouched at their old sizes.
    expect(mockFiles[fileKey('base.mbtiles')]).toEqual({
      exists: true,
      size: OLD_SIZES.base,
    });
    expect(mockFiles[fileKey('contours.mbtiles')]).toEqual({
      exists: true,
      size: OLD_SIZES.contours,
    });

    // Old manifest untouched — still v1 with the old sizes.
    const manifest = JSON.parse(mockFileContents[fileKey('manifest.json')]);
    expect(manifest.version).toBe('v1');
    expect(manifest.files[0].size).toBe(OLD_SIZES.base);

    // Staging files cleaned up.
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBeFalsy();

    // The previously working pack still reports as usable.
    const status = getTrailTileStatus(TRAIL_ID);
    expect(status.state).toBe('complete');
    expect(status.complete).toBe(true);
    expect(status.version).toBe('v1');
  });

  it('leaves the old pack intact when a downloaded update file fails validation', async () => {
    installOldPack();
    mockDownloadFileAsync.mockImplementation(async (_url: string, dest: { uri: string }) => {
      mockFiles[dest.uri] = { exists: true, size: NEW_SIZES.base };
    });
    // Existing files pass the skip-branch check; the .part files do not.
    mockOpenDatabaseAsync.mockImplementation(async (name: string) =>
      (name.endsWith('.part')
        ? fakeDb({ getFirstAsync: jest.fn().mockResolvedValue(null) })
        : fakeDb()) as never,
    );

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(
      /not a usable tile database/,
    );

    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(JSON.parse(mockFileContents[fileKey('manifest.json')]).version).toBe('v1');
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
  });

  it('promotes the new manifest only after every file is installed', async () => {
    installOldPack();
    /** manifest.json content observed at the start of each file download. */
    const manifestDuringDownload: string[] = [];
    mockDownloadFileAsync.mockImplementation(async (_url: string, dest: { uri: string }) => {
      manifestDuringDownload.push(
        JSON.parse(mockFileContents[fileKey('manifest.json')]).version,
      );
      const size = dest.uri.includes('base') ? NEW_SIZES.base : NEW_SIZES.contours;
      mockFiles[dest.uri] = { exists: true, size };
    });

    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    // The old manifest was still the one on disk throughout the download.
    expect(manifestDuringDownload).toEqual(['v1', 'v1']);

    // Only at the end is the new manifest promoted.
    const manifest = JSON.parse(mockFileContents[fileKey('manifest.json')]);
    expect(manifest.version).toBe('v2');

    expect(mockFiles[fileKey('base.mbtiles')]).toEqual({ exists: true, size: NEW_SIZES.base });
    expect(mockFiles[fileKey('contours.mbtiles')]).toEqual({
      exists: true,
      size: NEW_SIZES.contours,
    });

    const status = getTrailTileStatus(TRAIL_ID);
    expect(status.state).toBe('complete');
    expect(status.version).toBe('v2');
  });

  it('still writes the manifest up-front for a fresh download (interruption detectable)', async () => {
    // No pre-existing pack.
    mockDownloadFileAsync.mockImplementation(async () => {
      // Manifest must already be on disk before the first byte lands, so an
      // app kill here leaves a detectable 'partial' rather than a bare dir.
      expect(JSON.parse(mockFileContents[fileKey('manifest.json')]).version).toBe('v2');
      throw new Error('killed');
    });

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(/killed/);

    expect(mockFileContents[fileKey('manifest.json')]).toBeDefined();
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('absent');
  });
});

// ---------------------------------------------------------------------------
// downloadTrailTiles — MD5 integrity + content-addressed remote keys
// ---------------------------------------------------------------------------

describe('downloadTrailTiles integrity verification', () => {
  const TRAIL_ID = 'heysen';
  const BASE_URL = 'https://tiles.example.com';

  const SIZES = { 'base.mbtiles': 6_000_000, 'contours.mbtiles': 3_000_000 } as const;
  const MD5 = {
    'base.mbtiles': '58ce65fc42901111111111111111ffff',
    'contours.mbtiles': '9ab0f13c77b02222222222222222ffff',
  } as const;
  const KEYS = {
    'base.mbtiles': 'base.58ce65fc4290.mbtiles',
    'contours.mbtiles': 'contours.9ab0f13c77b0.mbtiles',
  } as const;

  type TileName = keyof typeof SIZES;
  const NAMES: TileName[] = ['base.mbtiles', 'contours.mbtiles'];

  function fileKey(name: string): string {
    return `file:///mock/document/tiles/${TRAIL_ID}/${name}`;
  }

  /** Manifest served by the fake network. `md5`/`key` are opt-out for legacy. */
  function makeManifest({
    md5 = true,
    key = true,
    version = 'v2',
  }: { md5?: boolean; key?: boolean; version?: string } = {}) {
    return {
      trailId: TRAIL_ID,
      version,
      files: NAMES.map((name) => ({
        name,
        size: SIZES[name],
        sha256: `sha-${name}`,
        ...(md5 ? { md5: MD5[name] } : {}),
        ...(key ? { key: KEYS[name] } : {}),
      })),
      totalSize: SIZES['base.mbtiles'] + SIZES['contours.mbtiles'],
      bounds: [0, 0, 0, 0],
      zoomRange: [8, 14],
    };
  }

  function serve(manifest: object) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => manifest,
    }) as unknown as typeof fetch;
  }

  const mockDownloadFileAsync = (File as unknown as { downloadFileAsync: jest.Mock })
    .downloadFileAsync;

  /** Land each .part at its manifest size, with a caller-chosen digest. */
  function landDownloads(md5For: (name: TileName) => string | null) {
    mockDownloadFileAsync.mockImplementation(async (_url: string, dest: { uri: string }) => {
      const name = (dest.uri.split('/').pop() ?? '').replace('.part', '') as TileName;
      mockFiles[dest.uri] = { exists: true, size: SIZES[name], md5: md5For(name) };
    });
  }

  /** Remote object names the downloader actually requested. */
  function requestedObjects(): string[] {
    return mockDownloadFileAsync.mock.calls.map(
      (call: unknown[]) => (call[0] as string).split('/').pop() ?? '',
    );
  }

  beforeEach(() => {
    serve(makeManifest());
    useDb(fakeDb());
    landDownloads((name) => MD5[name]);
  });

  it('fetches the content-addressed key but stores the file under its plain name', async () => {
    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    expect(requestedObjects()).toEqual([
      KEYS['base.mbtiles'],
      KEYS['contours.mbtiles'],
    ]);
    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBe(true);
    expect(mockFiles[fileKey('contours.mbtiles')]?.exists).toBe(true);
  });

  it('accepts downloads whose MD5 matches the manifest', async () => {
    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).resolves.toBeUndefined();

    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(getTrailTileStatus(TRAIL_ID).version).toBe('v2');
  });

  it('rejects a download whose MD5 does not match, leaving the old pack intact', async () => {
    // A working v1 pack is on disk; the v2 download arrives corrupted but at
    // exactly the advertised size, so only the digest can catch it.
    const OLD = { base: 5_000_000, contours: 2_000_000 };
    mockFiles[fileKey('base.mbtiles')] = { exists: true, size: OLD.base };
    mockFiles[fileKey('contours.mbtiles')] = { exists: true, size: OLD.contours };
    const oldManifest = JSON.stringify({
      trailId: TRAIL_ID,
      version: 'v1',
      files: [
        { name: 'base.mbtiles', size: OLD.base, sha256: 'a' },
        { name: 'contours.mbtiles', size: OLD.contours, sha256: 'b' },
      ],
      totalSize: OLD.base + OLD.contours,
      bounds: [0, 0, 0, 0],
      zoomRange: [8, 14],
    });
    mockFiles[fileKey('manifest.json')] = { exists: true, size: oldManifest.length };
    mockFileContents[fileKey('manifest.json')] = oldManifest;

    landDownloads(() => 'deadbeefdeadbeefdeadbeefdeadbeef');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(/Checksum mismatch/);
    error.mockRestore();

    // Old files, old manifest, no staging leftovers.
    expect(mockFiles[fileKey('base.mbtiles')]).toEqual({ exists: true, size: OLD.base });
    expect(mockFiles[fileKey('contours.mbtiles')]).toEqual({
      exists: true,
      size: OLD.contours,
    });
    expect(JSON.parse(mockFileContents[fileKey('manifest.json')]).version).toBe('v1');
    expect(mockFiles[fileKey('base.mbtiles.part')]?.exists).toBeFalsy();
    expect(mockFiles[fileKey('contours.mbtiles.part')]?.exists).toBeFalsy();
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(getTrailTileStatus(TRAIL_ID).version).toBe('v1');
  });

  it('downloads legacy manifests (no md5, no key) from the plain file name', async () => {
    serve(makeManifest({ md5: false, key: false }));
    // Digest is irrelevant: with nothing to compare against, size + structure
    // remain the only gate, exactly as before content addressing.
    landDownloads(() => 'whatever-the-platform-says');

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).resolves.toBeUndefined();

    expect(requestedObjects()).toEqual(['base.mbtiles', 'contours.mbtiles']);
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
  });

  it('accepts the download when the platform cannot produce an MD5', async () => {
    landDownloads(() => null);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-downloads an existing file whose MD5 does not match the manifest', async () => {
    // Right size, valid sqlite, wrong bytes — the case the user hits
    // "Re-download" for. Skipping it would make the repair a no-op.
    mockFiles[fileKey('base.mbtiles')] = {
      exists: true,
      size: SIZES['base.mbtiles'],
      md5: 'deadbeefdeadbeefdeadbeefdeadbeef',
    };

    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    expect(requestedObjects()).toContain(KEYS['base.mbtiles']);
    expect(mockFiles[fileKey('base.mbtiles')]?.md5).toBe(MD5['base.mbtiles']);
  });

  it('skips an existing file whose MD5 already matches the manifest', async () => {
    for (const name of NAMES) {
      mockFiles[fileKey(name)] = { exists: true, size: SIZES[name], md5: MD5[name] };
    }

    await downloadTrailTiles(TRAIL_ID, BASE_URL);

    expect(mockDownloadFileAsync).not.toHaveBeenCalled();
    expect(getTrailTileStatus(TRAIL_ID).version).toBe('v2');
  });
});
