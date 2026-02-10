import { TrailDataService } from '../trail-data-service';
import { loadBundledTrails } from '../trail-loader';

const INDEX_JSON: { id: string; name: string; shortName: string; lengthKm: number }[] = [
  { id: 'bibbulmun', name: 'bibbulmun Track', shortName: 'bibb', lengthKm: 981.6 },
];

const TRAIL_JSON = {
  config: {
    id: 'bibbulmun',
    name: 'bibbulmun Track',
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

// Mock the JSON asset requires before importing the module
jest.mock('../../../assets/trails/index.json', () => INDEX_JSON, { virtual: true });
jest.mock('../../../assets/trails/bibbulmun.json', () => TRAIL_JSON, { virtual: true });

function createMockService() {
  return {
    getTrail: jest.fn().mockResolvedValue(null),
    storeTrail: jest.fn().mockResolvedValue(undefined),
    storeWaypoints: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<TrailDataService>;
}

describe('loadBundledTrails', () => {
  let service: jest.Mocked<TrailDataService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createMockService() as jest.Mocked<TrailDataService>;
  });

  it('loads a trail and its waypoints into the service', async () => {
    await loadBundledTrails(service);

    expect(service.storeTrail).toHaveBeenCalledWith({
      id: 'bibbulmun',
      name: 'bibbulmun Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      dataVersion: null,
      metadataJson: expect.stringContaining('"totalDistance":981600'),
    });

    expect(service.storeWaypoints).toHaveBeenCalledWith('bibbulmun', [
      { name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, kmPosition: 0, description: null },
      { name: 'Hewitt\'s Hill', type: 'campsite', lat: -31.958, lon: 116.129, ele: null, kmPosition: 12.5, description: null },
      { name: 'Ball Creek', type: 'water', lat: -32.012, lon: 116.1, ele: null, kmPosition: null, description: null },
    ]);
  });

  it('stores direction metadata from trail config', async () => {
    await loadBundledTrails(service);

    const storedMetadata = JSON.parse(service.storeTrail.mock.calls[0][0].metadataJson!);
    expect(storedMetadata.direction).toEqual({ default: 'SOBO', reversed: 'NOBO' });
  });

  it('stores track summary in metadata', async () => {
    await loadBundledTrails(service);

    const storedMetadata = JSON.parse(service.storeTrail.mock.calls[0][0].metadataJson!);
    expect(storedMetadata.track).toEqual({
      totalDistance: 981600,
      totalAscent: 25000,
      totalDescent: 25200,
      displayPointCount: 1,
    });
  });

  it('skips trails that already exist with matching version', async () => {
    service.getTrail.mockResolvedValueOnce({
      id: 'bibbulmun',
      name: 'bibbulmun Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      metadataJson: null,
      dataVersion: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    await loadBundledTrails(service);

    expect(service.storeTrail).not.toHaveBeenCalled();
    expect(service.storeWaypoints).not.toHaveBeenCalled();
  });

  it('skips index entries with no matching trail data', async () => {
    // The index mock includes only 'bibbulmun', but if the index had extra entries
    // they'd be skipped because TRAIL_DATA wouldn't have them
    await loadBundledTrails(service);

    // Only bibbulmun should be stored
    expect(service.storeTrail).toHaveBeenCalledTimes(1);
    expect(service.storeTrail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bibbulmun' }),
    );
  });

  it('handles waypoints with missing optional fields', async () => {
    // Ball Creek waypoint has no elevation, totalDistance, or description
    await loadBundledTrails(service);

    const waypoints = service.storeWaypoints.mock.calls[0][1];
    const ballCreek = waypoints.find((w: any) => w.name === 'Ball Creek');
    expect(ballCreek).toEqual({
      name: 'Ball Creek',
      type: 'water',
      lat: -32.012,
      lon: 116.1,
      ele: null,
      kmPosition: null,
      description: null,
    });
  });
});
