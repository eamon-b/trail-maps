import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, createComment, registerDevice, url } from './helpers';
import type {
  BulkSyncResponse,
  FeedResponse,
  SyncTombstone,
} from '../../../src/lib/comments-api-types';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-waypoint feed pagination', () => {
  it('returns newest-first, excludes deleted, and round-trips the cursor', async () => {
    const device = await registerDevice();
    const wp = 'feed-page-wp';
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id, res } = await createComment(device, { waypointId: wp, text: `msg ${i}` });
      expect(res.status).toBe(201);
      created.push(id);
      await delay(2); // ensure distinct createdAt for a stable newest-first order
    }

    // Delete the middle one — it must not appear in the feed.
    const deletedId = created[2];
    await SELF.fetch(url(`/v1/comments/${deletedId}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });

    // Page through with limit=2, following the cursor.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '?limit=2';
      const res: Response = await SELF.fetch(
        url(`/v1/trails/heysen/waypoints/${wp}/comments${q}`)
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeedResponse;
      expect(body.comments.length).toBeLessThanOrEqual(2);
      for (const c of body.comments) seen.push(c.id);
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against infinite loop
    } while (cursor);

    // 4 live comments (5 created, 1 deleted), no duplicates, deleted excluded.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen).not.toContain(deletedId);

    // Newest-first: the order should be the reverse of creation for the live set.
    const expectedOrder = [created[4], created[3], created[1], created[0]];
    expect(seen).toEqual(expectedOrder);
  });
});

describe('trail-wide bulk / delta sync', () => {
  it('snapshot omits tombstones; delta returns updated rows + tombstones', async () => {
    const device = await registerDevice();
    const trail = 'larapinta';

    const a = await createComment(device, { trailId: trail, waypointId: 'bulk-wp-a', text: 'A' });
    const b = await createComment(device, { trailId: trail, waypointId: 'bulk-wp-b', text: 'B' });
    await createComment(device, { trailId: trail, waypointId: 'bulk-wp-c', text: 'C' });

    // Full snapshot (no since): 3 live rows, none flagged deleted, syncedAt present.
    const snapRes = await SELF.fetch(url(`/v1/trails/${trail}/comments`));
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as BulkSyncResponse;
    expect(snap.comments).toHaveLength(3);
    expect(snap.comments.every((c) => !('deleted' in c && c.deleted))).toBe(true);
    expect(typeof snap.syncedAt).toBe('string');
    const since = snap.syncedAt;

    // Mutate strictly after the snapshot: delete A, add a new one.
    await delay(10);
    await SELF.fetch(url(`/v1/comments/${a.id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    const d = await createComment(device, { trailId: trail, waypointId: 'bulk-wp-d', text: 'D' });
    expect(d.res.status).toBe(201);

    // Delta since snapshot: exactly the tombstone for A and the new row D.
    const deltaRes = await SELF.fetch(
      url(`/v1/trails/${trail}/comments?since=${encodeURIComponent(since)}`)
    );
    const delta = (await deltaRes.json()) as BulkSyncResponse;
    expect(delta.comments).toHaveLength(2);

    const tombstone = delta.comments.find(
      (c): c is SyncTombstone => 'deleted' in c && c.deleted === true
    );
    expect(tombstone).toBeDefined();
    expect(tombstone).toEqual({
      id: a.id,
      waypointId: 'bulk-wp-a',
      deleted: true,
      updatedAt: expect.any(String),
    });
    // B (unchanged) must NOT appear in the delta.
    expect(delta.comments.some((c) => c.id === b.id)).toBe(false);

    const live = delta.comments.find((c) => !('deleted' in c && c.deleted));
    expect(live?.id).toBe(d.id);

    // A fresh full snapshot now omits the tombstone (A deleted) → 3 live rows.
    const snap2 = (await (await SELF.fetch(url(`/v1/trails/${trail}/comments`))).json()) as BulkSyncResponse;
    expect(snap2.comments).toHaveLength(3);
    expect(snap2.comments.some((c) => c.id === a.id)).toBe(false);
  });

  it('paginates the delta feed stably with a small limit', async () => {
    const device = await registerDevice();
    const trail = 'bibbulmun';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await createComment(device, {
        trailId: trail,
        waypointId: 'bulk-page-wp',
        text: `row ${i}`,
      });
      ids.push(id);
      await delay(2);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res: Response = await SELF.fetch(url(`/v1/trails/${trail}/comments${q}`));
      const body = (await res.json()) as BulkSyncResponse;
      for (const c of body.comments) seen.push(c.id);
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
