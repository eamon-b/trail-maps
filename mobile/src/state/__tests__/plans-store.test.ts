/**
 * Plans store: `apply` is the one write path, so these pin what it does with
 * the three answers a `@lib/plan-editor` function can give — a new document, a
 * changed one, or the very same object (the "nothing changed" signal, which
 * must not reach SQLite).
 *
 * The repo is exercised for real against an in-memory database; only the
 * connection and the uuid source are mocked.
 */

import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import { getDatabase } from '../../db/database';
import * as plansRepo from '../../db/plans-repo';
import {
  selectIsStop,
  selectPlan,
  setPlanChangedHandler,
  usePlansStore,
} from '../plans-store';
import { setPlanName, setStartDate, toggleStop } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import type { SqlDatabase } from '../../db/sql-database';

jest.mock('../../db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('../../api/uuid', () => {
  let n = 0;
  return { uuidv4: () => `uuid-${++n}` };
});

const mockGetDatabase = getDatabase as jest.Mock;

const TRAIL = 'larapinta';
const CAMP = { id: 'w_camp', km: 12.5, name: 'Standley Chasm' };

let db: SqlDatabase;

beforeEach(async () => {
  db = (await createMigratedTestDb()) as unknown as SqlDatabase;
  mockGetDatabase.mockResolvedValue(db);
  usePlansStore.setState({ byTrail: {} });
  setPlanChangedHandler(undefined);
});

afterEach(() => {
  setPlanChangedHandler(undefined);
});

const store = () => usePlansStore.getState();

describe('plans-store.apply', () => {
  it('mints a plan on the first edit, then edits it in place', async () => {
    const created = await store().apply(TRAIL, (p) => toggleStop(p, CAMP), {
      name: 'Larapinta Trail',
      direction: 'SOBO',
    });

    expect(created).not.toBeNull();
    expect(created?.id).toBe('uuid-1');
    expect(created?.name).toBe('Larapinta Trail');
    expect(created?.direction).toBe('SOBO');
    expect(created?.stops.map((s) => s.name)).toEqual(['Standley Chasm']);

    const renamed = await store().apply(TRAIL, (p) => setPlanName(p, 'Week one'));
    expect(renamed?.id).toBe('uuid-1');
    expect(renamed?.name).toBe('Week one');
    expect(renamed?.stops).toHaveLength(1);

    // One document in SQLite, not two.
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM plans');
    expect(rows.map((r) => r.id)).toEqual(['uuid-1']);
  });

  it('persists through the repo, so a fresh hydrate reads the edit back', async () => {
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    usePlansStore.setState({ byTrail: {} });

    await store().hydrate(TRAIL);
    expect(selectPlan(TRAIL)(usePlansStore.getState())?.stops).toHaveLength(1);
  });

  it('writes nothing when the editor returns the same document', async () => {
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    const before = selectPlan(TRAIL)(usePlansStore.getState());

    const upsert = jest.spyOn(plansRepo, 'upsertLocal');
    // Clearing an already-null start date is a no-op in the editor.
    const result = await store().apply(TRAIL, (p) => setStartDate(p, null));

    expect(upsert).not.toHaveBeenCalled();
    expect(result).toBe(before);
    upsert.mockRestore();
  });

  it('does not mint a plan for a no-op edit on a trail that has none', async () => {
    const result = await store().apply('heysen', (p) => setStartDate(p, null));
    expect(result).toBeNull();
    expect(await db.getAllAsync('SELECT id FROM plans')).toHaveLength(0);
    expect(selectPlan('heysen')(usePlansStore.getState())).toBeUndefined();
  });

  it('keeps a stable reference for the untouched parts of the state', async () => {
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    const first = selectPlan(TRAIL)(usePlansStore.getState());
    const firstStop = first?.stops[0];

    await store().apply(TRAIL, (p) => setPlanName(p, 'Renamed'));
    const second = selectPlan(TRAIL)(usePlansStore.getState());

    expect(second).not.toBe(first);
    // The editor never rewrites stops it did not touch, so a stop row's
    // identity survives a rename — which is what keeps the Stops list from
    // re-rendering every row on every keystroke.
    expect(second?.stops[0]).toBe(firstStop);

    // A read of an unrelated trail is unaffected.
    expect(selectPlan('heysen')(usePlansStore.getState())).toBeUndefined();
  });

  it('reads through to SQLite when the cache was never hydrated', async () => {
    const existing: PlanDocument = {
      id: 'from-disk',
      trailId: TRAIL,
      name: 'Saved earlier',
      direction: 'NOBO',
      startDate: null,
      stops: [],
      updatedAt: '2026-09-20T00:00:00Z',
      version: 1,
    };
    await plansRepo.upsertLocal(db, existing);

    const result = await store().apply(TRAIL, (p) => toggleStop(p, CAMP));
    // The stored plan was edited — no second document was minted for the trail.
    expect(result?.id).toBe('from-disk');
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM plans');
    expect(rows.map((r) => r.id)).toEqual(['from-disk']);
  });

  it('calls the change handler with every stored document', async () => {
    const seen: string[] = [];
    setPlanChangedHandler((doc) => seen.push(doc.name));

    await store().apply(TRAIL, (p) => setPlanName(p, 'One'), { name: 'Larapinta' });
    await store().apply(TRAIL, (p) => setStartDate(p, null)); // no-op, no call
    await store().apply(TRAIL, (p) => setPlanName(p, 'Two'));

    expect(seen).toEqual(['One', 'Two']);
  });

  it('never rejects: a throwing editor leaves the plan untouched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await store().apply(TRAIL, (p) => setPlanName(p, 'Kept'), { name: 'Larapinta' });

    const result = await store().apply(TRAIL, () => {
      throw new Error('nope');
    });

    expect(result).toBeNull();
    expect(selectPlan(TRAIL)(usePlansStore.getState())?.name).toBe('Kept');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('plans-store selectors', () => {
  it('selectIsStop answers by waypoint id, and falls back to km', async () => {
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    const state = usePlansStore.getState();

    expect(selectIsStop(TRAIL, { waypointId: 'w_camp', km: 12.5 })(state)).toBe(true);
    // Same place, km rounded differently — still the same stop.
    expect(selectIsStop(TRAIL, { km: 12.5 })(state)).toBe(true);
    expect(selectIsStop(TRAIL, { waypointId: 'w_other', km: 40 })(state)).toBe(false);
    expect(selectIsStop('heysen', { km: 12.5 })(state)).toBe(false);
  });

  it('clear forgets a trail', async () => {
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    store().clear(TRAIL);
    expect(selectPlan(TRAIL)(usePlansStore.getState())).toBeUndefined();
    // Still in SQLite — clear is a cache eviction, not a delete.
    expect(await plansRepo.getByTrail(db, TRAIL)).not.toBeNull();
  });
});
