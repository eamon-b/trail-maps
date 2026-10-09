import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, banUser, deleteMe, makeAdmin, registerDevice, url, type Device } from './helpers';
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

async function read(trailId: string, since?: string, device?: Device): Promise<SharedWaypointsResponse> {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
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
    // A deleted waypoint cannot be written back.
    expect((await put(owner, a, { ...WATER, name: 'Back' })).status).toBe(410);
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

    const reporters = [await registerDevice(), await registerDevice(), await registerDevice()];
    expect((await report(reporters[0], id)).status).toBe(201);
    expect((await report(reporters[0], id)).status).toBe(200); // replay
    expect((await report(reporters[1], id)).status).toBe(201);
    let row = await env.DB.prepare(`SELECT deleted_at FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeNull();

    expect((await report(reporters[2], id)).status).toBe(201);
    row = await env.DB.prepare(`SELECT deleted_at, deleted_by FROM shared_waypoints WHERE id = ?`)
      .bind(id)
      .first<{ deleted_at: string | null; deleted_by: string }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe('reports');
    expect((await report(await registerDevice(), id)).status).toBe(410);
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
