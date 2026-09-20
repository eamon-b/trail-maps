import { describe, it, expect, beforeEach } from 'vitest';
import { loadPlanState, savePlanState, clearPlanState } from './plan-state';
import type { PlanState } from '@lib/plan-types';

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

describe('pace and dailyHours validation', () => {
  it('round-trips a plan with both inputs set', () => {
    const state: PlanState = { ...validState, pace: 'slow', dailyHours: 6 };
    savePlanState('pace-trail', state);
    expect(loadPlanState('pace-trail')).toEqual(state);
  });

  it('accepts a plan without them (pre-input plans = Average / 8 h)', () => {
    savePlanState('no-pace', validState);
    const loaded = loadPlanState('no-pace');
    expect(loaded).toEqual(validState);
    expect(loaded?.pace).toBeUndefined();
    expect(loaded?.dailyHours).toBeUndefined();
  });

  // A bad pace or hours figure has an obvious stand-in — the header input's own
  // initial value — so it is dropped on its own. Throwing the record away with
  // it would cost the hiker the plan's name, stops and dates over a field the
  // page can default.
  it('drops a pace that is not one of the three presets, keeping the rest of the plan', () => {
    localStorage.setItem('trail-plan-bad-pace', JSON.stringify({ ...validState, pace: 'brisk' }));
    const loaded = loadPlanState('bad-pace');
    expect(loaded).toEqual(validState);
    expect(loaded?.pace).toBeUndefined();
  });

  it('drops a non-finite or non-positive dailyHours, keeping the rest of the plan', () => {
    for (const [key, hours] of [['zero', 0], ['neg', -4], ['text', '8']] as const) {
      localStorage.setItem(`trail-plan-${key}`, JSON.stringify({ ...validState, dailyHours: hours }));
      const loaded = loadPlanState(key);
      expect(loaded).toEqual(validState);
      expect(loaded?.dailyHours).toBeUndefined();
    }
    // NaN/Infinity do not survive JSON.stringify, so they arrive as null.
    localStorage.setItem('trail-plan-nan', JSON.stringify({ ...validState, dailyHours: Number.NaN }));
    expect(loadPlanState('nan')).toEqual(validState);
  });

  it('keeps the stops, name and dates of a plan whose pace is unusable', () => {
    localStorage.setItem(
      'trail-plan-bad-pace2',
      JSON.stringify({ ...validState, direction: 'SOBO', resupplyStops: ['w_1'], pace: 7, dailyHours: 0 }),
    );
    const loaded = loadPlanState('bad-pace2');
    expect(loaded).toEqual({ ...validState, direction: 'SOBO', resupplyStops: ['w_1'] });
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
