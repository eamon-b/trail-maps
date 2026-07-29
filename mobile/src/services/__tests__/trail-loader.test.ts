import {
  listTrails,
  getTrailIndexEntry,
  getTrailJson,
  hasTrail,
} from '../trail-loader';

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
});
