import { useRoutesStore } from '../routes-store';
import * as routesRepo from '../../../db/routes-repo';
import type { Route, RoutePoint } from '../../../db/routes-repo';

jest.mock('../../../db/database', () => ({
  getDatabase: jest.fn(async () => ({})),
}));

jest.mock('../../../db/routes-repo', () => ({
  listRoutes: jest.fn(),
  createRoute: jest.fn(),
  deleteRoute: jest.fn(),
  getRoutePoints: jest.fn(),
}));

const listRoutes = routesRepo.listRoutes as jest.Mock;
const createRoute = routesRepo.createRoute as jest.Mock;
const deleteRoute = routesRepo.deleteRoute as jest.Mock;
const getRoutePoints = routesRepo.getRoutePoints as jest.Mock;

const TRAIL = 'larapinta';

function route(id: string, name = id): Route {
  return {
    id,
    trailId: TRAIL,
    name,
    totalKm: 10,
    ascentM: 300,
    descentM: 200,
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
  };
}

const POINTS: RoutePoint[] = [
  { seq: 0, kind: 'snap', lat: -23.5, lon: 133.2, km: 0 },
  { seq: 1, kind: 'snap', lat: -23.6, lon: 133.3, km: 10 },
];

describe('routes-store', () => {
  beforeEach(() => {
    useRoutesStore.setState({ byTrail: {}, activeIdByTrail: {}, activePointsByTrail: {} });
    jest.clearAllMocks();
  });

  it('hydrates the route list for a trail', async () => {
    listRoutes.mockResolvedValue([route('r1'), route('r2')]);
    await useRoutesStore.getState().hydrate(TRAIL);
    expect(useRoutesStore.getState().byTrail[TRAIL]?.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('prepends a saved route to the list', async () => {
    useRoutesStore.setState({ byTrail: { [TRAIL]: [route('old')] } });
    createRoute.mockResolvedValue(route('new'));

    const saved = await useRoutesStore.getState().save({
      trailId: TRAIL,
      name: 'new',
      totalKm: 10,
      ascentM: 300,
      descentM: 200,
      points: [],
    });

    expect(saved.id).toBe('new');
    expect(useRoutesStore.getState().byTrail[TRAIL]?.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('activates a route by loading its points', async () => {
    getRoutePoints.mockResolvedValue(POINTS);
    await useRoutesStore.getState().activate(TRAIL, 'r1');

    expect(useRoutesStore.getState().activeIdByTrail[TRAIL]).toBe('r1');
    expect(useRoutesStore.getState().activePointsByTrail[TRAIL]).toEqual(POINTS);
    expect(getRoutePoints).toHaveBeenCalledWith(expect.anything(), 'r1');
  });

  it('clears the active route without touching the DB', async () => {
    useRoutesStore.setState({
      activeIdByTrail: { [TRAIL]: 'r1' },
      activePointsByTrail: { [TRAIL]: POINTS },
    });

    await useRoutesStore.getState().activate(TRAIL, null);

    expect(useRoutesStore.getState().activeIdByTrail[TRAIL]).toBeNull();
    expect(useRoutesStore.getState().activePointsByTrail[TRAIL]).toBeUndefined();
    expect(getRoutePoints).not.toHaveBeenCalled();
  });

  it('removing the active route clears the active selection', async () => {
    useRoutesStore.setState({
      byTrail: { [TRAIL]: [route('r1'), route('r2')] },
      activeIdByTrail: { [TRAIL]: 'r1' },
      activePointsByTrail: { [TRAIL]: POINTS },
    });
    deleteRoute.mockResolvedValue(undefined);

    await useRoutesStore.getState().remove(TRAIL, 'r1');

    expect(useRoutesStore.getState().byTrail[TRAIL]?.map((r) => r.id)).toEqual(['r2']);
    expect(useRoutesStore.getState().activeIdByTrail[TRAIL]).toBeNull();
    expect(useRoutesStore.getState().activePointsByTrail[TRAIL]).toBeUndefined();
  });

  it('removing a non-active route leaves the active selection intact', async () => {
    useRoutesStore.setState({
      byTrail: { [TRAIL]: [route('r1'), route('r2')] },
      activeIdByTrail: { [TRAIL]: 'r1' },
      activePointsByTrail: { [TRAIL]: POINTS },
    });
    deleteRoute.mockResolvedValue(undefined);

    await useRoutesStore.getState().remove(TRAIL, 'r2');

    expect(useRoutesStore.getState().byTrail[TRAIL]?.map((r) => r.id)).toEqual(['r1']);
    expect(useRoutesStore.getState().activeIdByTrail[TRAIL]).toBe('r1');
  });
});
