/**
 * Route service tests (P1 PR D): CRUD against real SQLite, leg metric
 * assembly (on-track, off-track, mixed), deletion survival via the
 * denormalized km fallback, and the GPX export golden.
 */
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { TestDatabase } from '../../db/__tests__/sqlite-test-adapter';
import {
  RouteService,
  resolveRoutePoints,
  assembleRouteMetrics,
  routeOverlayGeometry,
  waypointToRoutePoint,
  OFF_TRACK_LEG_THRESHOLD_M,
} from '../route-service';
import { routeToGpx } from '../../lib/gpx-writer';
import type { Trail, TrackPoint, TrailWaypoint } from '../../lib/trail-utils';

// Mock trail-loader to avoid bundled asset imports (route-service pulls in
// trail-utils only, but keep parity with the other service tests).
jest.mock('../trail-loader', () => ({
  TRAIL_DATA: {},
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrackPoints(): TrackPoint[] {
  const points: TrackPoint[] = [];
  // 20 km north-south track: 0.009° lat ≈ 1 km, gaining 10 m per km
  for (let i = 0; i <= 20; i++) {
    points.push({ lat: -35 - i * 0.009, lon: 138, ele: 100 + i * 10, dist: i });
  }
  return points;
}

function makeWaypoint(overrides: Partial<TrailWaypoint> & { id: string; name: string }): TrailWaypoint {
  return {
    lat: -35,
    lon: 138,
    type: 'poi',
    totalDistance: 0,
    ...overrides,
  };
}

function makeTrail(): Trail {
  const points = makeTrackPoints();
  return {
    config: {
      id: 'test-trail',
      name: 'Test Trail',
      shortName: 'TT',
      region: 'SA',
      lengthKm: 20,
      direction: { default: 'NOBO', reversed: 'SOBO' },
    },
    track: { points, totalDistance: 20, totalAscent: 200, totalDescent: 0 },
    waypoints: [
      makeWaypoint({ id: 'wp-0', name: 'Trailhead', lat: -35, lon: 138, type: 'trailhead', elevation: 100, totalDistance: 0 }),
      makeWaypoint({ id: 'wp-1', name: 'Creek', lat: -35.045, lon: 138, type: 'water', elevation: 150, totalDistance: 5 }),
      makeWaypoint({ id: 'wp-2', name: 'Camp', lat: -35.09, lon: 138, type: 'campsite', elevation: 200, totalDistance: 10 }),
      // Genuinely off-track: ~900 m east of the km 15 point
      makeWaypoint({ id: 'custom-off', name: 'Off-track lookout', lat: -35.135, lon: 138.01, type: 'lookout', elevation: 240, totalDistance: 15, offTrackM: 910 }),
    ],
  };
}

// ---------------------------------------------------------------------------
// CRUD (real SQLite)
// ---------------------------------------------------------------------------

describe('RouteService CRUD', () => {
  let db: TestDatabase;
  let service: RouteService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new RouteService(db as any);
    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['test-trail', 'Test Trail']);
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('creates a route with ordered legs and reads them back', async () => {
    const route = await service.createRoute('test-trail', 'Water run', [
      { waypointRef: 'wp-0', kmPosition: 0 },
      { waypointRef: 'wp-1', kmPosition: 5 },
      { waypointRef: 'wp-2', kmPosition: 10 },
    ]);

    expect(route.id).toBeTruthy();
    expect(route.name).toBe('Water run');

    const listed = await service.listRoutes('test-trail');
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(route.id);

    const legs = await service.getRouteLegs(route.id);
    expect(legs.map(l => l.seq)).toEqual([0, 1, 2]);
    expect(legs.map(l => l.waypointRef)).toEqual(['wp-0', 'wp-1', 'wp-2']);
    expect(legs.map(l => l.kmPosition)).toEqual([0, 5, 10]);
  });

  it('lists all routes across trails when no trailId is given', async () => {
    await db.runAsync('INSERT INTO trails (id, name) VALUES (?, ?)', ['other', 'Other']);
    await service.createRoute('test-trail', 'A', [{ waypointRef: 'wp-0', kmPosition: 0 }]);
    await service.createRoute('other', 'B', [{ waypointRef: 'wp-1', kmPosition: 3 }]);

    const all = await service.listRoutes();
    expect(all).toHaveLength(2);
    const scoped = await service.listRoutes('other');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].name).toBe('B');
  });

  it('renames and deletes a route (legs cascade)', async () => {
    const route = await service.createRoute('test-trail', 'Old name', [
      { waypointRef: 'wp-0', kmPosition: 0 },
      { waypointRef: 'wp-1', kmPosition: 5 },
    ]);

    await service.renameRoute(route.id, 'New name');
    expect((await service.getRoute(route.id))!.name).toBe('New name');

    await service.deleteRoute(route.id);
    expect(await service.getRoute(route.id)).toBeNull();
    expect(await db.getAllAsync('SELECT * FROM route_legs')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Resolution + metrics assembly (pure)
// ---------------------------------------------------------------------------

describe('resolveRoutePoints', () => {
  const trail = makeTrail();

  it('resolves waypoint refs to live positions and names', () => {
    const points = resolveRoutePoints(trail, [
      { seq: 0, waypointRef: 'wp-0', kmPosition: 0 },
      { seq: 1, waypointRef: 'wp-1', kmPosition: 5 },
    ]);
    expect(points[0]).toMatchObject({ name: 'Trailhead', km: 0, deleted: false, offTrack: false });
    expect(points[1]).toMatchObject({ name: 'Creek', km: 5, deleted: false });
  });

  it('flags off-track waypoints beyond the threshold', () => {
    const points = resolveRoutePoints(trail, [
      { seq: 0, waypointRef: 'custom-off', kmPosition: 15 },
    ]);
    expect(points[0].offTrack).toBe(true);
    expect(points[0].name).toBe('Off-track lookout');
  });

  it('survives waypoint deletion via the denormalized km fallback', () => {
    const points = resolveRoutePoints(trail, [
      { seq: 0, waypointRef: 'custom-gone', kmPosition: 10 },
    ]);
    expect(points[0].deleted).toBe(true);
    expect(points[0].name).toBe('(deleted waypoint)');
    // Geometry preserved: the point sits on the track at km 10
    expect(points[0].km).toBe(10);
    expect(points[0].lat).toBeCloseTo(-35.09, 5);
  });

  it('mirrors the km fallback when the trail is displayed reversed', () => {
    const points = resolveRoutePoints(trail, [
      { seq: 0, waypointRef: null, kmPosition: 5 },
    ], { reversed: true });
    // Base km 5 on a 20 km trail = active km 15 when reversed
    expect(points[0].km).toBe(15);
  });
});

describe('assembleRouteMetrics', () => {
  const trail = makeTrail();

  it('computes on-track legs via measureBetweenPoints', () => {
    const points = [
      waypointToRoutePoint(trail.waypoints[0], 0), // km 0
      waypointToRoutePoint(trail.waypoints[1], 1), // km 5
      waypointToRoutePoint(trail.waypoints[2], 2), // km 10
    ];
    const metrics = assembleRouteMetrics(trail, points);

    expect(metrics.legs).toHaveLength(2);
    expect(metrics.legs[0].straightLine).toBe(false);
    expect(metrics.legs[0].distanceKm).toBeCloseTo(5, 1);
    expect(metrics.legs[0].ascentM).toBeCloseTo(50, 0); // 10 m per km
    expect(metrics.legs[0].waterSourceCount).toBe(1); // Creek at km 5 (inclusive end)
    expect(metrics.totalKm).toBeCloseTo(10, 1);
    expect(metrics.totalHours).toBeGreaterThan(0);
  });

  it('makes legs touching an off-track point straight-line (flagged)', () => {
    const points = [
      waypointToRoutePoint(trail.waypoints[2], 0), // Camp, km 10, on-track
      waypointToRoutePoint(trail.waypoints[3], 1), // Off-track lookout
    ];
    const metrics = assembleRouteMetrics(trail, points);

    expect(metrics.legs[0].straightLine).toBe(true);
    // Straight-line ≈ 5 km south + ~0.9 km east ≈ 5.1 km — well under the
    // 5+ km the on-track measure would report between km 10 and 15 plus spur
    expect(metrics.legs[0].distanceKm).toBeGreaterThan(4.5);
    expect(metrics.legs[0].distanceKm).toBeLessThan(5.6);
    expect(metrics.legs[0].ascentM).toBe(0);
    expect(metrics.legs[0].waterSourceCount).toBe(0);
  });

  it('handles mixed routes: on-track and straight-line legs sum into totals', () => {
    const points = [
      waypointToRoutePoint(trail.waypoints[0], 0), // km 0
      waypointToRoutePoint(trail.waypoints[2], 1), // km 10 (on-track leg)
      waypointToRoutePoint(trail.waypoints[3], 2), // off-track (straight leg)
    ];
    const metrics = assembleRouteMetrics(trail, points);

    expect(metrics.legs).toHaveLength(2);
    expect(metrics.legs[0].straightLine).toBe(false);
    expect(metrics.legs[1].straightLine).toBe(true);
    expect(metrics.totalKm).toBeCloseTo(metrics.legs[0].distanceKm + metrics.legs[1].distanceKm, 5);
  });

  it('uses the off-track threshold constant, not the 25 m connector one', () => {
    const near = makeWaypoint({ id: 'x', name: 'Near track', totalDistance: 3, offTrackM: OFF_TRACK_LEG_THRESHOLD_M });
    expect(waypointToRoutePoint(near, 0).offTrack).toBe(false);
    const far = makeWaypoint({ id: 'y', name: 'Far', totalDistance: 3, offTrackM: OFF_TRACK_LEG_THRESHOLD_M + 1 });
    expect(waypointToRoutePoint(far, 0).offTrack).toBe(true);
  });
});

describe('routeOverlayGeometry', () => {
  const trail = makeTrail();

  it('splits legs into track spans and straight lines', () => {
    const points = [
      waypointToRoutePoint(trail.waypoints[0], 0),
      waypointToRoutePoint(trail.waypoints[2], 1),
      waypointToRoutePoint(trail.waypoints[3], 2),
    ];
    const overlay = routeOverlayGeometry(points);

    expect(overlay.spans).toEqual([{ startKm: 0, endKm: 10 }]);
    expect(overlay.straightLegs).toHaveLength(1);
    expect(overlay.straightLegs[0].from).toEqual([trail.waypoints[2].lat, trail.waypoints[2].lon]);
    expect(overlay.straightLegs[0].to).toEqual([trail.waypoints[3].lat, trail.waypoints[3].lon]);
  });

  it('normalizes backwards spans (return legs)', () => {
    const points = [
      waypointToRoutePoint(trail.waypoints[2], 0), // km 10
      waypointToRoutePoint(trail.waypoints[1], 1), // km 5 — walking back
    ];
    const overlay = routeOverlayGeometry(points);
    expect(overlay.spans).toEqual([{ startKm: 5, endKm: 10 }]);
  });
});

// ---------------------------------------------------------------------------
// Export golden
// ---------------------------------------------------------------------------

describe('route GPX export', () => {
  it('serializes resolved route points as a <rte> golden file', () => {
    const trail = makeTrail();
    const points = [
      waypointToRoutePoint(trail.waypoints[0], 0),
      waypointToRoutePoint(trail.waypoints[1], 1),
    ];
    const gpx = routeToGpx('Water run', points.map(pt => ({
      lat: pt.lat, lon: pt.lon, ele: pt.ele, name: pt.name,
    })));

    expect(gpx).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Trail Companion" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata>',
      '    <name>Water run</name>',
      '  </metadata>',
      '  <rte>',
      '    <name>Water run</name>',
      '    <rtept lat="-35" lon="138">',
      '      <ele>100</ele>',
      '      <name>Trailhead</name>',
      '    </rtept>',
      '    <rtept lat="-35.045" lon="138">',
      '      <ele>150</ele>',
      '      <name>Creek</name>',
      '    </rtept>',
      '  </rte>',
      '</gpx>',
    ].join('\n'));
  });
});
