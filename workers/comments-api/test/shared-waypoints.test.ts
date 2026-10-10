import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, banUser, deleteMe, makeAdmin, registerDevice, url, type Device } from './helpers';
import { registerAgedDevice } from './community-fixtures';
import type {
  SharedWaypoint,
  SharedWaypointsResponse,
} from '../../../src/lib/comments-api-types';

function newId(): string {
  return `hw_${crypto.randomUUID()}`;
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

const WATER = {
  trailId: 'heysen',
  name: 'Creek below the saddle',
  type: 'water',
  lat: -34.123456789,
  lon: 138.5,
  description: 'Small pools after rain.',
};

function put(device: Device, id: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(url(`/v1/waypoints/${id}`), {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

function del(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/waypoints/${id}`), { method: 'DELETE', headers: authHeaders(device) });
}

function report(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/waypoints/${id}/report`), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify({ reason: 'inaccurate' }),
  });
}

async function read(
  trailId: string,
  since?: string,
  device?: Device,
  cursor?: string
): Promise<SharedWaypointsResponse> {
  const qs = new URLSearchParams();
  if (since !== undefined) qs.set('since', since);
  if (cursor !== undefined) qs.set('cursor', cursor);
  const query = qs.size > 0 ? `?${qs}` : '';
  const res = await SELF.fetch(url(`/v1/trails/${trailId}/waypoints${query}`), {
    headers: device ? authHeaders(device) : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SharedWaypointsResponse;
}

describe('PUT /v1/waypoints/:id', () => {
  it('creates a shared waypoint, normalising what was sent', async () => {
    const device = await registerDevice('Finder');
    const id = newId();
    const res = await put(device, id, { ...WATER, name: '  Creek   below the saddle ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SharedWaypoint;
    expect(body).toMatchObject({
      id,
      trailId: 'heysen',
      name: 'Creek below the saddle',
      type: 'water',
      lat: -34.123457,
      description: 'Small pools after rain.',
      displayName: 'Finder',
      mine: true,
    });
  });

  it('replays an identical PUT and lets the owner edit', async () => {
    const device = await registerDevice();
    const id = newId();
    const created = (await (await put(device, id, WATER)).json()) as SharedWaypoint;
    const replay = await put(device, id, WATER);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as SharedWaypoint).updatedAt).toBe(created.updatedAt);

    const edit = await put(device, id, { ...WATER, type: 'campsite', name: 'Saddle camp' });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ type: 'campsite', name: 'Saddle camp' });
  });

  it('refuses another user writing the same id', async () => {
    const owner = await registerDevice();
    const other = await registerDevice();
    const id = newId();
    await put(owner, id, WATER);
    const res = await put(other, id, { ...WATER, name: 'Mine now' });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('id_conflict');
  });

  it('validates the id, trail and fields', async () => {
    const device = await registerDevice();
    expect((await put(device, 'w_12345678', WATER)).status).toBe(400);
    const badTrail = await put(device, newId(), { ...WATER, trailId: 'u_import' });
    expect(errorCode(await badTrail.json())).toBe('invalid_trail');
    const badType = await put(device, newId(), { ...WATER, type: 'gap' });
    expect(errorCode(await badType.json())).toBe('invalid_type');
    const noName = await put(device, newId(), { ...WATER, name: '   ' });
    expect(errorCode(await noName.json())).toBe('invalid_name');
    const badLat = await put(device, newId(), { ...WATER, lat: 95 });
    expect(errorCode(await badLat.json())).toBe('invalid_position');
  });

  it('refuses a banned account and anonymous callers', async () => {
    const device = await registerDevice();
    await banUser(device.userId);
    expect((await put(device, newId(), WATER)).status).toBe(403);
    const anon = await SELF.fetch(url(`/v1/waypoints/${newId()}`), {
      method: 'PUT',
      body: JSON.stringify(WATER),
    });
    expect(anon.status).toBe(401);
  });

  it('caps new shared waypoints per day', async () => {
    const device = await registerDevice();
    for (let i = 0; i < 20; i++) {
      expect((await put(device, newId(), WATER)).status).toBe(201);
    }
    const res = await put(device, newId(), WATER);
    expect(res.status).toBe(429);
  });
});

describe('GET /v1/trails/:trailId/waypoints', () => {
  it('serves live rows, then deltas with tombstones', async () => {
    const device = await registerDevice('Sharer');
    const trailId = 'larapinta';
    const keep = newId();
    const gone = newId();
    await put(device, keep, { ...WATER, trailId });
    await put(device, gone, { ...WATER, trailId, name: 'Soon gone' });

    const first = await read(trailId);
    const ids = first.waypoints.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([keep, gone]));
    expect(first.waypoints.find((w) => w.id === keep)).not.toHaveProperty('mine');

    expect((await del(device, gone)).status).toBe(204);
    const delta = await read(trailId, first.syncedAt);
    expect(delta.waypoints).toEqual([expect.objectContaining({ id: gone, deleted: true })]);

    const snapshot = await read(trailId);
    expect(snapshot.waypoints.map((w) => w.id)).not.toContain(gone);
  });

  it('pages past rows that share one updated_at', async () => {
    const device = await registerDevice();
    const trailId = 'six_foot_track';
    const ids = [newId(), newId(), newId()];
    for (const id of ids) await put(device, id, { ...WATER, trailId });
    // Seed past one page directly, all on a single stamp (as an account
    // deletion tombstones them).
    const stamp = '2030-01-01T00:00:00.000Z';
    const user = await env.DB.prepare(`SELECT user_id FROM shared_waypoints WHERE id = ?`)
      .bind(ids[0])
      .first<{ user_id: string }>();
    const rows = Array.from({ length: 2001 }, () => newId());
    for (let i = 0; i < rows.length; i += 100) {
      await env.DB.batch(
        rows.slice(i, i + 100).map((id) =>
          env.DB.prepare(
            `INSERT INTO shared_waypoints
               (id, trail_id, user_id, name, type, lat, lon, description, created_at, updated_at)
             VALUES (?, ?, ?, 'x', 'water', 0, 0, '', ?, ?)`
          ).bind(id, trailId, user!.user_id, stamp, stamp)
        )
      );
    }
    const first = await read(trailId, stamp);
    expect(first.waypoints).toHaveLength(2000);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(trailId, stamp, undefined, first.nextCursor!);
    expect(second.waypoints).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...first.waypoints, ...second.waypoints].map((w) => w.id));
    expect(seen.size).toBe(2001);
  });

  it('tells a signed-in reader which are theirs', async () => {
    const owner = await registerDevice();
    const reader = await registerDevice();
    const id = newId();
    await put(owner, id, { ...WATER, trailId: 'overland' });
    const asOwner = await read('overland', undefined, owner);
    expect(asOwner.waypoints.find((w) => w.id === id)).toMatchObject({ mine: true });
    const asReader = await read('overland', undefined, reader);
    expect(asReader.waypoints.find((w) => w.id === id)).toMatchObject({ mine: false });
  });
});

describe('DELETE /v1/waypoints/:id', () => {
  it('lets the owner or an admin delete, and nobody else', async () => {
    const owner = await registerDevice();
    const other = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const a = newId();
    const b = newId();
    await put(owner, a, WATER);
    await put(owner, b, WATER);
    expect((await del(other, a)).status).toBe(403);
    expect((await del(owner, a)).status).toBe(204);
    expect((await del(owner, a)).status).toBe(204); // idempotent
    expect((await del(admin, b)).status).toBe(204);
    const row = await env.DB.prepare(`SELECT deleted_by FROM shared_waypoints WHERE id = ?`)
      .bind(b)
      .first<{ deleted_by: string }>();
    expect(row?.deleted_by).toBe('admin');
    expect((await del(owner, newId())).status).toBe(404);
    // One an admin deleted cannot be written back by its owner.
    expect((await put(owner, b, { ...WATER, name: 'Back' })).status).toBe(410);
  });

  it('lets the owner share a waypoint again after taking it down', async () => {
    const owner = await registerDevice('Sharer');
    const id = newId();
    await put(owner, id, { ...WATER, trailId: 'hume-and-hovell' });
    expect((await del(owner, id)).status).toBe(204);
    const before = await read('hume-and-hovell');
    expect(before.waypoints.map((w) => w.id)).not.toContain(id);

    const res = await put(owner, id, { ...WATER, trailId: 'hume-and-hovell', name: 'Back again' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SharedWaypoint).name).toBe('Back again');
    const after = await read('hume-and-hovell', before.syncedAt);
    expect(after.waypoints).toEqual([expect.objectContaining({ id, name: 'Back again' })]);
    // Still nobody else's to revive.
    expect((await put(await registerDevice(), id, WATER)).status).toBe(409);
  });

  it('tombstones them when the account is deleted', async () => {
    const device = await registerDevice();
    const id = newId();
    await put(device, id, WATER);
    expect((await deleteMe(device)).status).toBe(204);
    const row = await env.DB.prepare(`SELECT deleted_at FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
  });
});

describe('POST /v1/waypoints/:id/report', () => {
  it('is one per reporter and hides the waypoint at three', async () => {
    const owner = await registerDevice();
    const id = newId();
    await put(owner, id, { ...WATER, trailId: 'three_capes' });
    expect((await report(owner, id)).status).toBe(400);

    const reporters = [
      await registerAgedDevice(),
      await registerAgedDevice(),
      await registerAgedDevice(),
    ];
    expect((await report(reporters[0], id)).status).toBe(201);
    expect((await report(reporters[0], id)).status).toBe(200); // replay
    expect((await report(reporters[1], id)).status).toBe(201);
    let row = await env.DB.prepare(`SELECT deleted_at, deleted_by FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(row?.deleted_at).toBeNull();

    expect((await report(reporters[2], id)).status).toBe(201);
    row = await env.DB.prepare(`SELECT deleted_at, deleted_by FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe('reports');
    expect((await report(await registerDevice(), id)).status).toBe(410);
  });

  it('does not let accounts under a day old hide one', async () => {
    const owner = await registerDevice();
    const id = newId();
    await put(owner, id, WATER);
    for (let i = 0; i < 3; i++) {
      expect((await report(await registerDevice(), id)).status).toBe(201);
    }
    const row = await env.DB.prepare(`SELECT deleted_at FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});

describe('POST /v1/admin/waypoints/:id/restore', () => {
  it('undoes a report hide, and only later reports count', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const id = newId();
    await put(owner, id, WATER);
    for (let i = 0; i < 3; i++) await report(await registerAgedDevice(), id);
    const deletedAt = async () =>
      (
        await env.DB.prepare(`SELECT deleted_at FROM shared_waypoints WHERE id = ?`)
          .bind(id)
          .first<{ deleted_at: string | null }>()
      )?.deleted_at;
    expect(await deletedAt()).not.toBeNull();

    const restore = (device: Device) =>
      SELF.fetch(url(`/v1/admin/waypoints/${id}/restore`), {
        method: 'POST',
        headers: authHeaders(device),
      });
    expect((await restore(owner)).status).toBe(403);
    expect((await restore(admin)).status).toBe(204);
    expect(await deletedAt()).toBeNull();

    // One more report does not tip it straight back over.
    await report(await registerAgedDevice(), id);
    expect(await deletedAt()).toBeNull();
  });

  it('refuses a waypoint its owner deleted', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const id = newId();
    await put(owner, id, WATER);
    await del(owner, id);
    const res = await SELF.fetch(url(`/v1/admin/waypoints/${id}/restore`), {
      method: 'POST',
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/admin/waypoints', () => {
  it('is admin-only and lists reported waypoints first', async () => {
    const admin = await registerDevice();
    const owner = await registerDevice();
    const id = newId();
    await put(owner, id, WATER);
    await report(await registerDevice(), id);
    const refused = await SELF.fetch(url('/v1/admin/waypoints'), { headers: authHeaders(owner) });
    expect(refused.status).toBe(403);
    await makeAdmin(admin.userId);
    const res = await SELF.fetch(url('/v1/admin/waypoints'), { headers: authHeaders(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waypoints: { id: string; reportCount: number }[] };
    expect(body.waypoints[0].reportCount).toBeGreaterThanOrEqual(1);
    expect(body.waypoints.map((w) => w.id)).toContain(id);
  });
});
