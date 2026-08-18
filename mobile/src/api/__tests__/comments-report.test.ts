/**
 * Wire shape of the two endpoints added for reporting + curated descriptions:
 * one authenticated POST, one public GET with delta semantics.
 */

import { getTrailDescriptions, reportComment } from '../comments';
import { ApiError } from '../client';

const BASE = 'https://api.test';

function stubFetch(status: number, body: unknown) {
  const fn = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
  }));
  return fn as unknown as typeof fetch;
}

describe('reportComment', () => {
  it('POSTs the reason + detail with the bearer token', async () => {
    const fetchImpl = stubFetch(201, { reportId: 'rep_1' });
    const res = await reportComment(
      { baseUrl: BASE, fetchImpl, token: 'tok' },
      'c 1/danger',
      { reason: 'spam', detail: 'buy pills' },
    );

    expect(res).toEqual({ reportId: 'rep_1' });
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    // The id is path-encoded.
    expect(url).toBe(`${BASE}/v1/comments/c%201%2Fdanger/report`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ reason: 'spam', detail: 'buy pills' });
  });

  it('surfaces a 410 as a structured ApiError', async () => {
    const fetchImpl = stubFetch(410, { error: { code: 'gone', message: 'deleted' } });
    await expect(
      reportComment({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'c1', { reason: 'other' }),
    ).rejects.toMatchObject({ status: 410, code: 'gone' });
  });

  it('surfaces a 429 as a structured ApiError', async () => {
    const fetchImpl = stubFetch(429, { error: { code: 'rate_limited', message: 'slow down' } });
    const err = await reportComment(
      { baseUrl: BASE, fetchImpl, token: 'tok' },
      'c1',
      { reason: 'spam' },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });
});

describe('getTrailDescriptions', () => {
  it('GETs the public endpoint without a token', async () => {
    const fetchImpl = stubFetch(200, {
      descriptions: [{ waypointId: 'w_1', description: 'Tank.', updatedAt: 'M1' }],
      syncedAt: 'M1',
    });
    const res = await getTrailDescriptions({ baseUrl: BASE, fetchImpl, token: 'tok' }, {
      trailId: 'aawt',
    });

    expect(res.syncedAt).toBe('M1');
    expect(res.descriptions).toHaveLength(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/trails/aawt/descriptions`);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('passes `since` through for a delta read', async () => {
    const fetchImpl = stubFetch(200, { descriptions: [], syncedAt: 'M2' });
    await getTrailDescriptions({ baseUrl: BASE, fetchImpl }, {
      trailId: 'aawt',
      since: '2026-01-01T00:00:00Z',
    });
    expect(String((fetchImpl as jest.Mock).mock.calls[0][0])).toContain(
      'since=2026-01-01T00%3A00%3A00Z',
    );
  });
});
