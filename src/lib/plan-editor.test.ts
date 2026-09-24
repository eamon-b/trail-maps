import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertPlanDocumentWithinLimits,
  computePlanDays,
  findStop,
  isPlanDocument,
  migratePlanState,
  newPlan,
  overnightCandidates,
  planDocumentBytes,
  replaceStopsInRange,
  servicesAtStop,
  setDirection,
  setNights,
  setPlanName,
  setResupplyStops,
  setStartDate,
  setStopBooked,
  setStopNote,
  splitUnplannedTail,
  toggleStop,
} from './plan-editor';
import { toNoboKm } from './plan-direction';
import { PLAN_LIMITS, type PlanDocument, type PlanState, type PlanWaypoint } from './plan-types';
import type { PlanTrail } from './day-calculator';
import type { TrailPOI } from './trail-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic ids and clock, so every assertion is on the plan, not the environment. */
let idCounter = 0;
const opts = {
  idFactory: () => `id-${++idCounter}`,
  now: () => '2026-09-20T00:00:00.000Z',
};

/**
 * A flat 100 km trail: elevation constant, so ascent/descent are 0 and the
 * reversed trail is identical in shape — which lets the SOBO test pass the same
 * object as its "active trail" without a reverse helper.
 */
function flatTrail(lengthKm = 100): PlanTrail {
  const points = Array.from({ length: lengthKm + 1 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100,
    dist: i,
  }));
  return {
    config: { name: 'Flat Trail' },
    track: { points, totalDistance: lengthKm },
    waypoints: [
      { id: 'w_start', name: 'Start', type: 'trailhead', totalDistance: 0 },
      { id: 'w_a', name: 'Camp A', type: 'campsite', totalDistance: 20 },
      { id: 'w_b', name: 'Camp B', type: 'campsite', totalDistance: 50 },
      { id: 'w_end', name: 'Finish', type: 'trailhead', totalDistance: lengthKm },
    ],
  };
}

function emptyPlan(direction: 'NOBO' | 'SOBO' = 'NOBO'): PlanDocument {
  return newPlan('flat', 'My walk', direction, opts);
}

function poi(over: Partial<TrailPOI> & Pick<TrailPOI, 'category' | 'distanceAlongTrail'>): TrailPOI {
  return {
    id: over.id ?? 1,
    type: over.type ?? 'node',
    lat: 0,
    lon: 0,
    name: over.name ?? null,
    tags: over.tags ?? {},
    distanceFromTrail: over.distanceFromTrail ?? 0.1,
    ...over,
  } as TrailPOI;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('newPlan', () => {
  it('mints an empty v1 document', () => {
    const plan = newPlan('heysen', '  Heysen 2027  ', 'NOBO', opts);
    expect(plan).toMatchObject({
      trailId: 'heysen',
      name: 'Heysen 2027',
      direction: 'NOBO',
      startDate: null,
      stops: [],
      version: 1,
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    expect(plan.id).toMatch(/^id-\d+$/);
  });

  it('refuses to invent an id when the runtime has no uuid source', () => {
    // The id is the server's idempotency key, so a Math.random fallback would
    // be a cross-user collision rather than a cosmetic wart.
    vi.stubGlobal('crypto', {});
    expect(() => newPlan('heysen', 'x', 'NOBO')).toThrow(/idFactory/);
  });
});

describe('toggleStop', () => {
  it('adds a stop with nights 1, keeping the list km-sorted', () => {
    let plan = emptyPlan();
    plan = toggleStop(plan, { id: 'w_b', km: 50, name: 'Camp B' }, opts);
    plan = toggleStop(plan, { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    expect(plan.stops.map(s => s.km)).toEqual([20, 50]);
    expect(plan.stops.every(s => s.nights === 1)).toBe(true);
  });

  it('does not mutate the document it was given', () => {
    const before = emptyPlan();
    const after = toggleStop(before, { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    expect(before.stops).toEqual([]);
    expect(after).not.toBe(before);
  });

  it('removes by waypoint id even when the km differs', () => {
    // The Stops list and the map row can quote the same waypoint at km that
    // differ in the last decimal; the id is what makes the toggle idempotent.
    let plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    plan = toggleStop(plan, { id: 'w_a', km: 20.4, name: 'Camp A' }, opts);
    expect(plan.stops).toEqual([]);
  });

  it('removes by km when neither side has an id', () => {
    let plan = toggleStop(emptyPlan(), { km: 20, name: 'Wild camp' }, opts);
    expect(plan.stops).toHaveLength(1);
    plan = toggleStop(plan, { km: 20.005, name: 'Wild camp' }, opts);
    expect(plan.stops).toEqual([]);
  });

  it('never leaves two stops sharing a waypoint id', () => {
    let plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    plan = toggleStop(plan, { id: 'w_a', km: 20, name: 'Camp A' }, opts); // off
    plan = toggleStop(plan, { id: 'w_a', km: 20, name: 'Camp A' }, opts); // on again
    expect(plan.stops.map(s => s.waypointId)).toEqual(['w_a']);
  });

  it('rejects a second stop at the same km (a co-located waypoint)', () => {
    const plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    const same = toggleStop(plan, { id: 'w_other', km: 20, name: 'Chasm kiosk' }, opts);
    expect(same).toBe(plan); // unchanged: "two stops never share a km"
  });

  it('a SOBO toggle stores NOBO km', () => {
    // The caller converts the km it is showing; storage stays NOBO-absolute.
    const plan = emptyPlan('SOBO');
    const activeKm = 20; // 20 km into a southbound walk of the 100 km trail
    const stored = toNoboKm(activeKm, 'SOBO', 100);
    const next = toggleStop(plan, { id: 'w_b', km: stored, name: 'Camp B' }, opts);
    expect(next.stops[0].km).toBe(80);
    // …and it reads back at active km 20 when the days are computed.
    const days = computePlanDays(flatTrail(), next);
    expect(days.map(d => d.endKm)).toEqual([20, 100]);
  });

  it('refuses a non-finite km rather than storing a stop that cannot be loaded back', () => {
    // A NaN km survives the limits check but fails `isPlanDocument` on the next
    // load, which costs the hiker the whole plan rather than one stop.
    const plan = emptyPlan();
    expect(() => toggleStop(plan, { id: 'w_a', km: Number.NaN, name: 'Nowhere' }, opts)).toThrow(
      /plan-editor: stop km must be a finite number/,
    );
    expect(() =>
      toggleStop(plan, { km: Number.POSITIVE_INFINITY, name: 'Nowhere' }, opts),
    ).toThrow(/finite/);
    expect(plan.stops).toEqual([]);
  });

  it('finds a stop by id, then by km', () => {
    const plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    expect(findStop(plan, { waypointId: 'w_a', km: 999 })?.name).toBe('Camp A');
    expect(findStop(plan, { km: 20.001 })?.name).toBe('Camp A');
    expect(findStop(plan, { km: 21 })).toBeUndefined();
  });
});

describe('stop field editors', () => {
  const base = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
  const key = { waypointId: 'w_a', km: 20 };

  it('clamps nights to 1..nightsMax', () => {
    expect(setNights(base, key, 0, opts).stops[0].nights).toBe(1);
    expect(setNights(base, key, 3, opts).stops[0].nights).toBe(3);
    expect(setNights(base, key, 99, opts).stops[0].nights).toBe(PLAN_LIMITS.nightsMax);
    expect(setNights(base, key, Number.NaN, opts).stops[0].nights).toBe(1);
  });

  it('trims and caps a note, and drops an empty one', () => {
    const noted = setStopNote(base, key, '  rang ahead, 2 beds  ', opts);
    expect(noted.stops[0].note).toBe('rang ahead, 2 beds');
    expect(setStopNote(noted, key, '   ', opts).stops[0]).not.toHaveProperty('note');
    const long = setStopNote(base, key, 'x'.repeat(PLAN_LIMITS.noteMax + 50), opts);
    expect(long.stops[0].note).toHaveLength(PLAN_LIMITS.noteMax);
  });

  it('ticks and unticks booked, dropping the key when false', () => {
    const booked = setStopBooked(base, key, true, opts);
    expect(booked.stops[0].booked).toBe(true);
    expect(setStopBooked(booked, key, false, opts).stops[0]).not.toHaveProperty('booked');
  });

  it('is a no-op for a stop that is not in the plan', () => {
    expect(setNights(base, { km: 77 }, 3, opts)).toBe(base);
  });
});

describe('document editors', () => {
  it('validates the start date', () => {
    const plan = emptyPlan();
    expect(setStartDate(plan, '2026-10-01', opts).startDate).toBe('2026-10-01');
    expect(setStartDate(plan, null, opts).startDate).toBeNull();
    expect(() => setStartDate(plan, '1/10/2026', opts)).toThrow(/YYYY-MM-DD/);
    expect(() => setStartDate(plan, '2026-02-31', opts)).toThrow(/YYYY-MM-DD/);
  });

  it('leaves stop km alone on a direction flip', () => {
    const plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    const flipped = setDirection(plan, 'SOBO', opts);
    expect(flipped.direction).toBe('SOBO');
    expect(flipped.stops[0].km).toBe(20); // storage is always NOBO
  });

  it('trims and caps the plan name', () => {
    const plan = setPlanName(emptyPlan(), `  ${'n'.repeat(PLAN_LIMITS.nameMax + 20)}  `, opts);
    expect(plan.name).toHaveLength(PLAN_LIMITS.nameMax);
  });
});

describe('computePlanDays', () => {
  it('cascades dates over rest days and reports restDays per day', () => {
    let plan = setStartDate(emptyPlan(), '2026-10-01', opts);
    plan = toggleStop(plan, { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    plan = toggleStop(plan, { id: 'w_b', km: 50, name: 'Camp B' }, opts);
    plan = setNights(plan, { waypointId: 'w_a', km: 20 }, 2, opts);

    const days = computePlanDays(flatTrail(), plan);
    expect(days.map(d => d.date)).toEqual(['2026-10-01', '2026-10-03', '2026-10-04']);
    expect(days.map(d => d.restDays)).toEqual([1, 0, 0]);
    expect(days.map(d => d.endName)).toEqual(['Camp A', 'Camp B', 'Finish']);
    expect(days.map(d => d.distanceKm)).toEqual([20, 30, 50]);
  });

  it('leaves dates undefined when there is no start date', () => {
    const plan = toggleStop(emptyPlan(), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    const days = computePlanDays(flatTrail(), plan);
    expect(days.every(d => d.date === undefined)).toBe(true);
    expect(days.map(d => d.restDays)).toEqual([0, 0]);
  });

  it('ignores stops outside a section and keeps the cascade aligned', () => {
    let plan = setStartDate(emptyPlan(), '2026-10-01', opts);
    plan = toggleStop(plan, { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    plan = toggleStop(plan, { id: 'w_b', km: 50, name: 'Camp B' }, opts);
    plan = setNights(plan, { waypointId: 'w_b', km: 50 }, 3, opts);

    const days = computePlanDays(flatTrail(), plan, {
      section: { startKm: 30, endKm: 100, startName: 'Section start', endName: 'Finish' },
    });
    // Camp A (km 20) is outside the section, so Camp B ends day 1 and its two
    // rest days push day 2 — not day 3, which a naive stops[i] index would do.
    expect(days.map(d => d.endName)).toEqual(['Camp B', 'Finish']);
    expect(days.map(d => d.restDays)).toEqual([2, 0]);
    expect(days.map(d => d.date)).toEqual(['2026-10-01', '2026-10-04']);
  });
});

describe('overnightCandidates', () => {
  const waypoints: PlanWaypoint[] = [
    { id: 'w_town', name: 'Townsville', type: 'town', totalDistance: 40 },
    { id: 'w_camp', name: 'Camp A', type: 'campsite', totalDistance: 20 },
    { id: 'w_hut', name: 'Snowy Hut', type: 'hut', totalDistance: 60 },
    { id: 'w_hut_access', name: 'Hut turn-off', type: 'hut-access', totalDistance: 65 },
    { id: 'w_water', name: 'Tank', type: 'water-tank', totalDistance: 55 },
    { id: 'w_van', name: 'Big4', type: 'caravan-park', totalDistance: 10 },
  ];

  it('returns the overnight families in km order', () => {
    expect(overnightCandidates(waypoints).map(w => w.name)).toEqual([
      'Big4',
      'Camp A',
      'Townsville',
      'Snowy Hut',
    ]);
  });

  it('never offers a turn-off — you cannot sleep at a roadside', () => {
    expect(overnightCandidates(waypoints).some(w => w.type === 'hut-access')).toBe(false);
  });

  it('can leave towns out, for the phone day-boundary snapper', () => {
    expect(overnightCandidates(waypoints, { includeTowns: false }).map(w => w.name)).toEqual([
      'Big4',
      'Camp A',
      'Snowy Hut',
    ]);
  });
});

describe('setResupplyStops', () => {
  it('stores the selection in the order given, as a copy', () => {
    const ids = ['w_town', 'w_store'];
    const plan = setResupplyStops(emptyPlan(), ids, opts);
    expect(plan.resupplyStops).toEqual(['w_town', 'w_store']);
    ids.push('w_late');
    expect(plan.resupplyStops).toEqual(['w_town', 'w_store']); // not the caller's array
  });

  it('is a no-op when the selection already reads the same', () => {
    const plan = setResupplyStops(emptyPlan(), ['w_town', 'w_store'], opts);
    expect(setResupplyStops(plan, ['w_town', 'w_store'], opts)).toBe(plan);
    // Order is part of the value, so a reordering is a change.
    expect(setResupplyStops(plan, ['w_store', 'w_town'], opts)).not.toBe(plan);
  });

  it('clears the selection with undefined — "no plan made", not "nothing ticked"', () => {
    const plan = setResupplyStops(emptyPlan(), ['w_town'], opts);
    const cleared = setResupplyStops(plan, undefined, opts);
    expect(cleared).not.toHaveProperty('resupplyStops');
    // An explicit empty selection is a different thing, and is stored.
    expect(setResupplyStops(plan, [], opts).resupplyStops).toEqual([]);
  });

  it('is a no-op when clearing a plan that has no selection', () => {
    const plan = emptyPlan();
    expect(setResupplyStops(plan, undefined, opts)).toBe(plan);
  });

  it('restamps updatedAt on a real change', () => {
    const plan = emptyPlan();
    const later = setResupplyStops(plan, ['w_town'], { now: () => '2026-09-21T00:00:00.000Z' });
    expect(later.updatedAt).toBe('2026-09-21T00:00:00.000Z');
    const cleared = setResupplyStops(later, undefined, { now: () => '2026-09-22T00:00:00.000Z' });
    expect(cleared.updatedAt).toBe('2026-09-22T00:00:00.000Z');
  });
});

describe('migratePlanState', () => {
  // A realistic saved state: km-keyed, no ids, a direction and a resupply
  // selection, as `trail-plan-<id>` holds today.
  const legacy: PlanState = {
    name: 'Heysen SOBO',
    startDate: '2026-04-10',
    direction: 'SOBO',
    stops: [
      { km: 50, waypointName: 'Camp B' },
      { km: 20.004, waypointName: 'Camp A' },
      { km: 77.5, waypointName: 'A wild camp' },
    ],
    resupplyStops: ['w_town'],
  };

  it('resolves legacy km to waypoint ids and gives every stop one night', () => {
    const plan = migratePlanState(legacy, 'flat', flatTrail().waypoints as PlanWaypoint[], opts);
    expect(plan.stops).toEqual([
      { waypointId: 'w_a', km: 20, name: 'Camp A', nights: 1 },
      { waypointId: 'w_b', km: 50, name: 'Camp B', nights: 1 },
      // No waypoint within KM_EPSILON: stays km-keyed, which findStop handles.
      { km: 77.5, name: 'A wild camp', nights: 1 },
    ]);
  });

  it('carries name, start date, direction and resupply selection over', () => {
    const plan = migratePlanState(legacy, 'flat', flatTrail().waypoints as PlanWaypoint[], opts);
    expect(plan).toMatchObject({
      trailId: 'flat',
      name: 'Heysen SOBO',
      startDate: '2026-04-10',
      direction: 'SOBO',
      resupplyStops: ['w_town'],
      version: 1,
    });
    expect(isPlanDocument(plan)).toBe(true);
  });

  /** Two waypoints 6 m apart — both inside KM_EPSILON of a km between them. */
  const crowded: PlanWaypoint[] = [
    { id: 'w_near_a', name: 'Near A', type: 'campsite', totalDistance: 10 },
    { id: 'w_near_b', name: 'Near B', type: 'campsite', totalDistance: 10.006 },
  ];

  it('keys a legacy km to the nearest waypoint, not the first in array order', () => {
    const plan = migratePlanState(
      { name: 'x', startDate: null, stops: [{ km: 10.007, waypointName: 'Near B' }] },
      'flat',
      crowded,
      opts,
    );
    expect(plan.stops).toEqual([{ waypointId: 'w_near_b', km: 10.006, name: 'Near B', nights: 1 }]);
  });

  it('drops a stop that resolves onto one already taken', () => {
    // Two legacy km, two different nearby waypoints, one place: keeping both
    // would build a document the save path rejects for sharing a km.
    const plan = migratePlanState(
      {
        name: 'x',
        startDate: null,
        stops: [
          { km: 10.001, waypointName: 'Near A' },
          { km: 10.007, waypointName: 'Near B' },
        ],
      },
      'flat',
      crowded,
      opts,
    );
    expect(plan.stops).toEqual([{ waypointId: 'w_near_a', km: 10, name: 'Near A', nights: 1 }]);
  });

  it('truncates to the first stopsMax stops in km order', () => {
    const stops = Array.from({ length: PLAN_LIMITS.stopsMax + 20 }, (_, i) => ({
      km: (PLAN_LIMITS.stopsMax + 20 - i) * 0.5, // descending: km order is not array order
      waypointName: `Stop ${i}`,
    }));
    const plan = migratePlanState({ name: 'x', startDate: null, stops }, 'flat', [], opts);
    expect(plan.stops).toHaveLength(PLAN_LIMITS.stopsMax);
    expect(plan.stops[0].km).toBe(0.5);
    expect(plan.stops[PLAN_LIMITS.stopsMax - 1].km).toBe(PLAN_LIMITS.stopsMax * 0.5);
  });

  it('never produces a document the save path would reject', () => {
    // Everything a hand-edited or ancient save can throw at it at once.
    const nasty: PlanState = {
      name: 'Nasty',
      startDate: null,
      stops: [
        { km: 10.001, waypointName: 'Near A' },
        { km: 10.007, waypointName: 'Near B' }, // resolves 6 m from the last one
        { km: Number.NaN, waypointName: 'Nowhere' },
        ...Array.from({ length: 600 }, (_, i) => ({ km: 100 + i, waypointName: `Wild ${i}` })),
      ],
    };
    const plan = migratePlanState(nasty, 'flat', crowded, opts);
    expect(() => assertPlanDocumentWithinLimits(plan)).not.toThrow();
    expect(isPlanDocument(plan)).toBe(true);
    expect(plan.stops).toHaveLength(PLAN_LIMITS.stopsMax);
  });

  it('defaults a directionless legacy save to NOBO and a bad date to null', () => {
    const plan = migratePlanState(
      { name: 'x', startDate: 'yesterday' as unknown as string, stops: [] },
      'flat',
      [],
      opts,
    );
    expect(plan.direction).toBe('NOBO');
    expect(plan.startDate).toBeNull();
  });
});

describe('servicesAtStop', () => {
  const pois: TrailPOI[] = [
    poi({ id: 1, category: 'camping', distanceAlongTrail: 49.8, tags: { tourism: 'camp_site' } }),
    poi({
      id: 2,
      category: 'resupply',
      distanceAlongTrail: 50.4,
      tags: { shop: 'supermarket' },
      // Flagged as the same place as a curated waypoint: hidden on the map,
      // but its OSM detail is exactly what a stop card wants.
      duplicateOf: 'w_b',
    }),
    poi({ id: 3, category: 'restaurant', distanceAlongTrail: 50.9, tags: { amenity: 'cafe' } }),
    poi({ id: 4, category: 'water', distanceAlongTrail: 52.5, tags: { amenity: 'drinking_water' } }),
    poi({ id: 5, category: 'transport', distanceAlongTrail: 50.2, tags: { highway: 'bus_stop' } }),
    poi({ id: 6, category: 'camping', distanceAlongTrail: 50.1, tags: { tourism: 'alpine_hut' } }),
  ];

  it('flags what is within the radius, duplicates included', () => {
    const services = servicesAtStop({ km: 50 }, pois);
    expect(services).toMatchObject({
      camping: true,
      lodging: true, // the alpine hut
      shop: true,
      food: true,
      transport: true,
      water: false, // the drinking water is 2.5 km away
    });
    expect(services?.pois.map(p => p.id)).toEqual([1, 2, 3, 5, 6]);
    expect(services?.pois.some(p => p.duplicateOf === 'w_b')).toBe(true);
  });

  it('takes a wider radius when asked', () => {
    expect(servicesAtStop({ km: 50 }, pois, 3)?.water).toBe(true);
  });

  it('is all-false, not undefined, for a stop with nothing around it', () => {
    const services = servicesAtStop({ km: 5 }, pois);
    expect(services).toEqual({
      camping: false,
      lodging: false,
      shop: false,
      food: false,
      water: false,
      transport: false,
      pois: [],
    });
  });

  it('reads shop=no and public_transport=no as absent, not present', () => {
    // OSM tags a former shop `shop=no` and a stop no route serves any more
    // `public_transport=no`; both used to read as "there is one here".
    const closed = [
      poi({
        id: 9,
        category: 'emergency',
        distanceAlongTrail: 50,
        tags: { shop: 'no', public_transport: 'no' },
      }),
    ];
    expect(servicesAtStop({ km: 50 }, closed)).toMatchObject({ shop: false, transport: false });
  });

  it('still flags a real shop or a real transport tag', () => {
    const open = [
      poi({
        id: 10,
        category: 'emergency',
        distanceAlongTrail: 50,
        tags: { shop: 'convenience', public_transport: 'platform' },
      }),
    ];
    expect(servicesAtStop({ km: 50 }, open)).toMatchObject({ shop: true, transport: true });
  });

  it('is undefined for a trail whose POIs were never fetched', () => {
    // CDT and Te Araroa: "No OSM data for this trail", never "no services".
    expect(servicesAtStop({ km: 50 }, undefined)).toBeUndefined();
  });
});

describe('limits', () => {
  function planWithStops(count: number): PlanDocument {
    const plan = emptyPlan();
    return {
      ...plan,
      stops: Array.from({ length: count }, (_, i) => ({
        waypointId: `w_${i}`,
        km: i + 1,
        name: `Stop ${i}`,
        nights: 1,
      })),
    };
  }

  it('measures the serialised document in UTF-8 bytes', () => {
    const plan = emptyPlan();
    expect(planDocumentBytes(plan)).toBe(JSON.stringify(plan).length);
    const wide = setPlanName(plan, 'Te Araroa — 3000 km', opts);
    // The em dash is three UTF-8 bytes, not one.
    expect(planDocumentBytes(wide)).toBe(JSON.stringify(wide).length + 2);
  });

  it('accepts a document inside every bound', () => {
    expect(() => assertPlanDocumentWithinLimits(planWithStops(10))).not.toThrow();
  });

  it('rejects one over the byte ceiling', () => {
    const plan = emptyPlan();
    const huge: PlanDocument = {
      ...plan,
      stops: Array.from({ length: 200 }, (_, i) => ({
        waypointId: `w_${i}`,
        km: i + 1,
        name: `Stop ${i}`,
        nights: 1,
        note: 'x'.repeat(PLAN_LIMITS.noteMax),
      })),
    };
    expect(planDocumentBytes(huge)).toBeGreaterThan(PLAN_LIMITS.documentBytes);
    expect(() => assertPlanDocumentWithinLimits(huge)).toThrow(/over the/);
  });

  it('rejects too many stops, bad nights, a long note and duplicate keys', () => {
    expect(() => assertPlanDocumentWithinLimits(planWithStops(PLAN_LIMITS.stopsMax + 1))).toThrow(
      /exceeds 500/,
    );
    const base = planWithStops(2);
    expect(() =>
      assertPlanDocumentWithinLimits({ ...base, stops: [{ ...base.stops[0], nights: 0 }] }),
    ).toThrow(/nights/);
    expect(() =>
      assertPlanDocumentWithinLimits({
        ...base,
        stops: [{ ...base.stops[0], note: 'x'.repeat(PLAN_LIMITS.noteMax + 1) }],
      }),
    ).toThrow(/note/);
    expect(() =>
      assertPlanDocumentWithinLimits({
        ...base,
        stops: [base.stops[0], { ...base.stops[1], waypointId: base.stops[0].waypointId }],
      }),
    ).toThrow(/waypoint id/);
    expect(() =>
      assertPlanDocumentWithinLimits({
        ...base,
        stops: [base.stops[0], { ...base.stops[1], km: base.stops[0].km + 0.001 }],
      }),
    ).toThrow(/share km/);
  });

  it('rejects a non-finite km, which the next load would reject anyway', () => {
    const base = planWithStops(1);
    const broken: PlanDocument = { ...base, stops: [{ ...base.stops[0], km: Number.NaN }] };
    expect(() => assertPlanDocumentWithinLimits(broken)).toThrow(/non-finite km/);
    // …which is the point: JSON round-tripping a NaN km loses the plan whole.
    expect(isPlanDocument(JSON.parse(JSON.stringify(broken)))).toBe(false);
  });

  it('refuses to add a stop past the ceiling', () => {
    const full = planWithStops(PLAN_LIMITS.stopsMax);
    expect(() => toggleStop(full, { id: 'w_new', km: 999, name: 'One too many' }, opts)).toThrow(
      /at most 500/,
    );
  });
});

describe('isPlanDocument', () => {
  const valid = toggleStop(
    setStartDate(emptyPlan(), '2026-10-01', opts),
    { id: 'w_a', km: 20, name: 'Camp A' },
    opts,
  );

  it('accepts a document the editor produced, round-tripped through JSON', () => {
    expect(isPlanDocument(JSON.parse(JSON.stringify(valid)))).toBe(true);
  });

  it('requires stops ascending by km, as the server does (stops_unsorted)', () => {
    const ascending = [
      { waypointId: 'w_a', km: 20, name: 'Camp A', nights: 1 },
      { waypointId: 'w_b', km: 50, name: 'Camp B', nights: 1 },
    ];
    expect(isPlanDocument({ ...valid, stops: ascending })).toBe(true);
    // Out of order, the adjacent-pair km check in the limits assert is blind to
    // a collision, and `PUT /v1/plans/:id` answers stops_unsorted.
    expect(isPlanDocument({ ...valid, stops: [...ascending].reverse() })).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isPlanDocument(null)).toBe(false);
    expect(isPlanDocument('{}')).toBe(false);
    expect(isPlanDocument([valid])).toBe(false);
    expect(isPlanDocument({ ...valid, version: 2 })).toBe(false);
    expect(isPlanDocument({ ...valid, id: '' })).toBe(false);
    expect(isPlanDocument({ ...valid, direction: 'EAST' })).toBe(false);
    expect(isPlanDocument({ ...valid, startDate: '10/01/2026' })).toBe(false);
    expect(isPlanDocument({ ...valid, stops: undefined })).toBe(false);
    // A string km would sort into nonsense rather than throwing where it landed.
    expect(isPlanDocument({ ...valid, stops: [{ ...valid.stops[0], km: '20' }] })).toBe(false);
    expect(isPlanDocument({ ...valid, stops: [{ ...valid.stops[0], nights: 0 }] })).toBe(false);
    expect(isPlanDocument({ ...valid, stops: [{ ...valid.stops[0], booked: 'yes' }] })).toBe(false);
    expect(isPlanDocument({ ...valid, resupplyStops: [1, 2] })).toBe(false);
  });
});


describe('thrown messages', () => {
  it('every error a UI handler can catch starts with plan-editor:', () => {
    // The callers show these as they stand, so the prefix and the wording are
    // part of the contract, not debug text.
    const full: PlanDocument = {
      ...emptyPlan(),
      stops: Array.from({ length: PLAN_LIMITS.stopsMax }, (_, i) => ({
        waypointId: `w_${i}`,
        km: i + 1,
        name: `Stop ${i}`,
        nights: 1,
      })),
    };
    const thrown = [
      () => toggleStop(full, { id: 'w_new', km: 9999, name: 'One too many' }, opts),
      () => toggleStop(emptyPlan(), { id: 'w_new', km: Number.NaN, name: 'Nowhere' }, opts),
      () => setStartDate(emptyPlan(), '1/10/2026', opts),
      () => assertPlanDocumentWithinLimits({ ...full, stops: [{ ...full.stops[0], nights: 0 }] }),
    ];
    for (const run of thrown) {
      expect(run).toThrow(/^plan-editor: /);
    }
    expect(() => toggleStop(full, { id: 'w_new', km: 9999, name: 'One too many' }, opts)).toThrow(
      'plan-editor: a plan may hold at most 500 stops',
    );
    expect(() => setStartDate(emptyPlan(), '1/10/2026', opts)).toThrow(
      'plan-editor: startDate must be YYYY-MM-DD, got "1/10/2026"',
    );
  });
});

describe('replaceStopsInRange', () => {
  const a = { id: 'w_a', km: 20, name: 'Camp A' };
  const b = { id: 'w_b', km: 50, name: 'Camp B' };
  const c = { id: 'w_c', km: 70, name: 'Camp C' };
  const d = { id: 'w_d', km: 90, name: 'Camp D' };

  function planWith(...targets: { id: string; km: number; name: string }[]): PlanDocument {
    return targets.reduce((p, t) => toggleStop(p, t, opts), newPlan('t', 'Plan', 'NOBO', opts));
  }

  it('replaces only the stops strictly inside the window', () => {
    const plan = planWith(a, b, d);
    const next = replaceStopsInRange(plan, { fromKm: 20, toKm: 80 }, [c], opts);
    expect(next.stops.map(s => s.waypointId)).toEqual(['w_a', 'w_c', 'w_d']);
  });

  it('keeps a surviving stop as it stands, notes and nights included', () => {
    let plan = planWith(a, b);
    plan = setNights(plan, { waypointId: 'w_b', km: 50 }, 2, opts);
    plan = setStopNote(plan, { waypointId: 'w_b', km: 50 }, 'resupply', opts);
    const next = replaceStopsInRange(plan, { fromKm: 20, toKm: 100 }, [b, c], opts);
    const kept = findStop(next, { waypointId: 'w_b', km: 50 });
    expect(kept?.nights).toBe(2);
    expect(kept?.note).toBe('resupply');
  });

  it('returns the same document when nothing changes', () => {
    const plan = planWith(a, b);
    expect(replaceStopsInRange(plan, { fromKm: 0, toKm: 60 }, [a, b], opts)).toBe(plan);
  });

  it('accepts a reversed (SOBO) window', () => {
    const plan = planWith(a, b, c);
    const next = replaceStopsInRange(plan, { fromKm: 80, toKm: 30 }, [], opts);
    expect(next.stops.map(s => s.waypointId)).toEqual(['w_a']);
  });

  it('rejects a non-finite target km', () => {
    expect(() =>
      replaceStopsInRange(newPlan('t', 'P', 'NOBO', opts), { fromKm: 0, toKm: 10 }, [{ km: NaN, name: 'x' }], opts),
    ).toThrow(/plan-editor:/);
  });
});

describe('splitUnplannedTail', () => {
  it('leaves a plan whose last day fits alone', () => {
    const trail = flatTrail();
    const days = computePlanDays(trail, toggleStop(newPlan('t', 'P', 'NOBO', opts), { id: 'w_b', km: 50, name: 'Camp B' }, opts));
    // 50 km flat at 4 km/h = 12.5 h
    expect(splitUnplannedTail(days, 13)).toEqual({ days, unplanned: null });
  });

  it('turns an over-long last day into the unplanned rest of the trail', () => {
    const trail = flatTrail();
    const plan = toggleStop(newPlan('t', 'P', 'NOBO', opts), { id: 'w_a', km: 20, name: 'Camp A' }, opts);
    const days = computePlanDays(trail, plan);
    const split = splitUnplannedTail(days, 10);
    expect(split.days).toHaveLength(1);
    expect(split.unplanned).toMatchObject({ startKm: 20, endKm: 100, dayNumber: 2 });
  });

  it('treats an empty plan over a long trail as wholly unplanned', () => {
    const split = splitUnplannedTail(computePlanDays(flatTrail(), newPlan('t', 'P', 'NOBO', opts)), 10);
    expect(split.days).toEqual([]);
    expect(split.unplanned?.distanceKm).toBe(100);
  });
});
