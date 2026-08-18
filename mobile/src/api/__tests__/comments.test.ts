import type { BulkSyncResponse } from '@lib/comments-api-types';
import { listTrailComments, listWaypointComments, putComment, uploadCommentPhoto } from '../comments';
import { ApiError } from '../client';

function jsonFetch(pages: unknown[]) {
  let call = 0;
  const fn = jest.fn(async () => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    };
  });
  return fn as unknown as typeof fetch;
}

const BASE = 'https://api.test';

describe('comments API', () => {
  it('auto-paginates listTrailComments and keeps the first page syncedAt', async () => {
    const page1: BulkSyncResponse = {
      comments: [
        {
          id: 'a',
          waypointId: 'w_1',
          displayName: 'A',
          text: 'one',
          waterStatus: null,
          observedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: 'CURSOR1',
      syncedAt: '2026-01-05T00:00:00Z',
    };
    const page2: BulkSyncResponse = {
      comments: [{ id: 'b', waypointId: 'w_2', deleted: true, updatedAt: '2026-01-02T00:00:00Z' }],
      nextCursor: null,
      syncedAt: '2026-01-05T00:00:01Z',
    };
    const fetchImpl = jsonFetch([page1, page2]);

    const result = await listTrailComments(
      { baseUrl: BASE, fetchImpl },
      { trailId: 'aawt', since: '2026-01-01T00:00:00Z' },
    );

    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(2);
    // Second request carries the cursor from page 1.
    expect((fetchImpl as jest.Mock).mock.calls[1][0]).toContain('cursor=CURSOR1');
    expect((fetchImpl as jest.Mock).mock.calls[0][0]).toContain('since=');
    expect(result.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.syncedAt).toBe('2026-01-05T00:00:00Z'); // first page
  });

  it('lists a single waypoint feed page', async () => {
    const fetchImpl = jsonFetch([{ comments: [], nextCursor: null }]);
    const res = await listWaypointComments(
      { baseUrl: BASE, fetchImpl },
      { trailId: 'aawt', waypointId: 'w_1', limit: 20 },
    );
    expect(res.nextCursor).toBeNull();
    expect((fetchImpl as jest.Mock).mock.calls[0][0]).toContain(
      '/v1/trails/aawt/waypoints/w_1/comments?limit=20',
    );
  });

  it('PUTs a comment to the id endpoint with the token', async () => {
    const fetchImpl = jsonFetch([
      {
        id: 'cid',
        waypointId: 'w_1',
        displayName: 'Me',
        text: 'hi',
        waterStatus: null,
        observedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const out = await putComment({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'cid', {
      trailId: 'aawt',
      waypointId: 'w_1',
      text: 'hi',
    });
    expect(out.id).toBe('cid');
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toContain('/v1/comments/cid');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('POSTs raw photo bytes with the image content type and auth', async () => {
    const fetchImpl = jsonFetch([
      { photoUrl: 'https://cdn/a.jpg', photoUrls: ['https://cdn/a.jpg'] },
    ]);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const out = await uploadCommentPhoto(
      { baseUrl: BASE, fetchImpl, token: 'tok' },
      'cid',
      bytes,
      'image/jpeg',
    );
    expect(out.photoUrls).toEqual(['https://cdn/a.jpg']);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/v1/comments/cid/photos');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.body).toBe(bytes); // raw bytes, not JSON-stringified
  });

  it('maps a 413 photo upload to an ApiError with the server code', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      text: async () => JSON.stringify({ error: { code: 'photo_too_large', message: 'too big' } }),
    })) as unknown as typeof fetch;
    await expect(
      uploadCommentPhoto({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'cid', new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toMatchObject({ status: 413, code: 'photo_too_large' });
    await expect(
      uploadCommentPhoto({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'cid', new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
