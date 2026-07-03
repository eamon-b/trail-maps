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
