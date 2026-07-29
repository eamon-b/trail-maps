import { ApiError, NetworkError, apiRequest } from '../client';

interface FakeResponseInit {
  status: number;
  body?: unknown;
  raw?: string;
}

function makeFetch(init: FakeResponseInit | (() => never)) {
  return jest.fn(async () => {
    if (typeof init === 'function') return init();
    const raw = init.raw ?? (init.body === undefined ? '' : JSON.stringify(init.body));
    return {
      ok: init.status >= 200 && init.status < 300,
      status: init.status,
      statusText: 'Status',
      text: async () => raw,
    };
  }) as unknown as typeof fetch;
}

const BASE = 'https://api.test';

describe('apiRequest', () => {
  it('parses a 2xx JSON body', async () => {
    const fetchImpl = makeFetch({ status: 200, body: { userId: 'u1' } });
    const out = await apiRequest<{ userId: string }>('/v1/me', { baseUrl: BASE, fetchImpl });
    expect(out).toEqual({ userId: 'u1' });
  });

  it('sends the bearer token and JSON body', async () => {
    const fetchImpl = makeFetch({ status: 200, body: {} });
    await apiRequest('/v1/comments/x', {
      baseUrl: BASE,
      fetchImpl,
      token: 'secret',
      method: 'PUT',
      body: { trailId: 'aawt' },
    });
    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ trailId: 'aawt' });
  });

  it('maps a non-2xx error envelope to a typed ApiError', async () => {
    const fetchImpl = makeFetch({
      status: 400,
      body: { error: { code: 'invalid_text', message: 'too long' } },
    });
    expect.assertions(3);
    try {
      await apiRequest('/v1/comments/x', { baseUrl: BASE, fetchImpl, method: 'PUT', body: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).code).toBe('invalid_text');
    }
  });

  it('returns undefined for a 204', async () => {
    const fetchImpl = makeFetch({ status: 204 });
    const out = await apiRequest('/v1/comments/x', { baseUrl: BASE, fetchImpl, method: 'DELETE' });
    expect(out).toBeUndefined();
  });

  it('wraps a transport failure in NetworkError', async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(apiRequest('/v1/me', { baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});
