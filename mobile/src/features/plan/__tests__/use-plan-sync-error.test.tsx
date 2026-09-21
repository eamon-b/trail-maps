/**
 * The Plan screen's "Not synced" read.
 *
 * A refused plan write is invisible everywhere else — the document is saved
 * locally and every number on the screen is right — so what matters here is
 * that the failed outbox row is found, that a later sync clears it, and that a
 * trail with no plan asks nothing at all.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import { getDatabase } from '../../../db/database';
import * as outboxRepo from '../../../db/outbox-repo';
import type { SqlDatabase } from '../../../db/sql-database';
import { emitSyncChange } from '../../../sync/sync-events';
import { usePlanSyncError } from '../use-plan-sync-error';

jest.mock('../../../db/database', () => ({ getDatabase: jest.fn() }));

const mockGetDatabase = getDatabase as jest.Mock;

let db: SqlDatabase;

/** Queue a plan write and fail it the way the drain's 4xx branch does. */
async function failedPlanWrite(planId: string, error: string): Promise<void> {
  await outboxRepo.enqueue(db, {
    id: `row-${planId}`,
    kind: 'plan',
    trailId: 'heysen',
    waypointId: planId,
    payload: {},
    createdAt: '2026-09-21T00:00:00Z',
  });
  await outboxRepo.markFailed(db, `row-${planId}`, error);
}

beforeEach(async () => {
  db = (await createMigratedTestDb()) as unknown as SqlDatabase;
  mockGetDatabase.mockReset();
  mockGetDatabase.mockResolvedValue(db);
});

describe('usePlanSyncError', () => {
  let latest: string | null = null;
  let mounted: ReactTestRenderer | null = null;

  function Harness({ planId }: { planId: string | undefined }) {
    latest = usePlanSyncError(planId);
    return null;
  }

  async function mount(planId: string | undefined): Promise<void> {
    await act(async () => {
      mounted = TestRenderer.create(<Harness planId={planId} />);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }

  beforeEach(() => {
    latest = null;
  });

  afterEach(() => {
    const tree = mounted;
    mounted = null;
    if (tree) act(() => tree.unmount());
  });

  it('reports the reason the server gave', async () => {
    await failedPlanWrite('p1', 'banned: This account is suspended.');
    await mount('p1');
    expect(latest).toBe('banned: This account is suspended.');
  });

  it('says nothing for a plan whose writes are all landing', async () => {
    await failedPlanWrite('other-plan', 'plan_too_large: too big');
    await mount('p1');
    expect(latest).toBeNull();
  });

  it('says nothing for a trail with no plan yet', async () => {
    await failedPlanWrite('p1', 'banned: nope');
    await mount(undefined);
    expect(latest).toBeNull();
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('clears once a later sync gets the write through', async () => {
    await failedPlanWrite('p1', 'plan_too_large: too big');
    await mount('p1');
    expect(latest).not.toBeNull();

    await outboxRepo.remove(db, 'row-p1');
    await act(async () => {
      emitSyncChange({ trailId: 'heysen' });
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(latest).toBeNull();
  });
});

describe('outboxRepo.lastFailure', () => {
  it('ignores a row that is still pending, and keys on the entity', async () => {
    await outboxRepo.enqueue(db, {
      id: 'queued',
      kind: 'plan',
      trailId: 'heysen',
      waypointId: 'p1',
      payload: {},
      createdAt: '2026-09-21T00:00:00Z',
    });
    expect(await outboxRepo.lastFailure(db, 'plan', 'p1')).toBeNull();

    await outboxRepo.markFailed(db, 'queued', 'plan_too_large: too big');
    expect(await outboxRepo.lastFailure(db, 'plan', 'p1')).toBe('plan_too_large: too big');
    expect(await outboxRepo.lastFailure(db, 'plan', 'p2')).toBeNull();
    expect(await outboxRepo.lastFailure(db, 'comment', 'p1')).toBeNull();
  });
});
