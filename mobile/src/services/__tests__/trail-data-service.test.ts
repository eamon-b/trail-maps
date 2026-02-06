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
      id: 'bibbulmum',
      name: 'Bibbulmum Track',
      shortName: 'bibb',
      region: 'South West WA',
      lengthKm: 981.6,
      metadataJson: null,
    });

    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO trails'),
      expect.arrayContaining(['bibbulmum', 'Bibbulmum Track']),
    );
  });

  it('retrieves a trail by id', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({
      id: 'bibbulmum',
      name: 'Bibbulmum Track',
      short_name: 'bibb',
      region: 'South West WA',
      length_km: 981.6,
      metadata_json: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const trail = await service.getTrail('bibbulmum');
    expect(trail).not.toBeNull();
    expect(trail!.name).toBe('Bibbulmum Track');
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
      { id: 'bibbulmum', name: 'Bibbulmum Track', short_name: 'bibb', region: 'WA', length_km: 981, metadata_json: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
      { id: 'larapinta', name: 'Larapinta Trail', short_name: 'larapinta', region: 'NT', length_km: 230, metadata_json: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    ]);

    const trails = await service.listTrails();
    expect(trails).toHaveLength(2);
    expect(trails[0].id).toBe('bibbulmum');
    expect(trails[1].id).toBe('larapinta');
  });

  it('deletes a trail', async () => {
    await service.deleteTrail('bibbulmum');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      'DELETE FROM trails WHERE id = ?',
      ['bibbulmum'],
    );
  });

  it('stores and retrieves waypoints', async () => {
    await service.storeWaypoints('bibbulmum', [
      { name: 'Hewitt\'s Hill', type: 'campsite', lat: -31.958, lon: 116.129, ele: 280, kmPosition: 12.5, description: null },
      { name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, kmPosition: 0, description: 'Start' },
    ]);

    // Verify it deletes existing waypoints first
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      'DELETE FROM waypoints WHERE trail_id = ?',
      ['bibbulmum'],
    );

    // Verify inserts
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO waypoints'),
      expect.arrayContaining(['bibbulmum', 'Hewitt\'s Hill', 'campsite']),
    );
  });

  it('gets waypoints for a trail', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 1, trail_id: 'bibbulmum', name: 'Kalamunda', type: 'town', lat: -31.974, lon: 116.058, ele: 295, km_position: 0, description: 'Start' },
    ]);

    const waypoints = await service.getWaypoints('bibbulmum');
    expect(waypoints).toHaveLength(1);
    expect(waypoints[0].name).toBe('Kalamunda');
    expect(waypoints[0].trailId).toBe('bibbulmum');
  });

  it('returns empty array for unknown trail waypoints', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    const waypoints = await service.getWaypoints('nonexistent');
    expect(waypoints).toEqual([]);
  });
});
