import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  banUser,
  createComment,
  makeAdmin,
  putComment,
  registerDevice,
  url,
} from './helpers';
import type { FeedComment } from '../../../src/lib/comments-api-types';

describe('PUT /v1/comments/:id — idempotent create', () => {
  it('creates a comment (201) then replays it (200) with one stored row', async () => {
    const device = await registerDevice();
    const id = crypto.randomUUID();
    const body = { trailId: 'heysen', waypointId: 'creek-crossing', text: 'Flowing well.' };

    const first = await putComment(device, id, body);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as FeedComment;
    expect(firstBody.id).toBe(id);

    const second = await putComment(device, id, body);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as FeedComment;
    expect(secondBody.createdAt).toBe(firstBody.createdAt); // same row

    // Exactly one row in the feed.
    const feed = await SELF.fetch(
      url('/v1/trails/heysen/waypoints/creek-crossing/comments')
    );
    const feedBody = (await feed.json()) as { comments: FeedComment[] };
    expect(feedBody.comments).toHaveLength(1);
  });

  it('returns 409 when the id belongs to another user', async () => {
    const a = await registerDevice('User A');
    const b = await registerDevice('User B');
    const id = crypto.randomUUID();
    const body = { trailId: 'heysen', waypointId: 'lookout-hill', text: 'Nice view.' };

    expect((await putComment(a, id, body)).status).toBe(201);
    const conflict = await putComment(b, id, body);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      'id_conflict'
    );
  });

  it('accepts a water-only report (no text)', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { text: null, waterStatus: 'low' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as FeedComment;
    expect(body.text).toBeNull();
    expect(body.waterStatus).toBe('low');
  });
});

describe('validation', () => {
  it('rejects a non-allowlisted trail', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { trailId: 'pacific-crest' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_trail');
  });

  it('rejects a bad waypoint id', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { waypointId: 'no' }); // too short
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_waypoint');
  });

  it('rejects text longer than 2000 chars', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { text: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_text');
  });

  it('rejects a comment with neither text nor water status', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { text: null, waterStatus: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('empty_comment');
  });

  it('rejects an invalid water status', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { text: null, waterStatus: 'trickle' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_water_status'
    );
  });

  it('rejects a non-uuid comment id', async () => {
    const device = await registerDevice();
    const res = await putComment(device, 'not-a-uuid', {
      trailId: 'heysen',
      waypointId: 'spring-01',
      text: 'hi',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_comment_id');
  });

  it('clamps a far-future observedAt to <= now + 10min', async () => {
    const device = await registerDevice();
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { res } = await createComment(device, { observedAt: farFuture });
    expect(res.status).toBe(201);
    const body = (await res.json()) as FeedComment;
    const observedMs = Date.parse(body.observedAt as string);
    expect(observedMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000);
    expect(observedMs).toBeLessThan(Date.parse(farFuture));
  });
});

describe('moderation guards', () => {
  it('returns 403 for a banned user', async () => {
    const device = await registerDevice();
    await banUser(device.userId);
    const { res } = await createComment(device);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('banned');
  });

  it('rate-limits at the 61st comment in 24h', async () => {
    const device = await registerDevice();
    for (let i = 0; i < 60; i++) {
      const { res } = await createComment(device, {
        waypointId: 'rate-test-wp',
        text: `comment ${i}`,
      });
      expect(res.status).toBe(201);
    }
    const { res } = await createComment(device, { waypointId: 'rate-test-wp', text: 'one too many' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
  });
});

describe('DELETE /v1/comments/:id — soft delete', () => {
  it('owner can delete (204) and it drops out of the feed; repeat is idempotent', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'del-wp-owner' });

    const del = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    expect(del.status).toBe(204);

    const feed = await SELF.fetch(url('/v1/trails/heysen/waypoints/del-wp-owner/comments'));
    expect(((await feed.json()) as { comments: unknown[] }).comments).toHaveLength(0);

    // Idempotent second delete.
    const again = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    expect(again.status).toBe(204);
  });

  it('admin can delete another user comment', async () => {
    const author = await registerDevice('Author');
    const admin = await registerDevice('Admin');
    await makeAdmin(admin.userId);
    const { id } = await createComment(author, { waypointId: 'del-wp-admin' });

    const del = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(admin),
    });
    expect(del.status).toBe(204);

    // deleted_by recorded as 'admin' — visible via the admin listing.
    const list = await SELF.fetch(url('/v1/admin/comments'), { headers: authHeaders(admin) });
    const body = (await list.json()) as {
      comments: { id: string; deletedBy: string | null }[];
    };
    const row = body.comments.find((c) => c.id === id);
    expect(row?.deletedBy).toBe('admin');
  });

  it('a stranger cannot delete (403)', async () => {
    const author = await registerDevice('Author');
    const stranger = await registerDevice('Stranger');
    const { id } = await createComment(author, { waypointId: 'del-wp-stranger' });

    const del = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(stranger),
    });
    expect(del.status).toBe(403);
  });

  it('returns 404 for a missing comment', async () => {
    const device = await registerDevice();
    const del = await SELF.fetch(url(`/v1/comments/${crypto.randomUUID()}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    expect(del.status).toBe(404);
  });
});

describe('admin listing authorization', () => {
  it('is 403 for a non-admin', async () => {
    const device = await registerDevice();
    const res = await SELF.fetch(url('/v1/admin/comments'), { headers: authHeaders(device) });
    expect(res.status).toBe(403);
  });
});
