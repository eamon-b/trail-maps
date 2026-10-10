import { buildPlannedRoute, type PlannableTrail } from '@lib/plan-alternates';
import type { TrailJson } from '../../../services/trail-assets';
import { resolveGuideTrail } from '../../guide/guide-trail';
import { findGuideWaypoint, waypointAlternates } from '../waypoint-alternates';

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

const point = (km: number, lat = 0) => ({ lat, lon: km * DEG_PER_KM, ele: 100, dist: km });
const wp = (id: string, name: string, km: number, type = 'campsite') => ({
  id,
  name,
  type,
  lat: 0,
  lon: km * DEG_PER_KM,
  totalDistance: km,
});
const altPoints = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ lat: 0.01, lon: (from + i) * DEG_PER_KM, ele: 100 }));

/**
 * A 100 km trail with two overlapping alternates off the main route (Ridge,
 * km 20-40, and Valley, km 30-50) and one that hangs off Ridge.
 */
const stored = {
  config: { id: 'syn', name: 'Syn', shortName: 'Syn', region: '', lengthKm: 100, direction: { default: 'N', reversed: 'S' } },
  track: {
    points: Array.from({ length: 101 }, (_, km) => point(km)),
    totalDistance: 100,
    totalAscent: 0,
    totalDescent: 0,
  },
  waypoints: [
    wp('start', 'Start', 0, 'trailhead'),
    wp('fork', 'Fork Hut', 20, 'hut'),
    wp('mid', 'Mid Camp', 30),
    wp('join', 'Join Creek', 40, 'water'),
    wp('end', 'End', 100, 'trailhead'),
  ],
  alternates: [
    {
      name: 'Ridge',
      type: 'alternate',
      points: altPoints(20, 40),
      distance: 25,
      elevation: { ascent: 400, descent: 400 },
      startDistance: 20,
      endDistance: 40,
      waypoints: [wp('ridge-camp', 'Ridge Camp', 32)],
    },
    {
      name: 'Valley',
      type: 'alternate',
      points: altPoints(30, 50),
      distance: 18,
      startDistance: 30,
      endDistance: 50,
      waypoints: [wp('valley-hut', 'Valley Hut', 41, 'hut')],
    },
    {
      name: 'Summit spur',
      type: 'alternate',
      points: altPoints(25, 27),
      distance: 3,
      startDistance: 5,
      endDistance: 7,
      parent: { name: 'Ridge', index: 0 },
      waypoints: [wp('summit', 'Summit', 6, 'poi')],
    },
  ],
} as unknown as TrailJson;

const route = (names: string[]) => buildPlannedRoute(stored as unknown as PlannableTrail, names);
const cardsFor = (guide: TrailJson, id: string, names: string[] = []) =>
  waypointAlternates(guide, stored, route(names), findGuideWaypoint(guide, id)!);

describe('findGuideWaypoint', () => {
  it('finds the main route first, then alternates by id', () => {
    expect(findGuideWaypoint(stored, 'mid')).toMatchObject({ waypoint: { name: 'Mid Camp' }, alternateIndex: null });
    expect(findGuideWaypoint(stored, 'valley-hut')).toMatchObject({ waypoint: { name: 'Valley Hut' }, alternateIndex: 1 });
    expect(findGuideWaypoint(stored, 'nope')).toBeNull();
  });
});

describe('waypointAlternates', () => {
  it('says which alternate a place is on, where it leaves and rejoins, and how far along', () => {
    const [card] = cardsFor(stored, 'ridge-camp');
    expect(card).toMatchObject({
      role: 'on',
      name: 'Ridge',
      taken: false,
      leavesKm: 20,
      rejoinsKm: 40,
      leavesAt: { id: 'fork', name: 'Fork Hut' },
      rejoinsAt: { id: 'join', name: 'Join Creek' },
      kmAlong: 12,
      distanceKm: 25,
      replaces: [],
    });
    expect(card.plannable?.name).toBe('Ridge');
    expect(cardsFor(stored, 'ridge-camp', ['Ridge'])[0].taken).toBe(true);
  });

  it('names the taken alternate an untaken one would drop', () => {
    expect(cardsFor(stored, 'valley-hut', ['Ridge'])[0]).toMatchObject({ taken: false, replaces: ['Ridge'] });
  });

  it('marks the junctions on the main route', () => {
    expect(cardsFor(stored, 'fork').map((c) => [c.role, c.name])).toEqual([['leaves', 'Ridge']]);
    // Join Creek is where Ridge comes back, and Valley still runs past it untaken.
    expect(cardsFor(stored, 'join').map((c) => [c.role, c.name])).toEqual([['rejoins', 'Ridge']]);
    // Mid Camp is where Valley leaves.
    expect(cardsFor(stored, 'mid').map((c) => [c.role, c.name])).toEqual([['leaves', 'Valley']]);
  });

  it('says when the plan takes an alternate past a main-route place', () => {
    expect(cardsFor(stored, 'join', ['Valley']).map((c) => [c.role, c.name, c.taken])).toEqual([
      ['bypassed', 'Valley', true],
      ['rejoins', 'Ridge', false],
    ]);
    // Untaken, an alternate alongside a place says nothing about it.
    expect(cardsFor(stored, 'start', ['Valley'])).toEqual([]);
  });

  it('offers no choice for an alternate off another alternate', () => {
    const [card] = cardsFor(stored, 'summit');
    expect(card).toMatchObject({ role: 'on', plannable: null, parentName: 'Ridge', leavesKm: null, rejoinsKm: null });
  });

  it('reads the junctions in the direction walked', () => {
    const reversed = resolveGuideTrail(stored, 'reversed');
    const [card] = cardsFor(reversed, 'ridge-camp');
    // Walked south, Ridge leaves at km 60 (Join Creek) and rejoins at km 80
    // (Fork Hut); Ridge Camp is 13 km along it from that end.
    expect(card).toMatchObject({
      leavesKm: 60,
      rejoinsKm: 80,
      leavesAt: { name: 'Join Creek' },
      rejoinsAt: { name: 'Fork Hut' },
    });
    expect(card.kmAlong).toBeCloseTo(13);
    // Same plannable alternate as stored, so the choice means the same.
    expect(card.plannable?.name).toBe('Ridge');
  });
});
