/**
 * CRUD tests for TrailDataService custom waypoint methods, run against a real
 * in-memory SQLite database with the full migration chain applied.
 */
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { TestDatabase } from '../../db/__tests__/sqlite-test-adapter';
import { TrailDataService, CUSTOM_WAYPOINT_TYPES } from '../trail-data-service';

// Mock trail-assets to avoid bundled asset imports
jest.mock('../trail-assets', () => ({
  TRAIL_DATA: {},
}));

// Spy the photo-file deletion so we can assert deleteTrail removes the files
// for its cascaded custom waypoints without touching the real filesystem.
const mockDeleteWaypointPhoto = jest.fn();
jest.mock('../waypoint-photo-service', () => ({
  deleteWaypointPhoto: (...args: unknown[]) => mockDeleteWaypointPhoto(...args),
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

  it('deleting the trail removes the photo files of its cascaded waypoints', async () => {
    mockDeleteWaypointPhoto.mockClear();
    await service.addCustomWaypoint({
      trailId: 'heysen', name: 'With photo', lat: -35, lon: 138, kmPosition: 10,
      photoUri: '/doc/waypoint-photos/a.jpg',
    });
    await service.addCustomWaypoint({
      trailId: 'heysen', name: 'Also photo', lat: -35, lon: 138, kmPosition: 20,
      photoUri: '/doc/waypoint-photos/b.jpg',
    });
    // A waypoint without a photo must not produce a delete call.
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'No photo', lat: -35, lon: 138, kmPosition: 30 });

    await service.deleteTrail('heysen');

    expect(mockDeleteWaypointPhoto).toHaveBeenCalledWith('/doc/waypoint-photos/a.jpg');
    expect(mockDeleteWaypointPhoto).toHaveBeenCalledWith('/doc/waypoint-photos/b.jpg');
    expect(mockDeleteWaypointPhoto).toHaveBeenCalledTimes(2);
  });

  it('exposes the expanded creatable picker types from the registry', () => {
    expect([...CUSTOM_WAYPOINT_TYPES]).toEqual([
      'water', 'water-tank', 'campsite', 'shelter', 'town', 'lookout', 'junction', 'hazard', 'poi',
    ]);
  });

  it('persists a hazard-typed waypoint end-to-end', async () => {
    await service.addCustomWaypoint({
      trailId: 'heysen', name: 'Washed-out crossing', type: 'hazard', lat: -35, lon: 138, kmPosition: 12,
    });
    const [row] = await service.getCustomWaypoints('heysen');
    expect(row.type).toBe('hazard');
  });

  it('persists and updates photoUri (migration 6)', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'Tank', type: 'water-tank', lat: -35, lon: 138, kmPosition: 10,
      photoUri: '/doc/waypoint-photos/a.jpg',
    });
    expect(created.photoUri).toBe('/doc/waypoint-photos/a.jpg');

    let row = await service.getCustomWaypoint(created.id);
    expect(row!.photoUri).toBe('/doc/waypoint-photos/a.jpg');

    await service.updateCustomWaypoint(created.id, { photoUri: null });
    row = await service.getCustomWaypoint(created.id);
    expect(row!.photoUri).toBeNull();
  });

  it('updates position fields together (Move pin)', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'Misplaced', lat: -35, lon: 138, kmPosition: 10, offTrackM: 12,
    });

    await service.updateCustomWaypoint(created.id, {
      lat: -35.5, lon: 138.5, ele: 300, kmPosition: 42.5, offTrackM: 250,
    });

    const row = await service.getCustomWaypoint(created.id);
    expect(row).toMatchObject({
      lat: -35.5, lon: 138.5, ele: 300, kmPosition: 42.5, offTrackM: 250,
      name: 'Misplaced',
    });
  });

  it('supports delete-then-undo via restoreCustomWaypoint with a stable id', async () => {
    const created = await service.addCustomWaypoint({
      trailId: 'heysen', name: 'Marked 14:05', type: 'poi', lat: -35, lon: 138,
      kmPosition: 10, offTrackM: 5, description: '±120 m fix',
      photoUri: '/doc/waypoint-photos/x.jpg',
    });

    // Delete (immediate, no confirm) …
    await service.deleteCustomWaypoint(created.id);
    expect(await service.getCustomWaypoint(created.id)).toBeNull();

    // … then undo restores the exact row, same id and timestamps.
    await service.restoreCustomWaypoint(created);
    const restored = await service.getCustomWaypoint(created.id);
    expect(restored).toEqual(created);
  });

  describe('getMergedTrail', () => {
    beforeEach(async () => {
      // A custom trail carries its own track_data_json, so getTrailTrackData
      // resolves it without needing bundled TRAIL_DATA.
      await service.storeTrail({
        id: 'custom-1',
        name: 'My Custom Trail',
        shortName: 'MCT',
        region: null,
        lengthKm: 50,
        metadataJson: null,
        dataVersion: null,
        isCustom: true,
        sourceFilename: 'my-trail.gpx',
      });
      await service.storeCustomTrailData('custom-1', {
        config: {
          id: 'custom-1',
          name: 'My Custom Trail',
          shortName: 'MCT',
          region: 'Custom',
          lengthKm: 50,
          direction: { default: 'NOBO', reversed: 'SOBO' },
        },
        track: {
          points: [
            { lat: -33, lon: 115, ele: 100, dist: 0 },
            { lat: -33.1, lon: 115.1, ele: 120, dist: 25 },
            { lat: -33.2, lon: 115.2, ele: 140, dist: 50 },
          ],
          totalDistance: 50,
          totalAscent: 40,
          totalDescent: 0,
        },
        waypoints: [
          { name: 'Start', type: 'trailhead', lat: -33, lon: 115, totalDistance: 0 },
        ],
      } as any);
    });

    it('returns the parsed trail with custom waypoints merged in', async () => {
      await service.addCustomWaypoint({
        trailId: 'custom-1',
        name: 'Hidden spring',
        type: 'water',
        lat: -33.15,
        lon: 115.15,
        kmPosition: 30,
      });

      const merged = await service.getMergedTrail('custom-1');
      expect(merged).not.toBeNull();

      const names = merged!.waypoints.map(w => w.name);
      expect(names).toContain('Start');
      expect(names).toContain('Hidden spring');

      const custom = merged!.waypoints.find(w => w.name === 'Hidden spring')!;
      expect(custom.id.startsWith('custom-')).toBe(true);
      expect(custom.totalDistance).toBe(30);
    });

    it('returns the base trail unchanged when there are no custom waypoints', async () => {
      const merged = await service.getMergedTrail('custom-1');
      expect(merged).not.toBeNull();
      expect(merged!.waypoints.map(w => w.name)).toEqual(['Start']);
    });

    it('returns null for an unknown trail', async () => {
      expect(await service.getMergedTrail('does-not-exist')).toBeNull();
    });
  });
});

describe('getAllCustomWaypoints (My data)', () => {
  let db: TestDatabase;
  let service: TrailDataService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new TrailDataService(db as any);
    for (const [id, name] of [['heysen', 'Heysen Trail'], ['bibbulmun', 'Bibbulmun Track']] as const) {
      await service.storeTrail({
        id, name, shortName: id.slice(0, 2).toUpperCase(), region: null, lengthKm: 100,
        metadataJson: null, dataVersion: null, isCustom: false, sourceFilename: null,
      });
    }
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('returns waypoints across trails, grouped by trail name then km', async () => {
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'H far', lat: -35, lon: 138, kmPosition: 90 });
    await service.addCustomWaypoint({ trailId: 'bibbulmun', name: 'B tank', lat: -32, lon: 116, kmPosition: 20 });
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'H near', lat: -35, lon: 138, kmPosition: 5 });

    const all = await service.getAllCustomWaypoints();
    expect(all.map(w => w.name)).toEqual(['B tank', 'H near', 'H far']);
    expect(all.map(w => w.trailName)).toEqual(['Bibbulmun Track', 'Heysen Trail', 'Heysen Trail']);
  });

  it('returns an empty list when there are no custom waypoints', async () => {
    expect(await service.getAllCustomWaypoints()).toEqual([]);
  });

  it('surfaces trail-delete cascades: the deleted trail\'s waypoints vanish from My data', async () => {
    await service.addCustomWaypoint({ trailId: 'heysen', name: 'H spring', lat: -35, lon: 138, kmPosition: 10 });
    await service.addCustomWaypoint({ trailId: 'bibbulmun', name: 'B tank', lat: -32, lon: 116, kmPosition: 20 });

    await service.deleteTrail('heysen');

    const all = await service.getAllCustomWaypoints();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('B tank');
  });
});
