import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  createComment,
  deleteMe,
  makeAdmin,
  registerDevice,
  reportComment,
  uploadPhoto,
  url,
} from './helpers';
import type {
  BulkSyncResponse,
  FeedResponse,
  MeResponse,
} from '../../../src/lib/comments-api-types';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33]);

interface UserSnapshot {
  display_name: string;
  token_hash: string;
  is_admin: number;
  is_banned: number;
}

async function readUser(userId: string): Promise<UserSnapshot> {
  const row = await env.DB.prepare(
    `SELECT display_name, token_hash, is_admin, is_banned FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<UserSnapshot>();
  if (!row) throw new Error(`no user ${userId}`);
  return row;
}

async function readComment(id: string): Promise<{
  deleted_at: string | null;
  deleted_by: string | null;
  updated_at: string;
  photo_urls_json: string | null;
  photo_hashes_json: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT deleted_at, deleted_by, updated_at, photo_urls_json, photo_hashes_json
       FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{
      deleted_at: string | null;
      deleted_by: string | null;
      updated_at: string;
      photo_urls_json: string | null;
      photo_hashes_json: string | null;
    }>();
  if (!row) throw new Error(`no comment ${id}`);
  return row;
}

describe('DELETE /v1/me — happy path', () => {
  it('returns 204, tombstones the comments, and scrubs the user row', async () => {
    const device = await registerDevice('Doomed Device');
    const { id: a } = await createComment(device, { waypointId: 'delme-wp-a', text: 'first' });
    const { id: b } = await createComment(device, { waypointId: 'delme-wp-b', text: 'second' });

    const before = await readUser(device.userId);

    const res = await deleteMe(device);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    for (const id of [a, b]) {
      const row = await readComment(id);
      expect(row.deleted_at).not.toBeNull();
      expect(row.deleted_by).toBe('owner');
      expect(row.updated_at).toBe(row.deleted_at);
      expect(row.photo_urls_json).toBeNull();
      expect(row.photo_hashes_json).toBeNull();
    }

    // The row survives (feed/sync inner-join users) but carries no identity.
    const after = await readUser(device.userId);
    expect(after.display_name).toBe('Deleted user');
    expect(after.is_admin).toBe(0);
    expect(after.is_banned).toBe(1);
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(after.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves other users untouched', async () => {
    const doomed = await registerDevice('Doomed');
    const bystander = await registerDevice('Bystander');
    const { id: mine } = await createComment(doomed, { waypointId: 'delme-shared-wp' });
    const { id: theirs } = await createComment(bystander, { waypointId: 'delme-shared-wp' });

    expect((await deleteMe(doomed)).status).toBe(204);

    expect((await readComment(mine)).deleted_at).not.toBeNull();
    expect((await readComment(theirs)).deleted_at).toBeNull();
    expect((await readUser(bystander.userId)).display_name).toBe('Bystander');

    const feed = (await (
      await SELF.fetch(url('/v1/trails/heysen/waypoints/delme-shared-wp/comments'))
    ).json()) as FeedResponse;
    expect(feed.comments.map((c) => c.id)).toEqual([theirs]);
  });

  it('works for an account with no comments', async () => {
    const device = await registerDevice('Empty');
    expect((await deleteMe(device)).status).toBe(204);
    expect((await readUser(device.userId)).is_banned).toBe(1);
  });

  it('demotes an admin account on deletion', async () => {
    const device = await registerDevice('Retiring Admin');
    await makeAdmin(device.userId);
    const me = (await (
      await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) })
    ).json()) as MeResponse;
    expect(me.isAdmin).toBe(true);

    expect((await deleteMe(device)).status).toBe(204);
    expect((await readUser(device.userId)).is_admin).toBe(0);
  });
});

describe('DELETE /v1/me — token invalidation', () => {
  it('401s on every subsequent request with the old token', async () => {
    const device = await registerDevice('Gone');
    expect((await deleteMe(device)).status).toBe(204);

    // The repeat delete, /v1/me, and a write all fail closed.
    expect((await deleteMe(device)).status).toBe(401);
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) })).status).toBe(401);
    const { res } = await createComment(device, { waypointId: 'delme-after-wp' });
    expect(res.status).toBe(401);
  });

  it('401 without a token', async () => {
    const res = await SELF.fetch(url('/v1/me'), { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('405 for an unsupported method on /v1/me', async () => {
    const device = await registerDevice('Method');
    const res = await SELF.fetch(url('/v1/me'), { method: 'POST', headers: authHeaders(device) });
    expect(res.status).toBe(405);
  });
});

describe('DELETE /v1/me — sync semantics', () => {
  it('emits tombstones in the delta feed and drops the comments from the feed', async () => {
    const device = await registerDevice('Sync Doomed');
    const { id, res } = await createComment(device, {
      waypointId: 'delme-sync-wp',
      text: 'will vanish',
    });
    const created = (await res.json()) as { createdAt: string };
    const since = new Date(Date.parse(created.createdAt) - 1).toISOString();

    // Present in both views before deletion.
    const snapshotBefore = (await (
      await SELF.fetch(url('/v1/trails/heysen/comments'))
    ).json()) as BulkSyncResponse;
    expect(snapshotBefore.comments.some((c) => c.id === id)).toBe(true);

    expect((await deleteMe(device)).status).toBe(204);

    // Delta sync sees a tombstone (so offline clients can drop their copy).
    const delta = (await (
      await SELF.fetch(url(`/v1/trails/heysen/comments?since=${encodeURIComponent(since)}`))
    ).json()) as BulkSyncResponse;
    const entry = delta.comments.find((c) => c.id === id);
    expect(entry).toBeDefined();
    expect(entry && 'deleted' in entry ? entry.deleted : false).toBe(true);
    expect(entry && 'text' in entry).toBe(false);

    // Snapshot mode (no `since`) and the per-waypoint feed both omit it entirely.
    const snapshotAfter = (await (
      await SELF.fetch(url('/v1/trails/heysen/comments'))
    ).json()) as BulkSyncResponse;
    expect(snapshotAfter.comments.some((c) => c.id === id)).toBe(false);

    const feed = (await (
      await SELF.fetch(url('/v1/trails/heysen/waypoints/delme-sync-wp/comments'))
    ).json()) as FeedResponse;
    expect(feed.comments.some((c) => c.id === id)).toBe(false);
  });

  it('keeps already-deleted comments as-is rather than re-stamping them', async () => {
    const device = await registerDevice('Pre-deleted');
    const { id } = await createComment(device, { waypointId: 'delme-predel-wp' });
    await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    const afterFirstDelete = await readComment(id);

    expect((await deleteMe(device)).status).toBe(204);

    const afterAccountDelete = await readComment(id);
    expect(afterAccountDelete.updated_at).toBe(afterFirstDelete.updated_at);
    expect(afterAccountDelete.deleted_at).toBe(afterFirstDelete.deleted_at);
  });
});

describe('DELETE /v1/me — photos and reports', () => {
  it('removes the account photos from R2', async () => {
    const device = await registerDevice('Photo Doomed');
    const { id } = await createComment(device, { waypointId: 'delme-photo-wp' });
    expect((await uploadPhoto(device, id, JPEG_BYTES, 'image/jpeg')).status).toBe(201);
    expect(await env.PHOTOS.get(`comments/${id}/0.jpg`)).not.toBeNull();

    expect((await deleteMe(device)).status).toBe(204);

    // Cleanup runs in ctx.waitUntil — poll briefly for the object to disappear.
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = (await env.PHOTOS.get(`comments/${id}/0.jpg`)) === null;
      if (!gone) await new Promise((r) => setTimeout(r, 25));
    }
    expect(gone).toBe(true);
  });

  it('keeps reports the deleted account filed as a moderation record', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Doomed Reporter');
    const { id } = await createComment(author, { waypointId: 'delme-report-wp' });
    expect((await reportComment(reporter, id, { reason: 'spam' })).status).toBe(201);

    expect((await deleteMe(reporter)).status).toBe(204);

    const row = await env.DB.prepare(
      `SELECT reason FROM comment_reports WHERE comment_id = ? AND user_id = ?`
    )
      .bind(id, reporter.userId)
      .first<{ reason: string }>();
    expect(row?.reason).toBe('spam');
  });
});
