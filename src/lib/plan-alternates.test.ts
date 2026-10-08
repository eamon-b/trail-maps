import { describe, expect, it } from 'vitest';
import {
  alternateKmToRoute,
  alternateMarkers,
  buildPlannedRoute,
  editPlanOnRoute,
  mainKmToRoute,
  plannableAlternates,
  plannedRouteTrail,
  planFromRoute,
  planToRoute,
  routeKmToPlan,
  setPlanAlternate,
  type PlannableTrail,
  type PlannableVariant,
} from './plan-alternates';
import {
  assertPlanDocumentWithinLimits,
  computePlanDays,
  isPlanDocument,
  setNights,
  toggleStop,
} from './plan-editor';
import { createReversedTrail } from './trail-reverse';
import type { PlanDocument, PlanStop } from './plan-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

/** A 100 km main route due east along the equator, a point per km, climbing 10 m a km. */
function mainPoints(withCumulative = false) {
  return Array.from({ length: 101 }, (_, km) => ({
    lat: 0,
    lon: km * DEG_PER_KM,
    ele: 100 + km * 10,
    dist: km,
    ...(withCumulative ? { cumAscent: km * 10, cumDescent: 0 } : {}),
  }));
}

/** An alternate off km 20 that rejoins at km 40, bowing north: 30 points up, then down. */
function bowAlternate(name = 'Alt: High Route', startKm = 20, endKm = 40): PlannableVariant {
  const points = [];
  for (let i = 0; i <= 30; i++) {
    const lon = (startKm + ((endKm - startKm) * i) / 30) * DEG_PER_KM;
    const lat = (i <= 15 ? i : 30 - i) * 0.5 * DEG_PER_KM;
    points.push({ lat, lon, ele: 300 + (i <= 15 ? i * 20 : (30 - i) * 20) });
  }
  return {
    name,
    type: 'alternate',
    points,
    distance: 30,
    elevation: { ascent: 300, descent: 300 },
    startDistance: startKm,
    endDistance: endKm,
    waypoints: [
      { id: 'w_shared', name: 'Shared Hut', type: 'hut', totalDistance: startKm + 25 },
      { id: 'w_altcamp', name: 'High Camp', type: 'campsite', totalDistance: startKm + 15 },
      { id: 'w_junction', name: 'Junction', type: 'junction', totalDistance: startKm },
    ],
  };
}

function trailFixture(extra: Partial<PlannableTrail> = {}, withCumulative = false) {
  return {
    config: { id: 'demo', name: 'Demo Track' },
    track: {
      points: mainPoints(withCumulative),
      displayPoints: mainPoints(withCumulative).filter((_, i) => i % 5 === 0),
      totalDistance: 100,
      totalAscent: 1000,
      totalDescent: 0,
    },
    waypoints: [
      { id: 'w_start', name: 'Start', type: 'trailhead', totalDistance: 0 },
      { id: 'w_camp10', name: 'Camp 10', type: 'campsite', totalDistance: 10 },
      { id: 'w_junction', name: 'Junction', type: 'junction', totalDistance: 20 },
      { id: 'w_shared', name: 'Shared Hut', type: 'hut', totalDistance: 30 },
      { id: 'w_camp35', name: 'Camp 35', type: 'campsite', totalDistance: 35 },
      { id: 'w_camp50', name: 'Camp 50', type: 'campsite', totalDistance: 50 },
      { id: 'w_end', name: 'End', type: 'trailhead', totalDistance: 100 },
    ],
    alternates: [bowAlternate()],
    sideTrips: [
      {
        name: 'Side: Lookout',
        type: 'side-trip',
        points: [{ lat: 0, lon: 60 * DEG_PER_KM, ele: 0 }, { lat: 0.01, lon: 60 * DEG_PER_KM, ele: 0 }],
        distance: 1.1,
        startDistance: 60,
        waypoints: [{ id: 'w_lookout', name: 'Lookout', type: 'poi', totalDistance: 61.1 }],
      },
    ],
    pois: [
      { distanceAlongTrail: 5 },
      { distanceAlongTrail: 30 },
      { distanceAlongTrail: 70 },
    ],
    ...extra,
  };
}

function stop(km: number, name: string, waypointId?: string, alternate?: string): PlanStop {
  return {
    km,
    name,
    nights: 1,
    ...(waypointId ? { waypointId } : {}),
    ...(alternate ? { alternate } : {}),
  };
}

function plan(stops: PlanStop[], alternates?: string[]): PlanDocument {
  return {
    id: 'plan-1',
    trailId: 'demo',
    name: 'Demo plan',
    direction: 'NOBO',
    startDate: null,
    stops,
    ...(alternates ? { alternates } : {}),
    updatedAt: '2026-10-01T00:00:00.000Z',
    version: 1,
  };
}

const ALT = 'Alt: High Route';
const now = () => '2026-10-02T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Which alternates can be planned
// ---------------------------------------------------------------------------

describe('plannableAlternates', () => {
  it('offers an alternate with both junctions on the main route', () => {
    const [option] = plannableAlternates(trailFixture());
    expect(option).toMatchObject({
      name: ALT,
      index: 0,
      startKm: 20,
      endKm: 40,
      distanceKm: 30,
      mainDistanceKm: 20,
      ascentM: 300,
      descentM: 300,
    });
  });

  it('leaves out one hanging off another alternate, or with one junction', () => {
    const trail = trailFixture({
      alternates: [
        bowAlternate(),
        { ...bowAlternate('Nested', 22, 30), parent: { name: ALT, index: 0 } },
        { ...bowAlternate('One end', 50, 60), endDistance: undefined },
        { ...bowAlternate('Later', 60, 70), type: 'side-trip' },
      ],
    });
    expect(plannableAlternates(trail).map(a => a.name)).toEqual([ALT]);
  });
});

// ---------------------------------------------------------------------------
// The route and its km
// ---------------------------------------------------------------------------

describe('buildPlannedRoute', () => {
  const trail = trailFixture();

  it('is the main route when nothing is taken', () => {
    const route = buildPlannedRoute(trail, []);
    expect(route.totalDistance).toBe(100);
    expect(route.segments).toHaveLength(1);
    expect(plannedRouteTrail(trail, route)).toBe(trail);
  });

  it('replaces the bypassed main route with the alternate', () => {
    const route = buildPlannedRoute(trail, [ALT, 'No such alternate']);
    expect(route.totalDistance).toBeCloseTo(110);
    expect(route.alternates.map(a => a.name)).toEqual([ALT]);
    expect(mainKmToRoute(route, 10)).toBe(10);
    expect(mainKmToRoute(route, 20)).toBe(20);
    expect(mainKmToRoute(route, 30)).toBeNull();
    expect(mainKmToRoute(route, 40)).toBeCloseTo(50);
    expect(mainKmToRoute(route, 50)).toBeCloseTo(60);
    expect(alternateKmToRoute(route, ALT, 35)).toBeCloseTo(35);
    expect(alternateKmToRoute(route, 'Other', 35)).toBeNull();
  });

  it('maps route km back to where a stop stores it, junctions on the main route', () => {
    const route = buildPlannedRoute(trail, [ALT]);
    expect(routeKmToPlan(route, 10)).toEqual({ km: 10 });
    expect(routeKmToPlan(route, 20)).toEqual({ km: 20 });
    expect(routeKmToPlan(route, 35)).toEqual({ km: 35, alternate: ALT });
    expect(routeKmToPlan(route, 50).km).toBeCloseTo(40);
    expect(routeKmToPlan(route, 50).alternate).toBeUndefined();
    expect(routeKmToPlan(route, 60).km).toBeCloseTo(50);
  });

  it('takes the first of two overlapping alternates', () => {
    const overlapping = trailFixture({
      alternates: [bowAlternate(), bowAlternate('Low Route', 30, 45)],
    });
    const route = buildPlannedRoute(overlapping, ['Low Route', ALT]);
    expect(route.alternates.map(a => a.name)).toEqual([ALT]);
  });
});

describe('plannedRouteTrail', () => {
  const trail = trailFixture();
  const route = buildPlannedRoute(trail, [ALT]);
  const routed = plannedRouteTrail(trail, route);

  it('runs the line main → alternate → main in route km', () => {
    const dists = routed.track.points.map(p => p.dist);
    expect(dists[0]).toBe(0);
    expect(dists[dists.length - 1]).toBeCloseTo(110);
    for (let i = 1; i < dists.length; i++) expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1]);
    expect(routed.track.totalDistance).toBeCloseTo(110);
    // Alternate's highest point is on the route now.
    expect(routed.track.points.some(p => p.ele === 600 && p.lat > 0)).toBe(true);
    expect(routed.track.displayPoints!.length).toBeLessThan(routed.track.points.length);
  });

  it('swaps the climb of the bypassed main route for the alternate\'s', () => {
    // Main: 1,000 m up all the way; 200 m of that is between km 20 and 40.
    expect(routed.track.totalAscent).toBe(1000 - 200 + 300);
    expect(routed.track.totalDescent).toBe(300);
  });

  it('lists the alternate\'s places in place of the bypassed ones', () => {
    const rows = (routed.waypoints ?? []).map(wp => [wp.name, wp.totalDistance]);
    expect(rows).toEqual([
      ['Start', 0],
      ['Camp 10', 10],
      ['Junction', 20],
      ['High Camp', 35],
      ['Shared Hut', 45],
      ['Camp 50', 60],
      ['End', 110],
    ]);
  });

  it('moves POIs and side trips, dropping the bypassed', () => {
    expect(routed.pois?.map(p => p.distanceAlongTrail)).toEqual([5, 80]);
    expect(routed.sideTrips?.[0].startDistance).toBeCloseTo(70);
    expect(routed.sideTrips?.[0].waypoints?.[0].totalDistance).toBeCloseTo(71.1);
    expect(routed.alternates).toEqual([]);
  });

  it('carries the cumulative climb pair through the splice', () => {
    const thin = trailFixture({}, true);
    const thinRouted = plannedRouteTrail(thin, buildPlannedRoute(thin, [ALT]));
    const last = thinRouted.track.points[thinRouted.track.points.length - 1];
    expect(last.cumAscent).toBeCloseTo(200 + 300 + 600);
    expect(last.cumDescent).toBeCloseTo(300);
  });

  it('reverses like any other trail', () => {
    const reversed = createReversedTrail(routed as unknown as Parameters<typeof createReversedTrail>[0]);
    expect(reversed.track.totalDistance).toBeCloseTo(110);
    expect((reversed.waypoints?.[0] as { name?: string }).name).toBe('End');
  });
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('planToRoute / planFromRoute', () => {
  const trail = trailFixture();

  it('is the identity for a plan on the main route', () => {
    const doc = plan([stop(10, 'Camp 10', 'w_camp10')]);
    const route = buildPlannedRoute(trail, doc.alternates);
    expect(planToRoute(doc, route)).toBe(doc);
  });

  it('round-trips a plan that takes an alternate', () => {
    const doc = plan(
      [stop(10, 'Camp 10', 'w_camp10'), stop(35, 'High Camp', 'w_altcamp', ALT), stop(50, 'Camp 50', 'w_camp50')],
      [ALT],
    );
    const route = buildPlannedRoute(trail, doc.alternates);
    const routePlan = planToRoute(doc, route);
    expect(routePlan.stops.map(s => [s.name, s.km])).toEqual([
      ['Camp 10', 10],
      ['High Camp', 35],
      ['Camp 50', 60],
    ]);
    expect(routePlan.stops.some(s => s.alternate !== undefined)).toBe(false);
    const back = planFromRoute(routePlan, route);
    expect(back.stops.map(s => [s.name, Math.round(s.km * 100) / 100, s.alternate])).toEqual([
      ['Camp 10', 10, undefined],
      ['High Camp', 35, ALT],
      ['Camp 50', 50, undefined],
    ]);
  });

  it('puts a stop on the alternate when it is ticked on the route', () => {
    const doc = plan([], [ALT]);
    const next = editPlanOnRoute(doc, trail, p =>
      toggleStop(p, { id: 'w_altcamp', km: 35, name: 'High Camp' }, { now, totalKm: 110 }),
    );
    expect(next.stops).toEqual([stop(35, 'High Camp', 'w_altcamp', ALT)]);
    expect(next.alternates).toEqual([ALT]);
    expect(() => assertPlanDocumentWithinLimits(next)).not.toThrow();
    expect(isPlanDocument(next)).toBe(true);
  });

  it('returns the stored plan for a no-op edit', () => {
    const doc = plan([stop(35, 'High Camp', 'w_altcamp', ALT)], [ALT]);
    expect(editPlanOnRoute(doc, trail, p => p)).toBe(doc);
    // An edit to the stop keeps it on the alternate.
    const edited = editPlanOnRoute(doc, trail, p => setNights(p, { waypointId: 'w_altcamp', km: 35 }, 2, { now }));
    expect(edited.stops[0]).toMatchObject({ alternate: ALT, nights: 2, km: 35 });
  });

  it('days are measured along the alternate', () => {
    const doc = plan([stop(35, 'High Camp', 'w_altcamp', ALT)], [ALT]);
    const route = buildPlannedRoute(trail, doc.alternates);
    const routed = plannedRouteTrail(trail, route);
    const days = computePlanDays(routed, planToRoute(doc, route), { baseKmh: 4 });
    expect(days.map(d => d.distanceKm)).toEqual([35, 75]);
    expect(days[0].endName).toBe('High Camp');
  });
});

describe('setPlanAlternate', () => {
  const trail = trailFixture();

  it('takes an alternate: bypassed stops go, shared places move onto it', () => {
    const doc = plan([
      stop(10, 'Camp 10', 'w_camp10'),
      stop(30, 'Shared Hut', 'w_shared'),
      stop(35, 'Camp 35', 'w_camp35'),
      stop(50, 'Camp 50', 'w_camp50'),
    ]);
    const next = setPlanAlternate(doc, trail, ALT, true, { now });
    expect(next.alternates).toEqual([ALT]);
    expect(next.stops.map(s => [s.name, s.km, s.alternate])).toEqual([
      ['Camp 10', 10, undefined],
      ['Shared Hut', 45, ALT],
      ['Camp 50', 50, undefined],
    ]);
    expect(next.updatedAt).toBe(now());
    expect(() => assertPlanDocumentWithinLimits(next)).not.toThrow();
  });

  it('goes back to the main route: alternate-only stops go, shared ones move back', () => {
    const doc = plan(
      [stop(35, 'High Camp', 'w_altcamp', ALT), stop(45, 'Shared Hut', 'w_shared', ALT), stop(50, 'Camp 50', 'w_camp50')],
      [ALT],
    );
    const next = setPlanAlternate(doc, trail, ALT, false, { now });
    expect(next.alternates).toBeUndefined();
    expect(next.stops.map(s => [s.name, s.km, s.alternate])).toEqual([
      ['Shared Hut', 30, undefined],
      ['Camp 50', 50, undefined],
    ]);
  });

  it('is a no-op for an alternate already taken, not taken, or unknown', () => {
    const doc = plan([], [ALT]);
    expect(setPlanAlternate(doc, trail, ALT, true)).toBe(doc);
    const empty = plan([]);
    expect(setPlanAlternate(empty, trail, ALT, false)).toBe(empty);
    expect(setPlanAlternate(empty, trail, 'Nope', true)).toBe(empty);
  });

  it('taking an alternate drops one it overlaps', () => {
    const overlapping = trailFixture({
      alternates: [bowAlternate(), bowAlternate('Low Route', 30, 45)],
    });
    const doc = plan([stop(35, 'High Camp', 'w_altcamp', ALT)], [ALT]);
    const next = setPlanAlternate(doc, overlapping, 'Low Route', true, { now });
    expect(next.alternates).toEqual(['Low Route']);
    // The fixture's Low Route has a High Camp of the same id, so the stop moves.
    expect(next.stops).toEqual([stop(45, 'High Camp', 'w_altcamp', 'Low Route')]);
  });
});

describe('alternateMarkers', () => {
  const trail = trailFixture();

  it('a branch card at the first junction met when the alternate is not taken', () => {
    const route = buildPlannedRoute(trail, []);
    expect(alternateMarkers(trail, route, 'NOBO').map(m => [m.kind, m.taken, m.activeKm])).toEqual([
      ['branch', false, 20],
    ]);
    expect(alternateMarkers(trail, route, 'SOBO').map(m => [m.kind, m.activeKm])).toEqual([['branch', 60]]);
  });

  it('branch and rejoin cards around a taken alternate, in walking order', () => {
    const route = buildPlannedRoute(trail, [ALT]);
    const nobo = alternateMarkers(trail, route, 'NOBO');
    expect(nobo.map(m => m.kind)).toEqual(['branch', 'rejoin']);
    expect(nobo[0].activeKm).toBeCloseTo(20);
    expect(nobo[1].activeKm).toBeCloseTo(50);
    const sobo = alternateMarkers(trail, route, 'SOBO');
    expect(sobo[0].activeKm).toBeCloseTo(60);
    expect(sobo[1].activeKm).toBeCloseTo(90);
  });
});

describe('document checks', () => {
  it('allows stops on two lines at the same km, not on one', () => {
    const doc = plan([stop(35, 'Camp 35', 'w_camp35'), stop(35, 'High Camp', 'w_altcamp', ALT)], [ALT]);
    expect(() => assertPlanDocumentWithinLimits(doc)).not.toThrow();
    const twice = plan([stop(35, 'A', 'w_aaaa', ALT), stop(35.001, 'B', 'w_bbbb', ALT)], [ALT]);
    expect(() => assertPlanDocumentWithinLimits(twice)).toThrow(/share km/);
  });

  it('refuses a stop on an alternate the plan does not take', () => {
    expect(() => assertPlanDocumentWithinLimits(plan([stop(35, 'A', 'w_aaaa', ALT)]))).toThrow(/does not take/);
  });

  it('isPlanDocument checks the new fields\' shapes', () => {
    expect(isPlanDocument(plan([], [ALT]))).toBe(true);
    expect(isPlanDocument({ ...plan([]), alternates: [1] })).toBe(false);
    expect(isPlanDocument(plan([{ ...stop(1, 'A'), alternate: 5 as unknown as string }]))).toBe(false);
  });
});
