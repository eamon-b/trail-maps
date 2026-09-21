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
  planEditFailureMessage,
  selectIsStop,
  selectPlan,
  selectPlanError,
  selectResupplyStops,
  setPlanChangedHandler,
  usePlansStore,
} from '../plans-store';
import { setPlanName, setResupplyStops, setStartDate, toggleStop } from '@lib/plan-editor';
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
const HUT = { id: 'w_hut', km: 30, name: 'Serpentine Chalet' };

let db: SqlDatabase;

beforeEach(async () => {
  db = (await createMigratedTestDb()) as unknown as SqlDatabase;
  mockGetDatabase.mockResolvedValue(db);
  usePlansStore.setState({ byTrail: {}, lastError: {} });
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

  it('stores the trail’s resupply selection in the document', async () => {
    await store().apply(TRAIL, (p) => setResupplyStops(p, ['w_town']), { name: 'Larapinta' });
    expect(selectResupplyStops(TRAIL)(usePlansStore.getState())).toEqual(['w_town']);

    await store().apply(TRAIL, (p) => setResupplyStops(p, undefined));
    expect(selectResupplyStops(TRAIL)(usePlansStore.getState())).toBeUndefined();
    // And it is the stored document that says so, not just the cache.
    expect((await plansRepo.getByTrail(db, TRAIL))?.resupplyStops).toBeUndefined();
  });
});

describe('plans-store.apply failures', () => {
  it('says why an edit was refused, and stops saying it once one lands', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await store().apply(TRAIL, (p) => toggleStop(p, CAMP), { name: 'Larapinta' });
    expect(selectPlanError(TRAIL)(usePlansStore.getState())).toBeNull();

    await store().apply(TRAIL, () => {
      throw new Error('plan-editor: a plan can hold at most 500 stops');
    });

    // The editors' prefix is for the log, not for the hiker.
    expect(selectPlanError(TRAIL)(usePlansStore.getState())).toBe(
      'a plan can hold at most 500 stops',
    );
    // And it belongs to this trail alone.
    expect(selectPlanError('heysen')(usePlansStore.getState())).toBeNull();

    await store().apply(TRAIL, (p) => setPlanName(p, 'Fine'));
    expect(selectPlanError(TRAIL)(usePlansStore.getState())).toBeNull();
    warn.mockRestore();
  });

  it('has something to say about a throw that carries no message', () => {
    expect(planEditFailureMessage(new Error('plan-editor:   '))).toBe(
      'The edit could not be saved.',
    );
    expect(planEditFailureMessage('plan-editor: too big')).toBe('too big');
  });
});

describe('plans-store cache consistency', () => {
  it('drops a hydrate that read the row before an edit replaced it', async () => {
    await store().apply(TRAIL, (p) => setPlanName(p, 'First'), { name: 'Larapinta' });
    const stale = selectPlan(TRAIL)(usePlansStore.getState())!;

    // A hydrate whose read is still in flight when the next tap lands.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = jest.spyOn(plansRepo, 'getByTrail').mockImplementation(async () => {
      await held;
      return stale;
    });

    const hydrating = store().hydrate(TRAIL);
    await store().apply(TRAIL, (p) => setPlanName(p, 'Second'));
    release();
    await hydrating;

    // Without the generation check this would read 'First' again.
    expect(selectPlan(TRAIL)(usePlansStore.getState())?.name).toBe('Second');
    read.mockRestore();
  });

  it('serialises two taps close enough together to overlap', async () => {
    await store().apply(TRAIL, (p) => setPlanName(p, 'Start'), { name: 'Larapinta' });

    // Both fired before either has been awaited — two overlapping `BEGIN`s if
    // they were allowed to interleave, and one of the two edits lost.
    const [first, second] = await Promise.all([
      store().apply(TRAIL, (p) => toggleStop(p, CAMP)),
      store().apply(TRAIL, (p) => toggleStop(p, HUT)),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const stored = await plansRepo.getByTrail(db, TRAIL);
    expect(stored?.stops.map((stop) => stop.name)).toEqual([
      'Standley Chasm',
      'Serpentine Chalet',
    ]);
    // The second edit started from the first one's result, so the cache and
    // the row agree.
    expect(selectPlan(TRAIL)(usePlansStore.getState())?.stops).toHaveLength(2);
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
