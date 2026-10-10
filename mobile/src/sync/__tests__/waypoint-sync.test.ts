import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import type { SqlDatabase } from '../../db/sql-database';
import * as outboxRepo from '../../db/outbox-repo';
import * as userWaypointsRepo from '../../db/user-waypoints-repo';
import * as favoritesRepo from '../../db/favorites-repo';
import type { Session } from '../../api/auth';
import { drainOutbox, pullTrail, resetSyncStateForTests } from '../comment-sync';
import { deleteUserWaypoint, reportUserWaypoint, saveUserWaypoint } from '../waypoint-sync';
import { useIdentityStore } from '../../state/identity-store';
import { onSyncChange, type SyncChange } from '../sync-events';

jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  isApiConfigured: () => true,
}));

const BASE = 'https://api.test';
const SESSION: Session = { userId: 'u1', token: 'tok', displayName: 'Me' };
const getSessionFn = async () => SESSION;

afterEach(() => {
  useIdentityStore.setState({ authError: false });
  resetSyncStateForTests();
});

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** A fetch that answers by route, recording every call. */
function routedFetch(answer: (call: Call) => { status?: number; body?: unknown } | 'offline') {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call = {
      url: url.replace(BASE, ''),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const a = answer(call);
    if (a === 'offline') throw new Error('offline');
    const status = a.status ?? 200;
    const raw = status === 204 ? '' : JSON.stringify(a.body ?? {});
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => raw };
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const INPUT = { name: 'Creek', type: 'water', lat: -34.5, lon: 138.5, description: 'Pools' };

function serverCopy(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    trailId: 'heysen',
    name: 'Creek',
    type: 'water',
    lat: -34.5,
    lon: 138.5,
    description: 'Pools',
    displayName: 'Me',
    mine: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
    ...over,
  };
}

describe('saveUserWaypoint', () => {
  it('keeps a private waypoint on the phone and sends nothing', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch(() => ({}));
    const events: SyncChange[] = [];
    const off = onSyncChange((c) => events.push(c));
    const { waypoint, drain } = await saveUserWaypoint(
      { trailId: 'heysen', input: INPUT, visibility: 'private' },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn },
    );
    off();
    expect(drain).toBeNull();
    expect(calls).toHaveLength(0);
    expect(waypoint.id).toMatch(/^hw_/);
    expect(await userWaypointsRepo.listForTrail(d, 'heysen')).toEqual([
      expect.objectContaining({ id: waypoint.id, visibility: 'private', mine: true, source: 'local' }),
    ]);
    expect(await outboxRepo.count(d)).toBe(0);
    expect(events).toEqual([{ trailId: 'heysen', userWaypoints: true }]);
  });

  it('refuses invalid input and sharing on an imported trail', async () => {
    const d = await db();
    await expect(
      saveUserWaypoint({ trailId: 'heysen', input: { ...INPUT, name: ' ' }, visibility: 'private' }, { db: d }),
    ).rejects.toThrow('Give the waypoint a name.');
    await expect(
      saveUserWaypoint({ trailId: 'u_mine', input: INPUT, visibility: 'shared' }, { db: d }),
    ).rejects.toThrow(/only be kept on this phone/);
  });

  it('shares a waypoint: PUTs it and marks the copy the server’s', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch((call) =>
      call.method === 'PUT' ? { status: 201, body: serverCopy(call.url.split('/').pop()!) } : {},
    );
    const { waypoint, drain } = await saveUserWaypoint(
      { trailId: 'heysen', input: INPUT, visibility: 'shared', displayName: 'Me' },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn },
    );
    expect(await drain).toMatchObject({ outcome: 'drained', sent: 1 });
    expect(calls).toEqual([
      {
        url: `/v1/waypoints/${waypoint.id}`,
        method: 'PUT',
        body: { trailId: 'heysen', name: 'Creek', type: 'water', lat: -34.5, lon: 138.5, description: 'Pools' },
      },
    ]);
    expect(await userWaypointsRepo.getById(d, waypoint.id)).toMatchObject({
      source: 'server',
      authorName: 'Me',
      updatedAt: '2026-10-01T00:00:01.000Z',
    });
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('keeps a shared waypoint queued while offline, and only the newest edit', async () => {
    const d = await db();
    const { fetchImpl } = routedFetch(() => 'offline');
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn };
    const first = await saveUserWaypoint({ trailId: 'heysen', input: INPUT, visibility: 'shared' }, deps);
    await first.drain;
    const second = await saveUserWaypoint(
      { trailId: 'heysen', existing: first.waypoint, input: { ...INPUT, name: 'Creek (flowing)' }, visibility: 'shared' },
      deps,
    );
    await second.drain;
    const queued = await outboxRepo.listPending(d);
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].payloadJson).request.name).toBe('Creek (flowing)');
  });

  it('making a shared waypoint private deletes the server copy', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch((call) =>
      call.method === 'PUT'
        ? { status: 201, body: serverCopy(call.url.split('/').pop()!) }
        : { status: 204 },
    );
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn };
    const shared = await saveUserWaypoint({ trailId: 'heysen', input: INPUT, visibility: 'shared' }, deps);
    await shared.drain;
    const made = await saveUserWaypoint(
      { trailId: 'heysen', existing: { ...shared.waypoint }, input: INPUT, visibility: 'private' },
      deps,
    );
    await made.drain;
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(await userWaypointsRepo.getById(d, shared.waypoint.id)).toMatchObject({
      visibility: 'private',
      authorName: null,
    });
  });

  it('keeps the hiker’s copy, as private, when the server refuses the share (410)', async () => {
    const d = await db();
    const { fetchImpl } = routedFetch(() => ({
      status: 410,
      body: { error: { code: 'waypoint_deleted', message: 'gone' } },
    }));
    const { waypoint, drain } = await saveUserWaypoint(
      { trailId: 'heysen', input: INPUT, visibility: 'shared' },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn },
    );
    await drain;
    expect(await userWaypointsRepo.getById(d, waypoint.id)).toMatchObject({
      visibility: 'private',
      authorName: null,
      name: 'Creek',
    });
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('announces a waypoint change on every trail the drain touched', async () => {
    const d = await db();
    let online = false;
    const { fetchImpl } = routedFetch((call) => {
      if (!online) return 'offline';
      return call.url.includes('/waypoints/')
        ? { status: 410, body: { error: { code: 'waypoint_deleted', message: 'gone' } } }
        : { body: {} };
    });
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn };
    const a = await saveUserWaypoint({ trailId: 'heysen', input: INPUT, visibility: 'shared' }, deps);
    await a.drain;
    const b = await saveUserWaypoint({ trailId: 'larapinta', input: INPUT, visibility: 'shared' }, deps);
    await b.drain;
    online = true;
    const events: SyncChange[] = [];
    const off = onSyncChange((c) => events.push(c));
    await drainOutbox(deps);
    off();
    const trails = events.filter((e) => e.userWaypoints).map((e) => e.trailId);
    expect(trails.sort()).toEqual(['heysen', 'larapinta']);
  });
});

describe('deleteUserWaypoint', () => {
  it('deletes a private waypoint locally only', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch(() => ({}));
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn };
    const { waypoint } = await saveUserWaypoint({ trailId: 'heysen', input: INPUT, visibility: 'private' }, deps);
    await favoritesRepo.toggle(d, 'heysen', waypoint.id);
    const { drain } = await deleteUserWaypoint(waypoint, deps);
    expect(drain).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await userWaypointsRepo.getById(d, waypoint.id)).toBeNull();
    expect(await favoritesRepo.list(d, 'heysen')).toEqual([]);
  });

  it('cancels an unsent share and settles the DELETE’s 404', async () => {
    const d = await db();
    let online = false;
    const { fetchImpl, calls } = routedFetch(() =>
      online ? { status: 404, body: { error: { code: 'not_found', message: 'x' } } } : 'offline',
    );
    const deps = { db: d, baseUrl: BASE, fetchImpl, getSessionFn };
    const saved = await saveUserWaypoint({ trailId: 'heysen', input: INPUT, visibility: 'shared' }, deps);
    await saved.drain;
    online = true;
    const { drain } = await deleteUserWaypoint(saved.waypoint, deps);
    await drain;
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(await outboxRepo.count(d)).toBe(0);
  });

  it('refuses someone else’s waypoint', async () => {
    const d = await db();
    await expect(
      deleteUserWaypoint(
        { id: 'hw_x', trailId: 'heysen', name: 'A', type: 'water', lat: 0, lon: 0, description: '', visibility: 'shared', mine: false, authorName: 'B', createdAt: '', updatedAt: '' },
        { db: d },
      ),
    ).rejects.toThrow();
  });
});

describe('reportUserWaypoint', () => {
  it('queues and sends a report, settling a 410', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch(() => ({
      status: 410,
      body: { error: { code: 'waypoint_deleted', message: 'gone' } },
    }));
    await reportUserWaypoint(
      {
        waypoint: { id: 'hw_x', trailId: 'heysen', name: 'A', type: 'water', lat: 0, lon: 0, description: '', visibility: 'shared', mine: false, authorName: 'B', createdAt: '', updatedAt: '' },
        reason: 'inaccurate',
        detail: ' Dry since 2020 ',
      },
      { db: d, baseUrl: BASE, fetchImpl, getSessionFn },
    );
    expect(calls).toEqual([
      { url: '/v1/waypoints/hw_x/report', method: 'POST', body: { reason: 'inaccurate', detail: 'Dry since 2020' } },
    ]);
    expect(await outboxRepo.count(d)).toBe(0);
  });
});

describe('pullTrail — shared waypoints', () => {
  function pullFetch(waypoints: unknown[], syncedAt = '2026-10-02T00:00:00.000Z') {
    return routedFetch((call) => {
      if (call.url.startsWith('/v1/trails/heysen/waypoints')) return { body: { waypoints, syncedAt } };
      if (call.url.startsWith('/v1/trails/heysen/descriptions')) return { body: { descriptions: [], syncedAt } };
      return { body: { comments: [], nextCursor: null, syncedAt } };
    });
  }

  it('mirrors other hikers’ waypoints, then applies tombstones from the mark', async () => {
    const d = await db();
    const first = pullFetch([serverCopy('hw_a', { mine: false, displayName: 'Ana' })]);
    const events: SyncChange[] = [];
    const off = onSyncChange((c) => events.push(c));
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl: first.fetchImpl, getSessionFn });
    off();
    const read = first.calls.find((c) => c.url.includes('/waypoints'))!;
    expect(read.url).toBe('/v1/trails/heysen/waypoints');
    expect(await userWaypointsRepo.listForTrail(d, 'heysen')).toEqual([
      expect.objectContaining({ id: 'hw_a', visibility: 'shared', mine: false, authorName: 'Ana', source: 'server' }),
    ]);
    expect(events).toEqual([expect.objectContaining({ trailId: 'heysen', userWaypoints: true })]);

    const second = pullFetch([{ id: 'hw_a', deleted: true, updatedAt: '2026-10-03T00:00:00.000Z' }]);
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl: second.fetchImpl, getSessionFn });
    expect(second.calls.find((c) => c.url.includes('/waypoints'))!.url).toBe(
      `/v1/trails/heysen/waypoints?since=${encodeURIComponent('2026-10-02T00:00:00.000Z')}`,
    );
    expect(await userWaypointsRepo.listForTrail(d, 'heysen')).toEqual([]);
  });

  it('keeps this account’s own waypoint, as private, when a tombstone arrives', async () => {
    const d = await db();
    const first = pullFetch([serverCopy('hw_mine')]);
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl: first.fetchImpl, getSessionFn });
    const second = pullFetch([{ id: 'hw_mine', deleted: true, updatedAt: '2026-10-03T00:00:00.000Z' }]);
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl: second.fetchImpl, getSessionFn });
    expect(await userWaypointsRepo.getById(d, 'hw_mine')).toMatchObject({
      visibility: 'private',
      mine: true,
    });
  });

  it('reads every page of a long delta', async () => {
    const d = await db();
    const { fetchImpl, calls } = routedFetch((call) => {
      if (call.url.startsWith('/v1/trails/heysen/waypoints')) {
        return call.url.includes('cursor=')
          ? { body: { waypoints: [serverCopy('hw_b', { mine: false })], nextCursor: null, syncedAt: 'later' } }
          : {
              body: {
                waypoints: [serverCopy('hw_a', { mine: false })],
                nextCursor: 'c1',
                syncedAt: '2026-10-02T00:00:00.000Z',
              },
            };
      }
      if (call.url.startsWith('/v1/trails/heysen/descriptions')) {
        return { body: { descriptions: [], syncedAt: '2026-10-02T00:00:00.000Z' } };
      }
      return { body: { comments: [], nextCursor: null, syncedAt: '2026-10-02T00:00:00.000Z' } };
    });
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(calls.filter((c) => c.url.includes('/waypoints')).map((c) => c.url)).toEqual([
      '/v1/trails/heysen/waypoints',
      '/v1/trails/heysen/waypoints?cursor=c1',
    ]);
    expect((await userWaypointsRepo.listForTrail(d, 'heysen')).map((w) => w.id).sort()).toEqual([
      'hw_a',
      'hw_b',
    ]);
    // The first page's clock is the mark.
    expect(await userWaypointsRepo.readSyncedAt(d, 'heysen')).toBe('2026-10-02T00:00:00.000Z');
  });

  it('never overwrites a waypoint with a write still queued', async () => {
    const d = await db();
    const offline = routedFetch(() => 'offline');
    const saved = await saveUserWaypoint(
      { trailId: 'heysen', input: INPUT, visibility: 'shared' },
      { db: d, baseUrl: BASE, fetchImpl: offline.fetchImpl, getSessionFn },
    );
    await saved.drain;
    const pull = pullFetch([serverCopy(saved.waypoint.id, { name: 'Older name' })]);
    await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl: pull.fetchImpl, getSessionFn });
    expect((await userWaypointsRepo.getById(d, saved.waypoint.id))?.name).toBe('Creek');
  });

  it('keeps the comment pull when the waypoint read fails', async () => {
    const d = await db();
    const { fetchImpl } = routedFetch((call) =>
      call.url.includes('/waypoints')
        ? { status: 500, body: { error: { code: 'x', message: 'y' } } }
        : call.url.includes('/descriptions')
          ? { body: { descriptions: [], syncedAt: '2026-10-02T00:00:00.000Z' } }
          : { body: { comments: [], nextCursor: null, syncedAt: '2026-10-02T00:00:00.000Z' } },
    );
    const result = await pullTrail('heysen', { db: d, baseUrl: BASE, fetchImpl, getSessionFn });
    expect(result.outcome).toBe('pulled');
    expect(await userWaypointsRepo.readSyncedAt(d, 'heysen')).toBeUndefined();
  });
});
