/**
 * What the planner stores, and what it does with what it finds.
 *
 * Two shapes live in `localStorage` at once: the `PlanDocument` the day
 * planner writes, and the `PlanState` the page wrote before it. The tests
 * below pin both, and the one-way bridge between them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPlanDocument,
  clearPlanState,
  loadOrMigratePlan,
  loadPlanDocument,
  loadPlanState,
  loadPlanUiPrefs,
  savePlanDocument,
  savePlanState,
  savePlanUiPrefs,
} from './plan-state';
import type { PlanDocument, PlanState, PlanWaypoint } from '@lib/plan-types';

beforeEach(() => {
  localStorage.clear();
});

const validState: PlanState = {
  name: 'My Hike',
  startDate: '2025-03-15',
  stops: [{ km: 30, waypointName: 'Camp Alpha' }],
};

describe('savePlanState / loadPlanState round-trip', () => {
  it('saves and loads valid state', () => {
    savePlanState('test-trail', validState);
    const loaded = loadPlanState('test-trail');
    expect(loaded).toEqual(validState);
  });

  it('returns null for unknown trail', () => {
    expect(loadPlanState('nonexistent')).toBeNull();
  });
});

describe('loadPlanState with corrupt data', () => {
  it('returns null for invalid JSON', () => {
    localStorage.setItem('trail-plan-bad', '{not valid json!!!');
    expect(loadPlanState('bad')).toBeNull();
  });

  it('rejects data missing required fields (returns null or throws)', () => {
    // If someone manually edits localStorage and removes the "stops" array,
    // loadPlanState should detect the invalid shape rather than returning it.
    localStorage.setItem('trail-plan-bad-shape', JSON.stringify({ name: 'Test' }));
    const loaded = loadPlanState('bad-shape');
    // The loaded data should either be null (validation failed) or have a valid stops array
    if (loaded !== null) {
      expect(Array.isArray(loaded.stops)).toBe(true);
      expect(loaded).toHaveProperty('startDate');
    }
  });

  it('rejects data with wrong types (stops is a string)', () => {
    localStorage.setItem(
      'trail-plan-wrong-types',
      JSON.stringify({ name: 'Test', startDate: null, stops: 'not-an-array' }),
    );
    const loaded = loadPlanState('wrong-types');
    // Should be null (invalid) or have stops as an actual array
    if (loaded !== null) {
      expect(Array.isArray(loaded.stops)).toBe(true);
    }
  });
});

describe('direction field validation', () => {
  it('round-trips a plan with direction set', () => {
    const state: PlanState = { ...validState, direction: 'SOBO' };
    savePlanState('dir-trail', state);
    expect(loadPlanState('dir-trail')).toEqual(state);
  });

  it('accepts a plan without direction (pre-direction plans = NOBO)', () => {
    savePlanState('no-dir-trail', validState);
    const loaded = loadPlanState('no-dir-trail');
    expect(loaded).toEqual(validState);
    expect(loaded?.direction).toBeUndefined();
  });

  it('rejects a plan with an invalid direction value', () => {
    localStorage.setItem(
      'trail-plan-bad-dir',
      JSON.stringify({ ...validState, direction: 'northbound' }),
    );
    expect(loadPlanState('bad-dir')).toBeNull();
  });

  it('rejects a plan with a non-string direction', () => {
    localStorage.setItem(
      'trail-plan-bad-dir2',
      JSON.stringify({ ...validState, direction: 1 }),
    );
    expect(loadPlanState('bad-dir2')).toBeNull();
  });
});

describe('resupplyStops field validation', () => {
  it('round-trips a plan with a resupply selection', () => {
    const state: PlanState = { ...validState, resupplyStops: ['w_12', 'w_40'] };
    savePlanState('resupply-trail', state);
    expect(loadPlanState('resupply-trail')).toEqual(state);
  });

  it('round-trips an empty selection, which is a real choice, not an absent one', () => {
    const state: PlanState = { ...validState, resupplyStops: [] };
    savePlanState('resupply-none', state);
    expect(loadPlanState('resupply-none')?.resupplyStops).toEqual([]);
  });

  it('accepts a plan without resupplyStops (pre-selection plans = every option)', () => {
    savePlanState('no-resupply', validState);
    const loaded = loadPlanState('no-resupply');
    expect(loaded).toEqual(validState);
    expect(loaded?.resupplyStops).toBeUndefined();
  });

  it('rejects a resupplyStops array holding anything but ids', () => {
    localStorage.setItem(
      'trail-plan-bad-resupply',
      JSON.stringify({ ...validState, resupplyStops: ['w_1', 7] }),
    );
    expect(loadPlanState('bad-resupply')).toBeNull();
  });

  it('rejects a non-array resupplyStops', () => {
    localStorage.setItem(
      'trail-plan-bad-resupply2',
      JSON.stringify({ ...validState, resupplyStops: 'w_1' }),
    );
    expect(loadPlanState('bad-resupply2')).toBeNull();
  });
});

describe('savePlanState error handling', () => {
  it('returns false on QuotaExceededError instead of silently swallowing it', () => {
    // Simulate localStorage being full
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };

    const result = savePlanState('test-trail', validState);

    Storage.prototype.setItem = original;

    // savePlanState must signal failure via return value
    expect(result).toBe(false);
  });
});

describe('clearPlanState', () => {
  it('removes saved state', () => {
    savePlanState('test-trail', validState);
    clearPlanState('test-trail');
    expect(loadPlanState('test-trail')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The plan document
// ---------------------------------------------------------------------------

const TRAIL_ID = 'doc-trail';

const validDocument: PlanDocument = {
  id: '0a1b2c3d-0000-4000-8000-000000000001',
  trailId: TRAIL_ID,
  name: 'My Heysen plan',
  direction: 'NOBO',
  startDate: '2026-03-01',
  stops: [
    { waypointId: 'w_camp', km: 30, name: 'Camp Alpha', nights: 2, note: 'rang ahead', booked: true },
    { km: 61.5, name: 'A place with no id', nights: 1 },
  ],
  resupplyStops: ['w_town'],
  updatedAt: '2026-02-01T00:00:00.000Z',
  version: 1,
};

describe('the plan document in localStorage', () => {
  it('round-trips under its own key, leaving the legacy key alone', () => {
    expect(savePlanDocument(TRAIL_ID, validDocument)).toBe(true);

    expect(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`)).not.toBeNull();
    expect(localStorage.getItem(`trail-plan-${TRAIL_ID}`)).toBeNull();
    expect(loadPlanDocument(TRAIL_ID)).toEqual(validDocument);
  });

  it('returns null for a trail with nothing stored', () => {
    expect(loadPlanDocument('never-planned')).toBeNull();
  });

  it('is forgotten by clearPlanDocument', () => {
    savePlanDocument(TRAIL_ID, validDocument);
    clearPlanDocument(TRAIL_ID);
    expect(loadPlanDocument(TRAIL_ID)).toBeNull();
  });

  it('refuses to store a document the server would reject', () => {
    // Two stops at the same km is a document rule, checked before the write so
    // the bad value never reaches storage to fail again on the next load.
    const clash: PlanDocument = {
      ...validDocument,
      stops: [
        { km: 30, name: 'One', nights: 1 },
        { km: 30.001, name: 'The same place', nights: 1 },
      ],
    };
    expect(savePlanDocument('clash-trail', clash)).toBe(false);
    expect(localStorage.getItem('trail-plan-doc-clash-trail')).toBeNull();
  });

  it('returns false when localStorage refuses the write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };
    const result = savePlanDocument(TRAIL_ID, validDocument);
    Storage.prototype.setItem = original;
    expect(result).toBe(false);
  });
});

describe('a malformed plan document', () => {
  const store = (value: unknown): void => {
    localStorage.setItem('trail-plan-doc-bad', JSON.stringify(value));
  };

  it('rejects unparseable JSON', () => {
    localStorage.setItem('trail-plan-doc-bad', '{not valid json!!!');
    expect(loadPlanDocument('bad')).toBeNull();
  });

  it.each([
    ['no id', { ...validDocument, id: '' }],
    ['a stop with a string km', { ...validDocument, stops: [{ km: '30', name: 'X', nights: 1 }] }],
    ['a stop with no nights', { ...validDocument, stops: [{ km: 30, name: 'X' }] }],
    ['stops that are not an array', { ...validDocument, stops: 'nope' }],
    ['an unknown direction', { ...validDocument, direction: 'northbound' }],
    ['a start date that is not a day', { ...validDocument, startDate: '2026-02-31' }],
    ['a future version', { ...validDocument, version: 2 }],
    ['a resupply list holding a number', { ...validDocument, resupplyStops: ['w_1', 7] }],
  ])('rejects %s whole, rather than half-loading it', (_label, value) => {
    store(value);
    expect(loadPlanDocument('bad')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boot: stored, migrated, or new
// ---------------------------------------------------------------------------

const WAYPOINTS: PlanWaypoint[] = [
  { id: 'w_start', name: 'Trailhead', type: 'endpoint', totalDistance: 0 },
  { id: 'w_camp', name: 'Camp Alpha', type: 'campsite', totalDistance: 30 },
  { id: 'w_town', name: 'Bravo', type: 'town', totalDistance: 61.5 },
];

const TRAIL = {
  config: { id: TRAIL_ID, name: 'The Long Trail', shortName: 'Long' },
  waypoints: WAYPOINTS,
};

/** Predictable ids, so an assertion can name the document it expects. */
const ids = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('loadOrMigratePlan', () => {
  it('returns the stored document untouched', () => {
    savePlanDocument(TRAIL_ID, validDocument);
    const loaded = loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() });
    expect(loaded.origin).toBe('stored');
    expect(loaded.plan).toEqual(validDocument);
  });

  it('mints an empty plan named after the trail when there is nothing to load', () => {
    const loaded = loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() });
    expect(loaded.origin).toBe('new');
    expect(loaded.plan).toMatchObject({
      id: 'id-1',
      trailId: TRAIL_ID,
      name: 'My Long plan',
      direction: 'NOBO',
      startDate: null,
      stops: [],
      version: 1,
    });
    // Nothing is written until the first edit, as before the day planner.
    expect(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`)).toBeNull();
  });

  it('migrates a legacy PlanState, resolving each km to a waypoint id', () => {
    const legacy: PlanState = {
      name: 'Old plan',
      startDate: '2025-09-01',
      direction: 'SOBO',
      stops: [
        { km: 61.5, waypointName: 'Bravo' },
        { km: 30, waypointName: 'Camp Alpha' },
        { km: 12.75, waypointName: 'Somewhere that moved' },
      ],
      resupplyStops: ['w_town'],
    };
    savePlanState(TRAIL_ID, legacy);

    const loaded = loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() });

    expect(loaded.origin).toBe('migrated');
    expect(loaded.plan).toMatchObject({
      id: 'id-1',
      trailId: TRAIL_ID,
      name: 'Old plan',
      direction: 'SOBO',
      startDate: '2025-09-01',
      resupplyStops: ['w_town'],
      version: 1,
    });
    // Sorted by km, every stop a night, ids where a waypoint sits at that km.
    expect(loaded.plan.stops).toEqual([
      { km: 12.75, name: 'Somewhere that moved', nights: 1 },
      { waypointId: 'w_camp', km: 30, name: 'Camp Alpha', nights: 1 },
      { waypointId: 'w_town', km: 61.5, name: 'Bravo', nights: 1 },
    ]);
  });

  it('saves the migration and leaves the legacy key in place', () => {
    savePlanState(TRAIL_ID, { name: 'Old plan', startDate: null, stops: [{ km: 30, waypointName: 'Camp Alpha' }] });

    const first = loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() });
    expect(loadPlanDocument(TRAIL_ID)).toEqual(first.plan);
    expect(loadPlanState(TRAIL_ID)).not.toBeNull();

    // Second boot finds the document, so the id (the server's idempotency key)
    // does not change under the sync arm's feet.
    const second = loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() });
    expect(second.origin).toBe('stored');
    expect(second.plan.id).toBe(first.plan.id);
  });

  it('ignores a legacy save that is malformed and starts fresh', () => {
    localStorage.setItem(`trail-plan-${TRAIL_ID}`, JSON.stringify({ name: 'Broken' }));
    expect(loadOrMigratePlan(TRAIL_ID, TRAIL, { idFactory: ids() }).origin).toBe('new');
  });

  it('re-keys a document stored under a different trail id', () => {
    savePlanDocument('renamed', { ...validDocument, trailId: 'the-old-id' });
    expect(loadOrMigratePlan('renamed', TRAIL, { idFactory: ids() }).plan.trailId).toBe('renamed');
  });

  it('migrates an imported trail against its uw_ waypoint ids', () => {
    const imported = {
      config: { id: 'u_123', name: 'My GPX' },
      waypoints: [{ id: 'uw_4', name: 'Bivvy', type: 'campsite', totalDistance: 8.2 }],
    };
    savePlanState('u_123', { name: 'Import plan', startDate: null, stops: [{ km: 8.2, waypointName: 'Bivvy' }] });

    const loaded = loadOrMigratePlan('u_123', imported, { idFactory: ids() });
    expect(loaded.plan.stops).toEqual([{ waypointId: 'uw_4', km: 8.2, name: 'Bivvy', nights: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// View preferences
// ---------------------------------------------------------------------------

describe('plan UI preferences', () => {
  it('default to the overnight-candidate list', () => {
    expect(loadPlanUiPrefs(TRAIL_ID)).toEqual({ showAllWaypoints: false });
  });

  it('round-trip under their own key, outside the plan document', () => {
    savePlanUiPrefs(TRAIL_ID, { showAllWaypoints: true });
    expect(loadPlanUiPrefs(TRAIL_ID)).toEqual({ showAllWaypoints: true });
    expect(localStorage.getItem(`trail-plan-ui-${TRAIL_ID}`)).toBe('{"showAllWaypoints":true}');
    expect(loadPlanDocument(TRAIL_ID)).toBeNull();
  });

  it('fall back to the default when the stored value is nonsense', () => {
    localStorage.setItem(`trail-plan-ui-${TRAIL_ID}`, '{"showAllWaypoints":"yes"}');
    expect(loadPlanUiPrefs(TRAIL_ID)).toEqual({ showAllWaypoints: false });
    localStorage.setItem(`trail-plan-ui-${TRAIL_ID}`, 'not json');
    expect(loadPlanUiPrefs(TRAIL_ID)).toEqual({ showAllWaypoints: false });
  });
});
