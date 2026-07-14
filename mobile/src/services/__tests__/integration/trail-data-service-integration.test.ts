import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import { TrailDataService } from '../../trail-data-service';
import type { TestDatabase } from '../../../db/__tests__/sqlite-test-adapter';

// Mock trail-assets to avoid bundled asset imports
jest.mock('../../trail-assets', () => ({
  TRAIL_DATA: {},
}));

describe('TrailDataService integration', () => {
  let db: TestDatabase;
  let service: TrailDataService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new TrailDataService(db as any);
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('stores and retrieves a trail by ID', async () => {
    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail',
      shortName: 'HT',
      region: 'South Australia',
      lengthKm: 1200,
      metadataJson: null,
      dataVersion: '1.0',
      isCustom: false,
      sourceFilename: null,
    });

    const trail = await service.getTrail('heysen');
    expect(trail).not.toBeNull();
    expect(trail!.id).toBe('heysen');
    expect(trail!.name).toBe('Heysen Trail');
    expect(trail!.shortName).toBe('HT');
    expect(trail!.region).toBe('South Australia');
    expect(trail!.lengthKm).toBe(1200);
    expect(trail!.isCustom).toBe(false);
  });

  it('stores and retrieves waypoints for a trail', async () => {
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

    await service.storeWaypoints('heysen', [
      { name: 'Camp A', type: 'campsite', lat: -35.1, lon: 138.5, ele: 400, kmPosition: 10, description: null },
      { name: 'Water Creek', type: 'water', lat: -35.2, lon: 138.6, ele: 350, kmPosition: 25, description: 'Reliable' },
    ]);

    const waypoints = await service.getWaypoints('heysen');
    expect(waypoints).toHaveLength(2);
    expect(waypoints[0].name).toBe('Camp A');
    expect(waypoints[0].type).toBe('campsite');
    expect(waypoints[1].name).toBe('Water Creek');
    expect(waypoints[1].description).toBe('Reliable');
  });

  it('lists all trails', async () => {
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
    await service.storeTrail({
      id: 'bibbulmun',
      name: 'Bibbulmun Track',
      shortName: 'BT',
      region: 'WA',
      lengthKm: 1003,
      metadataJson: null,
      dataVersion: null,
      isCustom: false,
      sourceFilename: null,
    });

    const trails = await service.listTrails();
    expect(trails).toHaveLength(2);
    const names = trails.map(t => t.name);
    expect(names).toContain('Heysen Trail');
    expect(names).toContain('Bibbulmun Track');
  });

  it('deletes trail and cascades to waypoints', async () => {
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
    await service.storeWaypoints('heysen', [
      { name: 'Camp A', type: 'campsite', lat: -35.1, lon: 138.5, ele: 400, kmPosition: 10, description: null },
    ]);

    await service.deleteTrail('heysen');

    const trail = await service.getTrail('heysen');
    expect(trail).toBeNull();

    const waypoints = await service.getWaypoints('heysen');
    expect(waypoints).toHaveLength(0);
  });

  it('storeTrail with same ID replaces existing', async () => {
    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail',
      shortName: 'HT',
      region: 'SA',
      lengthKm: 1200,
      metadataJson: null,
      dataVersion: '1.0',
      isCustom: false,
      sourceFilename: null,
    });

    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail Updated',
      shortName: 'HT',
      region: 'South Australia',
      lengthKm: 1250,
      metadataJson: null,
      dataVersion: '2.0',
      isCustom: false,
      sourceFilename: null,
    });

    const trail = await service.getTrail('heysen');
    expect(trail!.name).toBe('Heysen Trail Updated');
    expect(trail!.lengthKm).toBe(1250);
    expect(trail!.dataVersion).toBe('2.0');
  });

  it('refreshing trail data (bumped dataVersion) preserves plans and custom waypoints', async () => {
    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail',
      shortName: 'HT',
      region: 'SA',
      lengthKm: 1200,
      metadataJson: null,
      dataVersion: '1.0',
      isCustom: false,
      sourceFilename: null,
    });

    // A user-created custom waypoint and a plan, both FK'd to the trail.
    await service.addCustomWaypoint({
      trailId: 'heysen',
      name: 'My spring',
      type: 'water',
      lat: -35,
      lon: 138,
      kmPosition: 42,
    });
    await db.runAsync(
      `INSERT INTO plans (id, trail_id, name, direction) VALUES (?, ?, ?, ?)`,
      ['plan-1', 'heysen', 'My thru-hike', 'NOBO'],
    );

    // Simulate a data refresh with a bumped dataVersion (the code path that
    // previously did INSERT OR REPLACE and cascade-deleted user data).
    await service.storeTrail({
      id: 'heysen',
      name: 'Heysen Trail',
      shortName: 'HT',
      region: 'SA',
      lengthKm: 1210,
      metadataJson: null,
      dataVersion: '2.0',
      isCustom: false,
      sourceFilename: null,
    });

    const trail = await service.getTrail('heysen');
    expect(trail!.dataVersion).toBe('2.0');
    expect(trail!.lengthKm).toBe(1210);

    // User data survives.
    const customWaypoints = await service.getCustomWaypoints('heysen');
    expect(customWaypoints).toHaveLength(1);
    expect(customWaypoints[0].name).toBe('My spring');

    const plans = await db.getAllAsync('SELECT * FROM plans WHERE trail_id = ?', ['heysen']);
    expect(plans).toHaveLength(1);
  });

  it('storeWaypoints replaces existing for trail', async () => {
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

    await service.storeWaypoints('heysen', [
      { name: 'Old WP', type: 'campsite', lat: -35, lon: 138, ele: 400, kmPosition: 10, description: null },
    ]);

    // Replace with new waypoints
    await service.storeWaypoints('heysen', [
      { name: 'New WP1', type: 'water', lat: -35.1, lon: 138.1, ele: 350, kmPosition: 15, description: null },
      { name: 'New WP2', type: 'town', lat: -35.2, lon: 138.2, ele: 300, kmPosition: 30, description: null },
    ]);

    const waypoints = await service.getWaypoints('heysen');
    expect(waypoints).toHaveLength(2);
    expect(waypoints[0].name).toBe('New WP1');
    expect(waypoints[1].name).toBe('New WP2');
  });

  it('stores and retrieves custom trail track data', async () => {
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

    const trackData = {
      config: {
        id: 'custom-1',
        name: 'My Custom Trail',
        shortName: 'MCT',
        region: 'Custom',
        lengthKm: 50,
        direction: { default: 'NOBO', reversed: 'SOBO' },
      },
      track: {
        points: [{ lat: -33, lon: 115, ele: 100, dist: 0 }],
        totalDistance: 50,
        totalAscent: 1000,
        totalDescent: 1000,
      },
      waypoints: [],
    };

    await service.storeCustomTrailData('custom-1', trackData as any);

    const retrieved = await service.getTrailTrackData('custom-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.config.name).toBe('My Custom Trail');
    expect(retrieved!.track.totalDistance).toBe(50);
  });
});
