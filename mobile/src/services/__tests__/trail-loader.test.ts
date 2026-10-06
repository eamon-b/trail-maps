import {
  listTrails,
  listAllTrails,
  getTrailIndexEntry,
  getTrailIndexEntryAsync,
  getTrailJson,
  getBundledTrailJson,
  loadTrail,
  hasTrail,
  isServerKnown,
} from '../trail-loader';
import { getImportedTrail, listImportedTrails } from '../../db/imported-trails-repo';
import { readImportedTrail } from '../imported-trail-store';
import { getDatabase } from '../../db/database';
import {
  activeDownload,
  getRemoteTrail,
  listRemoteTrails,
  readDownloadedTrail,
} from '../trail-data-updates';

// The loader resolves bundled trail JSON straight from the require() map.
// Mock both the asset map and the index so the test is isolated from the
// (large) real bundled JSON and deterministic.

const INDEX_JSON = [
  { id: 'bibbulmun', name: 'Bibbulmun Track', shortName: 'Bibb', lengthKm: 981.6, dataVersion: '2026-07-29' },
  { id: 'heysen', name: 'Heysen Trail', shortName: 'Heysen', lengthKm: 1200, dataVersion: '2026-07-29' },
];

const BIBBULMUN_JSON = {
  config: {
    id: 'bibbulmun',
    name: 'Bibbulmun Track',
    shortName: 'Bibb',
    region: 'South West WA',
    lengthKm: 981.6,
    direction: { default: 'SOBO', reversed: 'NOBO' },
  },
  waypoints: [
    { id: 'w_abc123', name: 'Kalamunda', lat: -31.974, lon: 116.058, type: 'town', totalDistance: 0 },
  ],
  track: { points: [], displayPoints: [], totalDistance: 981600, totalAscent: 25000, totalDescent: 25200 },
};

const HEYSEN_JSON = {
  config: {
    id: 'heysen',
    name: 'Heysen Trail',
    shortName: 'Heysen',
    region: 'SA',
    lengthKm: 1200,
    direction: { default: 'NOBO', reversed: 'SOBO' },
  },
  waypoints: [],
  track: { points: [], displayPoints: [], totalDistance: 1200000, totalAscent: 0, totalDescent: 0 },
};

jest.mock('../trail-assets', () => ({
  TRAIL_DATA: {
    bibbulmun: BIBBULMUN_JSON,
    heysen: HEYSEN_JSON,
  },
}));

jest.mock('../../../assets/trails/index.json', () => INDEX_JSON, { virtual: true });

// The imported side is stubbed at its two seams: the registry (SQLite) and the
// on-disk JSON store. Both are covered directly by their own specs; here we
// only care that the loader dispatches to them for non-bundled ids and never
// for bundled ones.
jest.mock('../../db/database', () => ({
  getDatabase: jest.fn(async () => ({ __db: true })),
}));
jest.mock('../../db/imported-trails-repo', () => ({
  listImportedTrails: jest.fn(async () => []),
  getImportedTrail: jest.fn(async () => null),
}));
jest.mock('../imported-trail-store', () => ({
  readImportedTrail: jest.fn(async () => null),
}));

// Over-the-air copies are stubbed at the service boundary: `trail-data-updates`
// has its own spec against a fake disk; here we only care how the loader
// layers a download over the bundle and lists catalog-only trails.
jest.mock('../trail-data-updates', () => ({
  activeDownload: jest.fn(() => null),
  getRemoteTrail: jest.fn(() => null),
  listRemoteTrails: jest.fn(() => []),
  readDownloadedTrail: jest.fn(async () => null),
}));

const mockActiveDownload = activeDownload as jest.Mock;
const mockGetRemoteTrail = getRemoteTrail as jest.Mock;
const mockListRemoteTrails = listRemoteTrails as jest.Mock;
const mockReadDownloaded = readDownloadedTrail as jest.Mock;

const mockListImported = listImportedTrails as jest.Mock;
const mockGetImported = getImportedTrail as jest.Mock;
const mockReadImported = readImportedTrail as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;

const IMPORTED_ROW = {
  id: 'u_abc123',
  name: 'My Weekend Loop',
  shortName: 'My Weekend Loop',
  lengthKm: 42.5,
  source: 'imported',
  hasElevation: true,
  pointCount: 1200,
  waypointCount: 4,
  createdAt: '2026-08-22 01:00:00',
};

const IMPORTED_JSON = {
  config: { ...IMPORTED_ROW, region: 'Imported', direction: { default: 'a', reversed: 'b' } },
  waypoints: [],
  track: { points: [], displayPoints: [], totalDistance: 42500, totalAscent: 0, totalDescent: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListImported.mockResolvedValue([]);
  mockGetImported.mockResolvedValue(null);
  mockReadImported.mockResolvedValue(null);
  mockGetDatabase.mockResolvedValue({ __db: true });
  mockActiveDownload.mockReturnValue(null);
  mockGetRemoteTrail.mockReturnValue(null);
  mockListRemoteTrails.mockReturnValue([]);
  mockReadDownloaded.mockResolvedValue(null);
});

/** A downloaded copy of Heysen, newer than the bundle, as the state file records it. */
const HEYSEN_DOWNLOAD = {
  id: 'heysen',
  name: 'Heysen Trail (rerouted)',
  shortName: 'Heysen',
  lengthKm: 1210.5,
  dataVersion: '2026-10-01',
  updatedAt: '2026-10-01T00:00:00.000Z',
  md5: 'c'.repeat(32),
  bytes: 1234,
  key: 'heysen.cccccccccccc.json',
  file: 'heysen.cccccccccccc.json',
};

const HEYSEN_DOWNLOADED_JSON = {
  ...HEYSEN_JSON,
  config: { ...HEYSEN_JSON.config, name: 'Heysen Trail (rerouted)', lengthKm: 1210.5 },
};

/** A trail published to the catalog after this build was made. */
const GAMMA_REMOTE = {
  id: 'gamma',
  name: 'Gamma Way',
  shortName: 'Gamma',
  lengthKm: 77,
  updatedAt: '2026-10-02T00:00:00.000Z',
  md5: 'd'.repeat(32),
  bytes: 999,
  downloaded: false,
};

describe('trail-loader', () => {
  describe('listTrails', () => {
    it('returns the bundled trail index in order', () => {
      const trails = listTrails();
      expect(trails).toHaveLength(2);
      expect(trails.map((t) => t.id)).toEqual(['bibbulmun', 'heysen']);
      expect(trails[0]).toEqual(
        expect.objectContaining({ id: 'bibbulmun', shortName: 'Bibb', dataVersion: '2026-07-29' }),
      );
    });
  });

  describe('listTrails source flag', () => {
    it('marks every bundled entry as bundled', () => {
      expect(listTrails().every((t) => t.source === 'bundled')).toBe(true);
    });
  });

  describe('getTrailIndexEntry', () => {
    it('returns metadata for a known trail', () => {
      expect(getTrailIndexEntry('heysen')).toEqual(
        expect.objectContaining({ id: 'heysen', name: 'Heysen Trail', lengthKm: 1200 }),
      );
    });

    it('returns null for an unknown trail', () => {
      expect(getTrailIndexEntry('nonexistent')).toBeNull();
    });
  });

  describe('hasTrail', () => {
    it('is true for a bundled trail', () => {
      expect(hasTrail('bibbulmun')).toBe(true);
    });

    it('is false for an unknown trail', () => {
      expect(hasTrail('nonexistent')).toBe(false);
    });
  });

  describe('getTrailJson', () => {
    it('resolves the full trail JSON by id', () => {
      const json = getTrailJson('bibbulmun');
      expect(json).not.toBeNull();
      expect(json!.config.id).toBe('bibbulmun');
      expect(json!.track.totalDistance).toBe(981600);
    });

    it('exposes stable per-waypoint ids from bundled data', () => {
      const json = getTrailJson('bibbulmun');
      expect(json!.waypoints[0].id).toBe('w_abc123');
    });

    it('returns null for an unknown trail', () => {
      expect(getTrailJson('nonexistent')).toBeNull();
    });
  });

  describe('isServerKnown', () => {
    it('is true for bundled ids (they exist in the comments API allowlist)', () => {
      expect(isServerKnown('bibbulmun')).toBe(true);
    });

    it('is false for an imported id, so nothing about it reaches the server', () => {
      expect(isServerKnown('u_abc123')).toBe(false);
    });
  });

  describe('loadTrail', () => {
    it('resolves a bundled trail without touching the imported store', async () => {
      await expect(loadTrail('bibbulmun')).resolves.toEqual(
        expect.objectContaining({ config: expect.objectContaining({ id: 'bibbulmun' }) }),
      );
      expect(mockReadImported).not.toHaveBeenCalled();
    });

    it('falls through to the imported store for a non-bundled id', async () => {
      mockReadImported.mockResolvedValue(IMPORTED_JSON);
      const trail = await loadTrail('u_abc123');
      expect(mockReadImported).toHaveBeenCalledWith('u_abc123');
      expect(trail!.config.id).toBe('u_abc123');
    });

    it('returns null when the id is neither bundled nor imported', async () => {
      await expect(loadTrail('nope')).resolves.toBeNull();
    });

    it('returns null for a torn import whose file is gone', async () => {
      mockReadImported.mockResolvedValue(null);
      await expect(loadTrail('u_abc123')).resolves.toBeNull();
    });
  });

  describe('listAllTrails', () => {
    it('appends imported trails after the bundled ones', async () => {
      mockListImported.mockResolvedValue([IMPORTED_ROW]);
      const all = await listAllTrails();
      expect(all.map((t) => t.id)).toEqual(['bibbulmun', 'heysen', 'u_abc123']);
      expect(all.map((t) => t.source)).toEqual(['bundled', 'bundled', 'imported']);
      expect(all[2]).toEqual(
        expect.objectContaining({ name: 'My Weekend Loop', lengthKm: 42.5 }),
      );
    });

    it('is just the bundled list when nothing has been imported', async () => {
      await expect(listAllTrails()).resolves.toHaveLength(2);
    });

    it('degrades to the bundled list when the database is unavailable', async () => {
      mockGetDatabase.mockRejectedValue(new Error('disk I/O error'));
      const all = await listAllTrails();
      expect(all.map((t) => t.id)).toEqual(['bibbulmun', 'heysen']);
    });
  });

  describe('getTrailIndexEntryAsync', () => {
    it('answers bundled ids without a database round-trip', async () => {
      await expect(getTrailIndexEntryAsync('heysen')).resolves.toEqual(
        expect.objectContaining({ id: 'heysen', source: 'bundled' }),
      );
      expect(mockGetDatabase).not.toHaveBeenCalled();
    });

    it('reads an imported name from the registry', async () => {
      mockGetImported.mockResolvedValue(IMPORTED_ROW);
      await expect(getTrailIndexEntryAsync('u_abc123')).resolves.toEqual({
        id: 'u_abc123',
        name: 'My Weekend Loop',
        shortName: 'My Weekend Loop',
        lengthKm: 42.5,
        source: 'imported',
      });
    });

    it('returns null for an unknown id', async () => {
      await expect(getTrailIndexEntryAsync('nope')).resolves.toBeNull();
    });

    it('returns null rather than throwing when the registry read fails', async () => {
      mockGetImported.mockRejectedValue(new Error('no such table'));
      await expect(getTrailIndexEntryAsync('u_abc123')).resolves.toBeNull();
    });
  });
  describe('over-the-air downloads', () => {
    beforeEach(() => {
      mockActiveDownload.mockImplementation((id: string) =>
        id === 'heysen' ? HEYSEN_DOWNLOAD : null,
      );
    });

    it('getTrailJson returns null while a download supersedes the bundle', () => {
      expect(getTrailJson('heysen')).toBeNull();
      // Untouched trails still resolve synchronously.
      expect(getTrailJson('bibbulmun')?.config.id).toBe('bibbulmun');
    });

    it('getBundledTrailJson ignores downloads', () => {
      expect(getBundledTrailJson('heysen')).toBe(HEYSEN_JSON);
      expect(getBundledTrailJson('gamma')).toBeNull();
    });

    it('loadTrail prefers the downloaded copy', async () => {
      mockReadDownloaded.mockResolvedValue(HEYSEN_DOWNLOADED_JSON);
      await expect(loadTrail('heysen')).resolves.toBe(HEYSEN_DOWNLOADED_JSON);
      expect(mockReadDownloaded).toHaveBeenCalledWith('heysen');
      expect(mockReadImported).not.toHaveBeenCalled();
    });

    it('loadTrail falls back to the bundle when the download cannot be read', async () => {
      mockReadDownloaded.mockResolvedValue(null);
      await expect(loadTrail('heysen')).resolves.toBe(HEYSEN_JSON);
      expect(mockReadImported).not.toHaveBeenCalled();
    });

    it('loadTrail resolves a downloaded catalog-only trail', async () => {
      const gammaJson = { ...HEYSEN_JSON, config: { ...HEYSEN_JSON.config, id: 'gamma' } };
      mockReadDownloaded.mockImplementation(async (id: string) => (id === 'gamma' ? gammaJson : null));
      await expect(loadTrail('gamma')).resolves.toBe(gammaJson);
      expect(mockReadImported).not.toHaveBeenCalled();
    });

    it('loadTrail is null for a catalog-only trail not downloaded yet', async () => {
      await expect(loadTrail('gamma')).resolves.toBeNull();
    });

    it("listTrails reports a newer download's name and length, still as bundled", () => {
      const heysen = listTrails().find((t) => t.id === 'heysen');
      expect(heysen).toEqual({
        id: 'heysen',
        name: 'Heysen Trail (rerouted)',
        shortName: 'Heysen',
        lengthKm: 1210.5,
        dataVersion: '2026-10-01',
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'bundled',
      });
      expect(listTrails().find((t) => t.id === 'bibbulmun')?.name).toBe('Bibbulmun Track');
    });

    it("getTrailIndexEntry overlays a newer download's metadata", () => {
      expect(getTrailIndexEntry('heysen')).toEqual(
        expect.objectContaining({ name: 'Heysen Trail (rerouted)', lengthKm: 1210.5, source: 'bundled' }),
      );
      // Bundled ids never fall through to the catalog lookup.
      expect(mockGetRemoteTrail).not.toHaveBeenCalled();
    });

    it('getTrailIndexEntry answers a catalog-only trail as remote', () => {
      mockGetRemoteTrail.mockImplementation((id: string) => (id === 'gamma' ? GAMMA_REMOTE : null));
      expect(getTrailIndexEntry('gamma')).toEqual({
        id: 'gamma',
        name: 'Gamma Way',
        shortName: 'Gamma',
        lengthKm: 77,
        updatedAt: '2026-10-02T00:00:00.000Z',
        source: 'remote',
        downloaded: false,
      });
    });

    it('getTrailIndexEntryAsync answers a catalog-only trail without the database', async () => {
      mockGetRemoteTrail.mockImplementation((id: string) =>
        id === 'gamma' ? { ...GAMMA_REMOTE, downloaded: true } : null,
      );
      await expect(getTrailIndexEntryAsync('gamma')).resolves.toEqual(
        expect.objectContaining({ id: 'gamma', source: 'remote', downloaded: true }),
      );
      expect(mockGetDatabase).not.toHaveBeenCalled();
    });

    it('listAllTrails puts catalog-only trails between bundled and imported', async () => {
      mockListRemoteTrails.mockReturnValue([
        GAMMA_REMOTE,
        { ...GAMMA_REMOTE, id: 'delta', name: 'Delta Route', downloaded: true },
      ]);
      mockListImported.mockResolvedValue([IMPORTED_ROW]);

      const all = await listAllTrails();

      expect(all.map((t) => t.id)).toEqual(['bibbulmun', 'heysen', 'gamma', 'delta', 'u_abc123']);
      expect(all.map((t) => t.source)).toEqual(['bundled', 'bundled', 'remote', 'remote', 'imported']);
      expect(all.map((t) => t.downloaded)).toEqual([undefined, undefined, false, true, undefined]);
      expect(all[1].name).toBe('Heysen Trail (rerouted)');
      // The version fields the list does not show stay out of the index entry.
      expect(all[2]).not.toHaveProperty('md5');
      expect(all[2]).not.toHaveProperty('bytes');
    });

    it('listAllTrails keeps catalog-only trails when the database is unavailable', async () => {
      mockListRemoteTrails.mockReturnValue([GAMMA_REMOTE]);
      mockGetDatabase.mockRejectedValue(new Error('disk I/O error'));
      const all = await listAllTrails();
      expect(all.map((t) => t.id)).toEqual(['bibbulmun', 'heysen', 'gamma']);
    });
  });
});
