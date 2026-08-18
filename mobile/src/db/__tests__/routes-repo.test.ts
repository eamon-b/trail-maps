import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as routesRepo from '../routes-repo';
import type { NewRoute } from '../routes-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const TRAIL = 'larapinta';

function sampleRoute(overrides: Partial<NewRoute> = {}): NewRoute {
  return {
    trailId: TRAIL,
    name: 'Day 1',
    totalKm: 12.5,
    ascentM: 480,
    descentM: 260,
    points: [
      { kind: 'snap', lat: -23.5, lon: 133.2, km: 0 },
      { kind: 'snap', lat: -23.6, lon: 133.3, km: 12.5 },
      { kind: 'sketch', lat: -23.7, lon: 133.4, km: null },
    ],
    ...overrides,
  };
}

describe('routes-repo', () => {
  it('creates a route with its ordered points and reads them back', async () => {
    const d = await db();
    const route = await routesRepo.createRoute(d, sampleRoute());

    expect(route.id).toMatch(/^r_/);
    expect(route.totalKm).toBe(12.5);
    expect(route.ascentM).toBe(480);

    const stored = await routesRepo.getRoute(d, route.id);
    expect(stored?.name).toBe('Day 1');
    expect(stored?.descentM).toBe(260);

    const points = await routesRepo.getRoutePoints(d, route.id);
    expect(points.map((p) => p.kind)).toEqual(['snap', 'snap', 'sketch']);
    expect(points[0].km).toBe(0);
    expect(points[2].km).toBeNull();
    expect(points.map((p) => p.seq)).toEqual([0, 1, 2]);
  });

  it('lists routes newest-first, scoped by trail', async () => {
    const d = await db();
    const a = await routesRepo.createRoute(d, sampleRoute({ name: 'A' }));
    const b = await routesRepo.createRoute(d, sampleRoute({ name: 'B' }));
    await routesRepo.createRoute(d, sampleRoute({ trailId: 'heysen', name: 'Other' }));

    const list = await routesRepo.listRoutes(d, TRAIL);
    expect(list.map((r) => r.name)).toEqual(['B', 'A']);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);

    const other = await routesRepo.listRoutes(d, 'heysen');
    expect(other.map((r) => r.name)).toEqual(['Other']);
  });

  it('deletes a route and cascades its points', async () => {
    const d = await db();
    const route = await routesRepo.createRoute(d, sampleRoute());

    await routesRepo.deleteRoute(d, route.id);

    expect(await routesRepo.getRoute(d, route.id)).toBeNull();
    expect(await routesRepo.getRoutePoints(d, route.id)).toEqual([]);
    expect(await routesRepo.listRoutes(d, TRAIL)).toEqual([]);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => routesRepo.generateRouteId()));
    expect(ids.size).toBe(50);
  });
});
