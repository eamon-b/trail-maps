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
  servicesAtStop,
  setDirection,
  setNights,
  setPlanName,
  setStartDate,
  setStopBooked,
  setStopNote,
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
