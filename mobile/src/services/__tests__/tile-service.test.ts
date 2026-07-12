/**
 * Tests for tile-service.ts — buildTopoStyle, getTrailTileStatus, deleteTrailTiles.
 */

// ---------------------------------------------------------------------------
// Mock state shared between File / Directory mocks and the tests
// ---------------------------------------------------------------------------

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
// Imports — after mocks are set up
// ---------------------------------------------------------------------------

import {
  buildTopoStyle,
  getTrailTileStatus,
  deleteTrailTiles,
} from '../tile-service';
import { Directory } from 'expo-file-system';

// ---------------------------------------------------------------------------
// Reset mock state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  for (const key of Object.keys(mockDirs)) delete mockDirs[key];
  for (const key of Object.keys(mockFileContents)) delete mockFileContents[key];
  jest.clearAllMocks();
});

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
    const layers = style.layers as Array<{ id: string; type: string }>;

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
