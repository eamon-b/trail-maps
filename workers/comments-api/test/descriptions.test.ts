import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, makeAdmin, putDescription, registerDevice, url } from './helpers';
import type {
  TrailDescriptionsResponse,
  WaypointDescription,
} from '../../../src/lib/comments-api-types';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** A registered device that has been promoted to admin. */
async function adminDevice(name = 'Editor') {
  const device = await registerDevice(name);
  await makeAdmin(device.userId);
  return device;
}

async function readDescriptions(
  trailId: string,
  since?: string
): Promise<TrailDescriptionsResponse> {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
  const res = await SELF.fetch(url(`/v1/trails/${trailId}/descriptions${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as TrailDescriptionsResponse;
}

describe('PUT /v1/admin/trails/:trailId/descriptions/:waypointId', () => {
  it('creates a description and returns the stored row', async () => {
    const admin = await adminDevice();
    const res = await putDescription(admin, 'heysen', 'desc-create-wp', {
      description: '  A shady campsite with a reliable tank.  ',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaypointDescription;
    expect(body.waypointId).toBe('desc-create-wp');
    expect(body.description).toBe('A shady campsite with a reliable tank.'); // trimmed
    expect(typeof body.updatedAt).toBe('string');

    const row = await env.DB.prepare(
      `SELECT description, updated_at FROM waypoint_descriptions
        WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind('heysen', 'desc-create-wp')
      .first<{ description: string; updated_at: string }>();
    expect(row?.description).toBe('A shady campsite with a reliable tank.');
    expect(row?.updated_at).toBe(body.updatedAt);
  });

  it('upserts in place, bumping updated_at and keeping one row', async () => {
    const admin = await adminDevice();
    const first = (await (
      await putDescription(admin, 'heysen', 'desc-upsert-wp', { description: 'v1' })
    ).json()) as WaypointDescription;

    // Force a distinguishable clock gap so the bump is observable.
    await env.DB.prepare(
      `UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), 'heysen', 'desc-upsert-wp')
      .run();

    const second = (await (
      await putDescription(admin, 'heysen', 'desc-upsert-wp', { description: 'v2' })
    ).json()) as WaypointDescription;
    expect(second.description).toBe('v2');
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt) - 60_000);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM waypoint_descriptions WHERE waypoint_id = ?`
    )
      .bind('desc-upsert-wp')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('accepts an empty description as a cleared tombstone', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'heysen', 'desc-clear-wp', { description: 'something' });

    const res = await putDescription(admin, 'heysen', 'desc-clear-wp', { description: '   ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WaypointDescription).description).toBe('');

    // Cleared rows are still served, so clients learn the prose was withdrawn.
    const body = await readDescriptions('heysen');
    const row = body.descriptions.find((d) => d.waypointId === 'desc-clear-wp');
    expect(row?.description).toBe('');
  });

  it('accepts exactly 4000 chars and rejects 4001', async () => {
    const admin = await adminDevice();
    const ok = await putDescription(admin, 'heysen', 'desc-len-wp', {
      description: 'x'.repeat(4000),
    });
    expect(ok.status).toBe(200);

    const tooLong = await putDescription(admin, 'heysen', 'desc-len-wp', {
      description: 'x'.repeat(4001),
    });
    expect(tooLong.status).toBe(400);
    expect(errorCode(await tooLong.json())).toBe('invalid_description');
  });

  it('400 for a missing or non-string description', async () => {
    const admin = await adminDevice();
    const missing = await putDescription(admin, 'heysen', 'desc-bad-wp', {});
    expect(missing.status).toBe(400);
    expect(errorCode(await missing.json())).toBe('invalid_description');

    const wrongType = await putDescription(admin, 'heysen', 'desc-bad-wp', { description: 42 });
    expect(wrongType.status).toBe(400);
    expect(errorCode(await wrongType.json())).toBe('invalid_description');
  });

  it('400 for an unknown trail or malformed waypoint id', async () => {
    const admin = await adminDevice();
    const badTrail = await putDescription(admin, 'not-a-trail', 'desc-x-wp', { description: 'x' });
    expect(badTrail.status).toBe(400);
    expect(errorCode(await badTrail.json())).toBe('invalid_trail');

    const badWaypoint = await putDescription(admin, 'heysen', 'ab', { description: 'x' });
    expect(badWaypoint.status).toBe(400);
    expect(errorCode(await badWaypoint.json())).toBe('invalid_waypoint');
  });

  it('401 unauthenticated and 403 for a non-admin', async () => {
    const anon = await SELF.fetch(url('/v1/admin/trails/heysen/descriptions/desc-auth-wp'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'nope' }),
    });
    expect(anon.status).toBe(401);

    const plain = await registerDevice('Plain');
    const res = await putDescription(plain, 'heysen', 'desc-auth-wp', { description: 'nope' });
    expect(res.status).toBe(403);
    expect(errorCode(await res.json())).toBe('forbidden');

    // Nothing was written by either attempt.
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM waypoint_descriptions WHERE waypoint_id = ?`
    )
      .bind('desc-auth-wp')
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('405 for a wrong method on the admin descriptions path', async () => {
    const admin = await adminDevice();
    const res = await SELF.fetch(url('/v1/admin/trails/heysen/descriptions/desc-method-wp'), {
      method: 'GET',
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(405);
    expect(errorCode(await res.json())).toBe('method_not_allowed');
  });
});

describe('GET /v1/trails/:trailId/descriptions', () => {
  it('is public, ordered by waypoint id, and scoped to the trail', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'heysen', 'zzz-read-wp', { description: 'last' });
    await putDescription(admin, 'heysen', 'aaa-read-wp', { description: 'first' });
    await putDescription(admin, 'larapinta', 'mmm-read-wp', { description: 'other trail' });

    const heysen = await readDescriptions('heysen');
    const ids = heysen.descriptions.map((d) => d.waypointId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('aaa-read-wp');
    expect(ids).toContain('zzz-read-wp');
    expect(ids).not.toContain('mmm-read-wp');
    expect(typeof heysen.syncedAt).toBe('string');

    const larapinta = await readDescriptions('larapinta');
    expect(larapinta.descriptions.map((d) => d.waypointId)).toEqual(['mmm-read-wp']);
  });

  it('filters to rows updated after `since`', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'bibbulmun', 'desc-since-old-wp', { description: 'old' });

    // Backdate the first row and take a watermark between the two writes.
    const oldStamp = new Date(Date.now() - 120_000).toISOString();
    await env.DB.prepare(
      `UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind(oldStamp, 'bibbulmun', 'desc-since-old-wp')
      .run();
    const since = new Date(Date.now() - 60_000).toISOString();

    await putDescription(admin, 'bibbulmun', 'desc-since-new-wp', { description: 'new' });

    const delta = await readDescriptions('bibbulmun', since);
    expect(delta.descriptions.map((d) => d.waypointId)).toEqual(['desc-since-new-wp']);

    // The full read still returns both.
    const full = await readDescriptions('bibbulmun');
    expect(full.descriptions.map((d) => d.waypointId)).toEqual([
      'desc-since-new-wp',
      'desc-since-old-wp',
    ]);

    // A watermark past every row yields an empty delta with a fresh syncedAt.
    const empty = await readDescriptions('bibbulmun', full.syncedAt);
    expect(empty.descriptions).toEqual([]);
    expect(Date.parse(empty.syncedAt)).toBeGreaterThanOrEqual(Date.parse(full.syncedAt));
  });

  it('returns cleared rows in a delta so clients drop stale prose', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'aawt', 'desc-delta-clear-wp', { description: 'was here' });

    // Backdate the original write so the clear is unambiguously newer than the
    // watermark even if both requests land in the same millisecond.
    await env.DB.prepare(
      `UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind(new Date(Date.now() - 120_000).toISOString(), 'aawt', 'desc-delta-clear-wp')
      .run();
    const before = new Date(Date.now() - 60_000).toISOString();

    await putDescription(admin, 'aawt', 'desc-delta-clear-wp', { description: '' });

    const delta = await readDescriptions('aawt', before);
    expect(delta.descriptions).toEqual([
      expect.objectContaining({ waypointId: 'desc-delta-clear-wp', description: '' }),
    ]);
  });

  it('returns an empty list for a trail with no descriptions', async () => {
    const body = await readDescriptions('cape_to_cape');
    expect(body.descriptions).toEqual([]);
  });

  it('400 for an unknown trail id', async () => {
    const res = await SELF.fetch(url('/v1/trails/atlantis/descriptions'));
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_trail');
  });

  it('405 for a wrong method on the public descriptions path', async () => {
    const res = await SELF.fetch(url('/v1/trails/heysen/descriptions'), { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});
