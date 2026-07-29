import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  createComment,
  registerDevice,
  uploadPhoto,
  url,
} from './helpers';
import type {
  BulkSyncResponse,
  FeedResponse,
  UploadCommentPhotoResponse,
} from '../../../src/lib/comments-api-types';

/** A few bytes standing in for a real image — content is never inspected. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0a, 0x0b, 0x0c]);

/** Read a comment row's photo_urls_json + updated_at straight from D1. */
async function readRow(id: string): Promise<{ photo_urls_json: string | null; updated_at: string }> {
  const row = await env.DB.prepare(
    `SELECT photo_urls_json, updated_at FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{ photo_urls_json: string | null; updated_at: string }>();
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

describe('POST /v1/comments/:id/photos — happy path', () => {
  it('uploads a jpeg then a webp, storing bytes in R2 and returning public URLs', async () => {
    const device = await registerDevice();
    const { id, res } = await createComment(device, { waypointId: 'photo-happy-wp' });
    const created = (await res.json()) as { createdAt: string; updatedAt?: string };

    // First photo — jpeg → index 0 → .jpg
    const up1 = await uploadPhoto(device, id, JPEG_BYTES, 'image/jpeg');
    expect(up1.status).toBe(201);
    const body1 = (await up1.json()) as UploadCommentPhotoResponse;
    expect(body1.photoUrl).toBe(`https://photos.test/comments/${id}/0.jpg`);
    expect(body1.photoUrls).toEqual([body1.photoUrl]);

    // Bytes actually landed in R2 with the right content type.
    const obj = await env.PHOTOS.get(`comments/${id}/0.jpg`);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(Array.from(stored)).toEqual(Array.from(JPEG_BYTES));
    expect(obj!.httpMetadata?.contentType).toBe('image/jpeg');

    // updated_at bumped past createdAt so delta sync picks it up.
    const rowAfter1 = await readRow(id);
    expect(Date.parse(rowAfter1.updated_at)).toBeGreaterThan(Date.parse(created.createdAt));

    // Second photo — webp → index 1 → .webp
    const up2 = await uploadPhoto(device, id, WEBP_BYTES, 'image/webp');
    expect(up2.status).toBe(201);
    const body2 = (await up2.json()) as UploadCommentPhotoResponse;
    expect(body2.photoUrl).toBe(`https://photos.test/comments/${id}/1.webp`);
    expect(body2.photoUrls).toEqual([
      `https://photos.test/comments/${id}/0.jpg`,
      `https://photos.test/comments/${id}/1.webp`,
    ]);

    // Appears in the per-waypoint feed with photoUrls populated.
    const feed = (await (
      await SELF.fetch(url('/v1/trails/heysen/waypoints/photo-happy-wp/comments'))
    ).json()) as FeedResponse;
    const feedRow = feed.comments.find((c) => c.id === id);
    expect(feedRow?.photoUrls).toEqual(body2.photoUrls);

    // Appears in the trail-wide delta since creation, also with photoUrls.
    // Use createdAt - 1ms as the watermark so the row is included even if the
    // upload's updated_at lands in the same millisecond as createdAt.
    const since = new Date(Date.parse(created.createdAt) - 1).toISOString();
    const delta = (await (
      await SELF.fetch(url(`/v1/trails/heysen/comments?since=${encodeURIComponent(since)}`))
    ).json()) as BulkSyncResponse;
    const deltaRow = delta.comments.find((c) => c.id === id);
    expect(deltaRow && 'photoUrls' in deltaRow ? deltaRow.photoUrls : undefined).toEqual(
      body2.photoUrls
    );
  });

  it('omits photoUrls for comments without photos', async () => {
    const device = await registerDevice();
    await createComment(device, { waypointId: 'photo-none-wp', text: 'no pics' });
    const feed = (await (
      await SELF.fetch(url('/v1/trails/heysen/waypoints/photo-none-wp/comments'))
    ).json()) as FeedResponse;
    expect(feed.comments[0].photoUrls).toBeUndefined();
  });
});

describe('POST /v1/comments/:id/photos — authorization & existence', () => {
  it('401 without a token', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-auth-wp' });
    const res = await SELF.fetch(url(`/v1/comments/${id}/photos`), {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: JPEG_BYTES,
    });
    expect(res.status).toBe(401);
  });

  it('403 when a non-owner tries to attach a photo', async () => {
    const owner = await registerDevice('Owner');
    const stranger = await registerDevice('Stranger');
    const { id } = await createComment(owner, { waypointId: 'photo-owner-wp' });
    const res = await uploadPhoto(stranger, id, JPEG_BYTES);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('404 for a missing comment', async () => {
    const device = await registerDevice();
    const res = await uploadPhoto(device, crypto.randomUUID(), JPEG_BYTES);
    expect(res.status).toBe(404);
  });

  it('410 for a soft-deleted comment', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-del-wp' });
    await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    const res = await uploadPhoto(device, id, JPEG_BYTES);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('comment_deleted');
  });
});

describe('POST /v1/comments/:id/photos — payload limits', () => {
  it('415 for an unsupported content type', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-ct-wp' });
    const res = await uploadPhoto(device, id, JPEG_BYTES, 'image/png');
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_media_type'
    );
  });

  it('413 when the body exceeds 5 MB', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-big-wp' });
    const tooBig = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await uploadPhoto(device, id, tooBig, 'image/jpeg');
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('photo_too_large');
  });

  it('409 when a 5th photo is attached', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-max-wp' });
    for (let i = 0; i < 4; i++) {
      const ok = await uploadPhoto(device, id, JPEG_BYTES, 'image/jpeg');
      expect(ok.status).toBe(201);
    }
    const fifth = await uploadPhoto(device, id, JPEG_BYTES, 'image/jpeg');
    expect(fifth.status).toBe(409);
    expect(((await fifth.json()) as { error: { code: string } }).error.code).toBe('too_many_photos');
  });
});

describe('POST /v1/comments/:id/photos — rate limit', () => {
  it('429 once 40 photos have been uploaded in the window', async () => {
    const device = await registerDevice();
    // Seed a comment for this user with 40 photo URLs, updated just now, so the
    // daily-count query is already at the cap without 40 real HTTP uploads.
    const { id: seeded } = await createComment(device, { waypointId: 'photo-rate-seed' });
    const fakeUrls = Array.from({ length: 40 }, (_, i) => `https://photos.test/x/${i}.jpg`);
    await env.DB.prepare(`UPDATE comments SET photo_urls_json = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(fakeUrls), new Date().toISOString(), seeded)
      .run();

    const { id: fresh } = await createComment(device, { waypointId: 'photo-rate-fresh' });
    const res = await uploadPhoto(device, fresh, JPEG_BYTES, 'image/jpeg');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
  });
});

describe('DELETE /v1/comments/:id — R2 cleanup', () => {
  it('removes the comment photos from R2 on soft delete', async () => {
    const device = await registerDevice();
    const { id } = await createComment(device, { waypointId: 'photo-cleanup-wp' });
    await uploadPhoto(device, id, JPEG_BYTES, 'image/jpeg');
    await uploadPhoto(device, id, WEBP_BYTES, 'image/webp');

    expect(await env.PHOTOS.get(`comments/${id}/0.jpg`)).not.toBeNull();
    expect(await env.PHOTOS.get(`comments/${id}/1.webp`)).not.toBeNull();

    const del = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    expect(del.status).toBe(204);

    // Cleanup runs in ctx.waitUntil — poll briefly for the objects to disappear.
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      const a = await env.PHOTOS.get(`comments/${id}/0.jpg`);
      const b = await env.PHOTOS.get(`comments/${id}/1.webp`);
      gone = a === null && b === null;
      if (!gone) await new Promise((r) => setTimeout(r, 25));
    }
    expect(gone).toBe(true);
  });
});
