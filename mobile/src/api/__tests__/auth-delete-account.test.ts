/**
 * `deleteAccount` — the one auth call whose failure mode has teeth.
 *
 * Clearing the keystore is irreversible (the raw token is issued once), so the
 * local session may only be dropped when the server has actually deleted the
 * account, or when the token is already dead. A network failure must leave the
 * session intact so the user can retry.
 */

import * as SecureStore from 'expo-secure-store';
import { deleteAccount, saveSession, getSession } from '../auth';

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

const noContent = {
  ok: true,
  status: 204,
  text: async () => '',
} as unknown as Response;

beforeEach(async () => {
  jest.clearAllMocks();
  await SecureStore.deleteItemAsync('tracknotes.commentSession');
});

describe('deleteAccount', () => {
  it('sends an authenticated DELETE and forgets the session', async () => {
    await saveSession(SESSION);
    const fetchImpl = jest.fn(async () => noContent);

    await deleteAccount({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/me`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
    expect(await getSession()).toBeNull();
  });

  it('treats a 401 as already-deleted and clears the stale token', async () => {
    await saveSession(SESSION);
    const fetchImpl = jest.fn(async () =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } }),
    );

    await expect(
      deleteAccount({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();

    expect(await getSession()).toBeNull();
  });

  it('rethrows a transport failure and keeps the session', async () => {
    await saveSession(SESSION);
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      deleteAccount({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/failed to reach the server/);

    expect(await getSession()).toEqual(SESSION);
  });

  it('rethrows a server error and keeps the session', async () => {
    await saveSession(SESSION);
    const fetchImpl = jest.fn(async () =>
      jsonResponse(500, { error: { code: 'internal', message: 'boom' } }),
    );

    await expect(
      deleteAccount({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('boom');

    expect(await getSession()).toEqual(SESSION);
  });

  it('is a no-op (beyond clearing) when this device has no identity', async () => {
    const fetchImpl = jest.fn(async () => noContent);

    await deleteAccount({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
