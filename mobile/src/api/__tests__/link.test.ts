/**
 * Device linking API.
 *
 * The session wrappers matter as much as the routes: they are what keeps the
 * bearer token inside `src/api` (the Settings screen never sees it), so each
 * one is exercised through the mocked keystore rather than by handing a token
 * in from the test.
 */

import {
  createLinkCode,
  fetchDevices,
  listDevices,
  requestLinkCode,
  revokeDevice,
  revokeLinkedDevice,
  NO_IDENTITY_MESSAGE,
} from '../link';
import { getSession } from '../auth';

jest.mock('../auth', () => ({ getSession: jest.fn() }));

const mockGetSession = getSession as jest.Mock;

function scriptedFetch(steps: { status?: number; body?: unknown }[]) {
  let i = 0;
  const fn = jest.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => (status === 204 ? '' : JSON.stringify(step.body ?? {})),
    };
  });
  return fn as unknown as typeof fetch;
}

const BASE = 'https://api.test';
const calls = (fetchImpl: typeof fetch) => (fetchImpl as unknown as jest.Mock).mock.calls;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ userId: 'u1', token: 'tok', displayName: 'Me' });
});

describe('link routes', () => {
  it('POSTs for a code', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { code: 'ABCD2345', expiresAt: 'T' } }]);
    const res = await createLinkCode({ baseUrl: BASE, fetchImpl, token: 'tok' });
    expect(res.code).toBe('ABCD2345');
    expect(calls(fetchImpl)[0][0]).toBe(`${BASE}/v1/link-codes`);
    expect(calls(fetchImpl)[0][1].method).toBe('POST');
  });

  it('unwraps the devices envelope, and tolerates an empty body', async () => {
    const fetchImpl = scriptedFetch([
      { body: { devices: [{ id: 'aaaaaaaaaaaa', kind: 'primary', label: null, createdAt: 'T', lastSeenAt: null, expiresAt: null, current: true }] } },
    ]);
    const devices = await listDevices({ baseUrl: BASE, fetchImpl, token: 'tok' });
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe('primary');

    const empty = scriptedFetch([{ status: 204 }]);
    expect(await listDevices({ baseUrl: BASE, fetchImpl: empty, token: 'tok' })).toEqual([]);
  });

  it('revokes by the published device id', async () => {
    const fetchImpl = scriptedFetch([{ status: 204 }]);
    await revokeDevice({ baseUrl: BASE, fetchImpl, token: 'tok' }, 'abc123def456');
    expect(calls(fetchImpl)[0][0]).toBe(`${BASE}/v1/me/devices/abc123def456`);
    expect(calls(fetchImpl)[0][1].method).toBe('DELETE');
  });
});

describe('session wrappers', () => {
  it('read the token from the keystore, so callers never hold it', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { code: 'AAAA2222', expiresAt: 'T' } }]);
    await requestLinkCode({ baseUrl: BASE, fetchImpl });
    expect(calls(fetchImpl)[0][1].headers.Authorization).toBe('Bearer tok');

    const list = scriptedFetch([{ body: { devices: [] } }]);
    await fetchDevices({ baseUrl: BASE, fetchImpl: list });
    expect(calls(list)[0][1].headers.Authorization).toBe('Bearer tok');

    const revoke = scriptedFetch([{ status: 204 }]);
    await revokeLinkedDevice('abc123def456', { baseUrl: BASE, fetchImpl: revoke });
    expect(calls(revoke)[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('refuses to issue a request when the device has no identity', async () => {
    mockGetSession.mockResolvedValue(null);
    const fetchImpl = scriptedFetch([{ status: 201, body: {} }]);
    await expect(requestLinkCode({ baseUrl: BASE, fetchImpl })).rejects.toThrow(NO_IDENTITY_MESSAGE);
    expect(calls(fetchImpl)).toHaveLength(0);
  });
});
