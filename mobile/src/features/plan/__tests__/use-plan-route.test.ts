import type { PlannedRoute } from '@lib/plan-alternates';
import type { TrailJson } from '../../../services/trail-assets';
import { routeKmOfFix } from '../use-plan-route';

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

/** A 50 km route due east along the equator, a point per km. */
const routeTrail = {
  track: {
    points: Array.from({ length: 51 }, (_, km) => ({ lat: 0, lon: km * DEG_PER_KM, ele: 0, dist: km })),
    totalDistance: 50,
  },
} as unknown as TrailJson;

const withAlternate = { alternates: [{ name: 'Alt' }] } as unknown as PlannedRoute;
const mainOnly = { alternates: [] } as unknown as PlannedRoute;

describe('routeKmOfFix', () => {
  it('uses the guide snap when the plan takes no alternate', () => {
    expect(routeKmOfFix({ status: 'fix', currentKm: 12, position: null }, mainOnly, routeTrail)).toBe(12);
    expect(routeKmOfFix({ status: 'off-trail', currentKm: 12, position: null }, mainOnly, routeTrail)).toBeNull();
  });

  it('snaps the fix to the planned route when it takes one', () => {
    // The guide reads main-route km 40 (or calls the hiker off it); the planned
    // route puts the same place at km 20.
    const fix = { lat: 0, lon: 20 * DEG_PER_KM };
    expect(routeKmOfFix({ status: 'fix', currentKm: 40, position: fix }, withAlternate, routeTrail)).toBeCloseTo(20);
    expect(routeKmOfFix({ status: 'off-trail', currentKm: 40, position: fix }, withAlternate, routeTrail)).toBeCloseTo(20);
  });

  it('is null for a fix off the planned route, or no fix', () => {
    const far = { lat: 5 * DEG_PER_KM, lon: 20 * DEG_PER_KM };
    expect(routeKmOfFix({ status: 'fix', currentKm: 20, position: far }, withAlternate, routeTrail)).toBeNull();
    expect(routeKmOfFix({ status: 'acquiring', currentKm: null, position: null }, withAlternate, routeTrail)).toBeNull();
  });
});
