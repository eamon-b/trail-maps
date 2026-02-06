import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { loadBundledTrails } from '../trail-loader';
import { TrailDataService } from '../trail-data-service';

const mockAsset = Asset as jest.Mocked<typeof Asset>;
const mockFs = FileSystem as jest.Mocked<typeof FileSystem>;

function createMockService() {
  return {
    getTrail: jest.fn().mockResolvedValue(null),
    storeTrail: jest.fn().mockResolvedValue(undefined),
    storeWaypoints: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<TrailDataService>;
}

const INDEX_JSON: Array<{ id: string; name: string; shortName: string; lengthKm: number }> = [
  { id: 'bibbulmum', name: 'Bibbulmum Track', shortName: 'bibb', lengthKm: 981.6 },
];

const TRAIL_JSON = {
  config: {
    id: 'bibbulmum',
    name: 'Bibbulmum Track',
    shortName: 'bibb',
    region: 'South West WA',
    lengthKm: 981.6,
    direction: { default: 'SOBO', reversed: 'NOBO' },
  },
  waypoints: [
    { name: 'Kalamunda', lat: -31.974, lon: 116.058, type: 'town', elevation: 295, totalDistance: 0 },
    { name: 'Hewitt\'s Hill', lat: -31.958, lon: 116.129, type: 'campsite', totalDistance: 12.5 },
    { name: 'Ball Creek', lat: -32.012, lon: 116.1, type: 'water' },
  ],
  track: {
    points: [],
    displayPoints: [{ lat: -31.974, lon: 116.058, ele: 295, dist: 0 }],
    totalDistance: 981600,
    totalAscent: 25000,
    totalDescent: 25200,
  },
};

function setupAssetMocks(indexJson: unknown, trailJson?: unknown) {
  // loadJsonAsset calls Asset.loadAsync then FileSystem.readAsStringAsync
  let callCount = 0;
  mockAsset.loadAsync.mockImplementation(async () => {
    callCount++;
    return [{ localUri: `/mock/assets/file-${callCount}.json` } as any];
  });

  if (trailJson) {
    mockFs.readAsStringAsync
      .mockResolvedValueOnce(JSON.stringify(indexJson))
      .mockResolvedValueOnce(JSON.stringify(trailJson));
  } else {
    mockFs.readAsStringAsync
      .mockResolvedValueOnce(JSON.stringify(indexJson));
  }
}

describe('loadBundledTrails', () => {
  let service: jest.Mocked<TrailDataService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createMockService() as jest.Mocked<TrailDataService>;
  });

  it('loads a trail and its waypoints into the service', async () => {
    setupAssetMocks(INDEX_JSON, TRAIL_JSON);

    await loadBundledTrails(service);

    expect(service.storeTrail).toHaveBeenCalledWith({
      id: 'bibbulmum',
      name: 'Bibbulmum Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      metadataJson: expect.stringContaining('"totalDistance":981600'),
    });

    expect(service.storeWaypoints).toHaveBeenCalledWith('bibbulmum', [
      { name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, kmPosition: 0, description: null },
      { name: 'Hewitt\'s Hill', type: 'campsite', lat: -31.958, lon: 116.129, ele: null, kmPosition: 12.5, description: null },
      { name: 'Ball Creek', type: 'water', lat: -32.012, lon: 116.1, ele: null, kmPosition: null, description: null },
    ]);
  });

  it('stores direction metadata from trail config', async () => {
    setupAssetMocks(INDEX_JSON, TRAIL_JSON);

    await loadBundledTrails(service);

    const storedMetadata = JSON.parse(service.storeTrail.mock.calls[0][0].metadataJson!);
    expect(storedMetadata.direction).toEqual({ default: 'SOBO', reversed: 'NOBO' });
  });

  it('stores track summary in metadata', async () => {
    setupAssetMocks(INDEX_JSON, TRAIL_JSON);

    await loadBundledTrails(service);

    const storedMetadata = JSON.parse(service.storeTrail.mock.calls[0][0].metadataJson!);
    expect(storedMetadata.track).toEqual({
      totalDistance: 981600,
      totalAscent: 25000,
      totalDescent: 25200,
      displayPointCount: 1,
    });
  });

  it('skips trails that already exist in the database', async () => {
    setupAssetMocks(INDEX_JSON);
    service.getTrail.mockResolvedValueOnce({
      id: 'bibbulmum',
      name: 'Bibbulmum Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      metadataJson: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    await loadBundledTrails(service);

    expect(service.storeTrail).not.toHaveBeenCalled();
    expect(service.storeWaypoints).not.toHaveBeenCalled();
  });

  it('skips index entries with no matching asset module', async () => {
    const indexWithUnknown = [
      ...INDEX_JSON,
      { id: 'unknown-trail', name: 'Unknown', shortName: 'unk', lengthKm: 100 },
    ];
    setupAssetMocks(indexWithUnknown, TRAIL_JSON);

    await loadBundledTrails(service);

    // Only bibbulmum should be stored, unknown-trail skipped
    expect(service.storeTrail).toHaveBeenCalledTimes(1);
    expect(service.storeTrail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bibbulmum' }),
    );
  });

  it('handles empty index gracefully', async () => {
    setupAssetMocks([]);

    await loadBundledTrails(service);

    expect(service.storeTrail).not.toHaveBeenCalled();
    expect(service.storeWaypoints).not.toHaveBeenCalled();
  });

  it('handles waypoints with missing optional fields', async () => {
    const trailWithMinimalWaypoints = {
      ...TRAIL_JSON,
      waypoints: [
        { name: 'Bare Minimum', lat: -32.0, lon: 116.0, type: 'poi' },
      ],
    };
    setupAssetMocks(INDEX_JSON, trailWithMinimalWaypoints);

    await loadBundledTrails(service);

    expect(service.storeWaypoints).toHaveBeenCalledWith('bibbulmum', [
      { name: 'Bare Minimum', type: 'poi', lat: -32.0, lon: 116.0, ele: null, kmPosition: null, description: null },
    ]);
  });

  it('propagates asset load errors', async () => {
    mockAsset.loadAsync.mockResolvedValueOnce([{ localUri: null } as any]);

    await expect(loadBundledTrails(service)).rejects.toThrow('Failed to load asset');
  });
});
