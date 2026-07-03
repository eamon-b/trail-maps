/**
 * CRUD tests for TrailDataService custom waypoint methods, run against a real
 * in-memory SQLite database with the full migration chain applied.
 */
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { TestDatabase } from '../../db/__tests__/sqlite-test-adapter';
import { TrailDataService, CUSTOM_WAYPOINT_TYPES } from '../trail-data-service';

// Mock trail-loader to avoid bundled asset imports
jest.mock('../trail-loader', () => ({
  TRAIL_DATA: {},
}));

describe('TrailDataService custom waypoints', () => {
  let db: TestDatabase;
  let service: TrailDataService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new TrailDataService(db as any);
    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail',
      shortName: 'HT',
      region: 'SA',
      lengthKm: 1200,
      metadataJson: null,
      dataVersion: null,
      isCustom: false,
      sourceFilename: null,
    });
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('adds and retrieves a custom waypoint', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen',
      name: 'My spring',
      type: 'water',
      lat: -35.1234,
      lon: 138.5678,
      ele: 412,
      kmPosition: 42.3,
      offTrackM: 87,
      description: 'Reliable year round',
    });

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);

    const rows = await service.getCustomWaypoints('heysen');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(created);
  });

  it('generates unique ids for rapid successive adds', async () => {
    const a = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'A', lat: -35, lon: 138, kmPosition: 10,
    });
    const b = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'B', lat: -35, lon: 138, kmPosition: 20,
    });
    expect(a.id).not.toBe(b.id);
  });

  it('defaults type to water and nullable fields to null', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen',
      name: 'Unnamed source',
      lat: -35,
      lon: 138,
      kmPosition: 10,
    });

    expect(created.type).toBe('water');
    expect(created.ele).toBeNull();
    expect(created.offTrackM).toBeNull();
    expect(created.description).toBeNull();

    const [row] = await service.getCustomWaypoints('heysen');
    expect(row.type).toBe('water');
    expect(row.ele).toBeNull();
    expect(row.offTrackM).toBeNull();
    expect(row.description).toBeNull();
  });

  it('returns waypoints ordered by km_position', async () => {
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'Far', lat: -35, lon: 138, kmPosition: 90 });
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'Near', lat: -35, lon: 138, kmPosition: 5 });
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'Mid', lat: -35, lon: 138, kmPosition: 40 });

    const rows = await service.getCustomWaypoints('heysen');
    expect(rows.map(r => r.name)).toEqual(['Near', 'Mid', 'Far']);
  });

  it('scopes retrieval to the trail id', async () => {
    await service.storeTrail({
      id: 'bibbulmun', name: 'Bibbulmun Track', shortName: 'BT', region: 'WA',
      lengthKm: 1003, metadataJson: null, dataVersion: null, isCustom: false, sourceFilename: null,
    });
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'H spring', lat: -35, lon: 138, kmPosition: 10 });
    await service.addCustomWaypoint({ trailId: 'bibbulmun', name: 'B tank', lat: -32, lon: 116, kmPosition: 20 });

    const heysen = await service.getCustomWaypoints('heysen');
    expect(heysen).toHaveLength(1);
    expect(heysen[0].name).toBe('H spring');
  });

  it('updates editable fields and bumps updated_at', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'My spring', type: 'water', lat: -35, lon: 138, kmPosition: 10,
    });

    await service.updateCustomWaypoint(created.id, {
      name: 'Renamed spring',
      type: 'water-tank',
      description: 'Now a tank',
    });

    const [row] = await service.getCustomWaypoints('heysen');
    expect(row.name).toBe('Renamed spring');
    expect(row.type).toBe('water-tank');
    expect(row.description).toBe('Now a tank');
    // Unchanged fields preserved
    expect(row.kmPosition).toBe(10);
    expect(row.lat).toBe(-35);
    expect(row.createdAt).toBe(created.createdAt);
    expect(row.updatedAt >= created.updatedAt).toBe(true);
  });

  it('can null out optional fields via update', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'WP', lat: -35, lon: 138, kmPosition: 10, description: 'note',
    });

    await service.updateCustomWaypoint(created.id, { description: null });

    const [row] = await service.getCustomWaypoints('heysen');
    expect(row.description).toBeNull();
  });

  it('update with no fields is a no-op', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'WP', lat: -35, lon: 138, kmPosition: 10,
    });

    await expect(service.updateCustomWaypoint(created.id, {})).resolves.toBeUndefined();

    const [row] = await service.getCustomWaypoints('heysen');
    expect(row.updatedAt).toBe(created.updatedAt);
  });

  it('deletes a custom waypoint', async () => {
    const a = await service.addCustomWaypoint({ trailId: 'heysen', name: 'A', lat: -35, lon: 138, kmPosition: 10 });
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'B', lat: -35, lon: 138, kmPosition: 20 });

    await service.deleteCustomWaypoint(a.id);

    const rows = await service.getCustomWaypoints('heysen');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('B');
  });

  it('deleting the trail cascades to its custom waypoints', async () => {
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'A', lat: -35, lon: 138, kmPosition: 10 });

    await service.deleteTrail('heysen');

    const orphans = await db.getAllAsync('SELECT * FROM custom_waypoints');
    expect(orphans).toHaveLength(0);
  });

  it('exposes the four allowed picker types', () => {
    expect([...CUSTOM_WAYPOINT_TYPES]).toEqual(['water', 'water-tank', 'campsite', 'poi']);
  });
});
