/**
 * `verifySession` — the question the sync layer asks before it replaces a
 * device's identity on a 401: is the token really dead, or did the server
 * just have a bad moment? Only a 401 is "dead"; silence is rethrown.
 */

import { verifySession } from '../auth';
import { ApiError, NetworkError } from '../client';

const BASE_URL = 'https://api.example.test';
const SESSION = { userId: 'u1', token: 't1', displayName: 'Trail Ghost' };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const deps = (fetchImpl: jest.Mock) => ({
  baseUrl: BASE_URL,
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

describe('verifySession', () => {
  it('asks GET /v1/me with the token and answers true when the server knows it', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(200, { userId: 'u1', displayName: 'Trail Ghost', isAdmin: false }),
    );

    await expect(verifySession(SESSION, deps(fetchImpl))).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/me`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
  });

  it('answers false on a 401: the token is dead', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } }),
    );
    await expect(verifySession(SESSION, deps(fetchImpl))).resolves.toBe(false);
  });

  it('rethrows anything that is not an answer about the token', async () => {
    const down = jest.fn(async () =>
      jsonResponse(503, { error: { code: 'unavailable', message: 'later' } }),
    );
    await expect(verifySession(SESSION, deps(down))).rejects.toBeInstanceOf(ApiError);

    const offline = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(verifySession(SESSION, deps(offline))).rejects.toBeInstanceOf(NetworkError);
  });
});
