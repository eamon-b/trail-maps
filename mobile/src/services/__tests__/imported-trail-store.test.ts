/**
 * Tests for imported-trail-store — JSON on disk + registry row, and the
 * ordering guarantees that make a torn save/delete recoverable.
 *
 * expo-file-system is mocked locally (the global jest.setup.js only stubs the
 * legacy readAsStringAsync/writeAsStringAsync surface, not `File`/`Directory`/
 * `Paths`) — same shape as the tile-service spec's mock, trimmed to the
 * operations this module uses.
 */

import {
  saveImportedTrail,
  readImportedTrail,
  deleteImportedTrailEverywhere,
  importedTrailFile,
  importedTrailsRoot,
} from '../imported-trail-store';
import { getImportedTrail, listImportedTrails } from '../../db/imported-trails-repo';
import { usePlanInputsStore } from '../../features/plan/plan-inputs-store';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { TrailJson } from '../trail-assets';
import { File } from 'expo-file-system';

// ---------------------------------------------------------------------------
// Mock filesystem
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};
const mockDirs: Record<string, boolean> = {};

jest.mock('expo-file-system', () => {
  function join(args: unknown[]): string {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') {
        parts.push(a.replace('file://', '').replace(/\/$/, ''));
      } else if (a && typeof a === 'object' && 'uri' in a) {
        parts.push((a as { uri: string }).uri.replace('file://', '').replace(/\/$/, ''));
      }
    }
    return 'file://' + parts.join('/');
  }

  const MockFile = jest.fn().mockImplementation((...args: unknown[]) => {
    const uri = join(args);
    return {
      get uri() {
        return uri;
      },
      get exists() {
        return mockFiles[uri] !== undefined;
      },
      text: jest.fn(async () => {
        if (mockFiles[uri] === undefined) throw new Error('ENOENT');
        return mockFiles[uri];
      }),
      write: jest.fn((data: string) => {
        const parent = uri.slice(0, uri.lastIndexOf('/'));
        if (!mockDirs[parent]) throw new Error('ENOENT: parent directory missing');
        mockFiles[uri] = data;
      }),
      delete: jest.fn(() => {
        delete mockFiles[uri];
      }),
    };
  });

  const MockDirectory = jest.fn().mockImplementation((...args: unknown[]) => {
    const uri = join(args);
    return {
      get uri() {
        return uri;
      },
      get exists() {
        return mockDirs[uri] === true;
      },
      create: jest.fn(() => {
        mockDirs[uri] = true;
      }),
      delete: jest.fn(() => {
        delete mockDirs[uri];
      }),
    };
  });

  return {
    __esModule: true,
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: '/mock/document', cache: '/mock/cache' },
  };
});

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockDirs)) delete mockDirs[k];
  usePlanInputsStore.setState({ byTrail: {} });
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrail(id = 'u_abc123'): TrailJson {
  return {
    config: {
      id,
      name: 'My Weekend Loop',
      shortName: 'Weekend Loop',
      region: 'Imported',
      lengthKm: 42.5,
      direction: { default: 'northbound', reversed: 'southbound' },
    },
    waypoints: [
      { id: 'uw_1', name: 'Trailhead', lat: -23.7, lon: 133.8, type: 'endpoint' },
    ],
    track: {
      points: [
        { lat: -23.7, lon: 133.8, ele: 600, dist: 0 },
        { lat: -23.71, lon: 133.81, ele: 620, dist: 1.4 },
      ],
      displayPoints: [{ lat: -23.7, lon: 133.8, ele: 600, dist: 0 }],
      totalDistance: 42.5,
      totalAscent: 900,
      totalDescent: 880,
    },
  };
}

const META = { hasElevation: true, pointCount: 2, waypointCount: 1 };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('imported-trail-store — paths', () => {
  it('puts trail JSON under {documentDir}/trails/{id}.json', () => {
    expect(importedTrailsRoot().uri).toBe('file:///mock/document/trails');
    expect(importedTrailFile('u_abc123').uri).toBe(
      'file:///mock/document/trails/u_abc123.json',
    );
  });
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

describe('saveImportedTrail', () => {
  it('creates the trails directory, writes the file, then registers the row', async () => {
    const db = await createMigratedTestDb();
    const trail = makeTrail();

    await saveImportedTrail(db as never, trail, META);

    expect(mockDirs['file:///mock/document/trails']).toBe(true);
    expect(JSON.parse(mockFiles['file:///mock/document/trails/u_abc123.json'])).toEqual(trail);

    const row = await getImportedTrail(db as never, 'u_abc123');
    expect(row).toMatchObject({
      id: 'u_abc123',
      name: 'My Weekend Loop',
      shortName: 'Weekend Loop',
      lengthKm: 42.5,
      source: 'imported',
      hasElevation: true,
      pointCount: 2,
      waypointCount: 1,
    });
  });

  it('records a missing-elevation import', async () => {
    const db = await createMigratedTestDb();
    await saveImportedTrail(db as never, makeTrail(), { ...META, hasElevation: false });
    expect((await getImportedTrail(db as never, 'u_abc123'))?.hasElevation).toBe(false);
  });

  it('is idempotent — re-importing the same file overwrites, never duplicates', async () => {
    const db = await createMigratedTestDb();
    await saveImportedTrail(db as never, makeTrail(), META);

    const renamed = makeTrail();
    renamed.config.name = 'Renamed Loop';
    await saveImportedTrail(db as never, renamed, { ...META, pointCount: 3 });

    const rows = await listImportedTrails(db as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed Loop');
    expect(rows[0].pointCount).toBe(3);
    expect(
      JSON.parse(mockFiles['file:///mock/document/trails/u_abc123.json']).config.name,
    ).toBe('Renamed Loop');
  });

  it('does not register a row when the file write fails', async () => {
    // File first, row second: a failed write must leave NOTHING listed, rather
    // than a guide that lists fine and then opens onto missing data.
    const db = await createMigratedTestDb();
    const RealFile = File as unknown as jest.Mock;
    RealFile.mockImplementationOnce(() => ({
      uri: 'file:///mock/document/trails/u_abc123.json',
      exists: false,
      write: () => {
        throw new Error('ENOSPC');
      },
    }));

    let message = '';
    try {
      await saveImportedTrail(db as never, makeTrail(), META);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('ENOSPC');
    expect(await listImportedTrails(db as never)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe('readImportedTrail', () => {
  it('round-trips a saved trail', async () => {
    const db = await createMigratedTestDb();
    const trail = makeTrail();
    await saveImportedTrail(db as never, trail, META);

    expect(await readImportedTrail('u_abc123')).toEqual(trail);
  });

  it('returns null for a trail that was never imported', async () => {
    expect(await readImportedTrail('u_missing')).toBeNull();
  });

  it('returns null for a corrupt file instead of throwing', async () => {
    mockDirs['file:///mock/document/trails'] = true;
    mockFiles['file:///mock/document/trails/u_torn.json'] = '{"config":';

    expect(await readImportedTrail('u_torn')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deleteImportedTrailEverywhere', () => {
  it('removes the row, the file, and the plan-inputs entry', async () => {
    const db = await createMigratedTestDb();
    await saveImportedTrail(db as never, makeTrail(), META);
    await db.runAsync(
      "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('u_abc123', 'uw_1')",
    );
    usePlanInputsStore.getState().setDailyHours('u_abc123', 6);
    usePlanInputsStore.getState().setDailyHours('larapinta', 10);

    await deleteImportedTrailEverywhere(db as never, 'u_abc123');

    expect(await getImportedTrail(db as never, 'u_abc123')).toBeNull();
    expect(mockFiles['file:///mock/document/trails/u_abc123.json']).toBeUndefined();
    expect(await readImportedTrail('u_abc123')).toBeNull();

    const favorites = await db.getAllAsync<{ waypoint_id: string }>(
      "SELECT waypoint_id FROM favorites WHERE trail_id = 'u_abc123'",
    );
    expect(favorites).toHaveLength(0);

    const byTrail = usePlanInputsStore.getState().byTrail;
    expect(byTrail['u_abc123']).toBeUndefined();
    // Other trails' prefs survive.
    expect(byTrail['larapinta']?.dailyHours).toBe(10);
  });

  it('tolerates a missing file (torn earlier delete)', async () => {
    const db = await createMigratedTestDb();
    await saveImportedTrail(db as never, makeTrail(), META);
    delete mockFiles['file:///mock/document/trails/u_abc123.json'];

    await expect(
      deleteImportedTrailEverywhere(db as never, 'u_abc123'),
    ).resolves.toBeUndefined();
    expect(await getImportedTrail(db as never, 'u_abc123')).toBeNull();
  });

  it('is a no-op for a bundled trail id', async () => {
    const db = await createMigratedTestDb();
    await saveImportedTrail(db as never, makeTrail(), META);

    await deleteImportedTrailEverywhere(db as never, 'larapinta');

    expect(await listImportedTrails(db as never)).toHaveLength(1);
    expect(mockFiles['file:///mock/document/trails/u_abc123.json']).toBeDefined();
  });
});
