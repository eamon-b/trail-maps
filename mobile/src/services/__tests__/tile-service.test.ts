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

const mockFiles: Record<string, { exists: boolean; size: number }> = {};
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
    const uri = 'file://' + parts.join('/');
    return {
      get uri() { return uri; },
      get exists() { return mockFiles[uri]?.exists ?? false; },
      get size() { return mockFiles[uri]?.size ?? 0; },
      textSync: jest.fn(() => mockFileContents[uri] ?? ''),
      delete: jest.fn(() => {
        mockFiles[uri] = { exists: false, size: 0 };
        delete mockFileContents[uri];
      }),
      write: jest.fn((data: string) => {
        mockFileContents[uri] = data;
        mockFiles[uri] = { exists: true, size: data.length };
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

  it('deletes the file and throws when a downloaded mbtiles fails validation', async () => {
    useDb(fakeDb({ getFirstAsync: jest.fn().mockResolvedValue(null) }));

    await expect(downloadTrailTiles(TRAIL_ID, BASE_URL)).rejects.toThrow(
      /not a usable tile database/,
    );

    expect(mockFiles[fileKey('base.mbtiles')]?.exists).toBe(false);
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
