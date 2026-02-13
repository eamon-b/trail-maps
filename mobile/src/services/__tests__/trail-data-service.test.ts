import { TrailDataService } from '../trail-data-service';

function createMockDb() {
  return {
    runAsync: jest.fn().mockResolvedValue({ changes: 1, lastInsertRowId: 1 }),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
    execAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

describe('TrailDataService', () => {
  let service: TrailDataService;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    service = new TrailDataService(mockDb as any);
  });

  it('stores a trail', async () => {
    await service.storeTrail({
      id: 'bibbulmun',
      name: 'bibbulmun Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      metadataJson: null,
      dataVersion: null,
      isCustom: false,
      sourceFilename: null,
    });

    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO trails'),
      expect.arrayContaining(['bibbulmun', 'bibbulmun Track']),
    );
  });

  it('retrieves a trail by id', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({
      id: 'bibbulmun',
      name: 'bibbulmun Track',
      short_name: 'bibb',
      region: 'South West WA',
      length_km: 981.6,
      metadata_json: null,
      data_version: null,
      is_custom: 0,
      source_filename: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const trail = await service.getTrail('bibbulmun');
    expect(trail).not.toBeNull();
    expect(trail!.name).toBe('bibbulmun Track');
    expect(trail!.shortName).toBe('bibb');
    expect(trail!.lengthKm).toBe(981.6);
  });

  it('returns null for unknown trail', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    const trail = await service.getTrail('nonexistent');
    expect(trail).toBeNull();
  });

  it('lists all trails', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'bibbulmun', name: 'bibbulmun Track', short_name: 'bibb', region: 'WA', length_km: 981, metadata_json: null, data_version: null, is_custom: 0, source_filename: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
      { id: 'larapinta', name: 'Larapinta Trail', short_name: 'larapinta', region: 'NT', length_km: 230, metadata_json: null, data_version: null, is_custom: 0, source_filename: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    ]);

    const trails = await service.listTrails();
    expect(trails).toHaveLength(2);
    expect(trails[0].id).toBe('bibbulmun');
    expect(trails[1].id).toBe('larapinta');
  });

  it('deletes a trail', async () => {
    await service.deleteTrail('bibbulmun');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      'DELETE FROM trails WHERE id = ?',
      ['bibbulmun'],
    );
  });

  it('stores and retrieves waypoints', async () => {
    await service.storeWaypoints('bibbulmun', [
      { name: 'Hewitt\'s Hill', type: 'campsite', lat: -31.958, lon: 116.129, ele: 280, kmPosition: 12.5, description: null },
      { name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, kmPosition: 0, description: 'Start' },
    ]);

    // Verify it deletes existing waypoints first
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      'DELETE FROM waypoints WHERE trail_id = ?',
      ['bibbulmun'],
    );

    // Verify inserts
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO waypoints'),
      expect.arrayContaining(['bibbulmun', 'Hewitt\'s Hill', 'campsite']),
    );
  });

  it('gets waypoints for a trail', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 1, trail_id: 'bibbulmun', name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, km_position: 0, description: 'Start' },
    ]);

    const waypoints = await service.getWaypoints('bibbulmun');
    expect(waypoints).toHaveLength(1);
    expect(waypoints[0].name).toBe('Kalamunda');
    expect(waypoints[0].trailId).toBe('bibbulmun');
  });

  it('returns empty array for unknown trail waypoints', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    const waypoints = await service.getWaypoints('nonexistent');
    expect(waypoints).toEqual([]);
  });
});
