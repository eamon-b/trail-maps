/**
 * Id discipline: a `u_` trail must never reach the comments API.
 *
 * The plan's stated risk is that an imported id leaks into the server's
 * allowlist-checked endpoints or the waypoint-id registry. There are exactly
 * three ways one could: the guide's background sync, the waypoint screen's
 * pull, and a user-authored write. This suite pins all three shut — the hook
 * subscribes to nothing and fires no request, `pullTrail` returns before it
 * reads a base URL, and the two outbox minters refuse outright so no row can
 * exist for the drain to send.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as Network from 'expo-network';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as outboxRepo from '../../db/outbox-repo';
import type { Session } from '../../api/auth';
import { pullTrail, submitComment, submitReport } from '../comment-sync';
import { useCommentSync } from '../connectivity';

const BASE = 'https://api.test';
const IMPORTED = 'u_1a2b3c4d';
const SESSION: Session = { userId: 'u1', token: 'tok', displayName: 'Me' };

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

/** Any call at all is a failure, so the mock needs no scripted responses. */
function forbiddenFetch() {
  return jest.fn(async () => {
    throw new Error('the network must not be touched for an imported trail');
  }) as unknown as typeof fetch;
}

function Probe({ trailId }: { trailId: string }) {
  useCommentSync(trailId);
  return null;
}

/**
 * `.rejects.toThrow()` is avoided repo-wide against the test SQLite adapter
 * (it throws synchronously and the matcher flakes) — see `expectDbRejection`.
 * This variant also hands back the message so the guard can be identified.
 */
async function rejectionMessage(op: () => Promise<unknown>): Promise<string> {
  try {
    await op();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('server-boundary gating for imported trails', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = forbiddenFetch();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('opening an imported guide issues no request and subscribes to nothing', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe trailId={IMPORTED} />);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    // No connectivity/foreground listener either: nothing to re-trigger later.
    expect(Network.addNetworkStateListener).not.toHaveBeenCalled();

    act(() => {
      tree!.unmount();
    });
  });

  it('opening a bundled guide still syncs', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe trailId="heysen" />);
    });

    expect(Network.addNetworkStateListener).toHaveBeenCalled();

    act(() => {
      tree!.unmount();
    });
  });

  it('pullTrail short-circuits before any fetch, even fully configured', async () => {
    const fetchImpl = forbiddenFetch();
    const res = await pullTrail(IMPORTED, { db: await db(), baseUrl: BASE, fetchImpl });

    expect(res).toEqual({ outcome: 'not-server-trail', applied: 0, syncedAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('submitComment refuses an imported trail and queues nothing', async () => {
    const d = await db();

    const message = await rejectionMessage(() =>
      submitComment(
        { trailId: IMPORTED, waypointId: 'uw_9f8e7d6c', text: 'water is on', session: SESSION },
        { db: d, baseUrl: BASE, fetchImpl: forbiddenFetch(), getSessionFn: async () => SESSION },
      ),
    );

    expect(message).toMatch(/imported trails have no server side/);
    expect(await outboxRepo.listPending(d)).toHaveLength(0);
  });

  it('submitReport refuses an imported trail and queues nothing', async () => {
    const d = await db();

    const message = await rejectionMessage(() =>
      submitReport(
        {
          commentId: 'c1',
          trailId: IMPORTED,
          waypointId: 'uw_9f8e7d6c',
          reason: 'spam',
          session: SESSION,
        },
        { db: d, baseUrl: BASE, fetchImpl: forbiddenFetch(), getSessionFn: async () => SESSION },
      ),
    );

    expect(message).toMatch(/imported trails have no server side/);
    expect(await outboxRepo.listPending(d)).toHaveLength(0);
  });
});
