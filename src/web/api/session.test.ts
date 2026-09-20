/**
 * The linked-browser session: the token this browser holds, how it gets one,
 * and how it gives it back.
 *
 * The token is the only credential the web planner has, so what is tested here
 * is mostly about not holding on to one that is no good: an expired session is
 * dropped on read, a revoked one is dropped on the 401, and unlinking clears
 * it whether or not the server could be told.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError } from './client';
import {
  clearSession,
  defaultDeviceLabel,
  isSessionExpired,
  linkDevice,
  loadSession,
  normaliseLinkCode,
  saveSession,
  unlinkThisBrowser,
  type WebSession,
} from './session';

const KEY = 'tracknotes.webSession';

/** A `fetch` double: each call takes the next scripted response. */
interface Scripted {
  status: number;
  body?: unknown;
}

function mockFetch(responses: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: { error: { code: 'unscripted', message: 'no response scripted' } } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: '',
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const session = (over: Partial<WebSession> = {}): WebSession => ({
  userId: 'u1',
  token: 'tok_secret',
  displayName: 'Robin',
  expiresAt: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('the stored session', () => {
  it('round-trips through localStorage', () => {
    saveSession(session({ expiresAt: '2099-01-01T00:00:00.000Z' }));
    expect(loadSession()).toEqual(session({ expiresAt: '2099-01-01T00:00:00.000Z' }));
  });

  it('is nothing at all when the key is absent, corrupt or the wrong shape', () => {
    expect(loadSession()).toBeNull();
    localStorage.setItem(KEY, 'not json');
    expect(loadSession()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ userId: 'u1' }));
    expect(loadSession()).toBeNull();
  });

  it('drops an expired token rather than handing one out to fail', () => {
    const stale = session({ expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(isSessionExpired(stale)).toBe(true);
    saveSession(stale);
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('treats a session with no expiry as live', () => {
    expect(isSessionExpired(session())).toBe(false);
  });

  it('clears', () => {
    saveSession(session());
    clearSession();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The code and the label
// ---------------------------------------------------------------------------

describe('the link code', () => {
  it('is read however it was typed', () => {
    expect(normaliseLinkCode(' ab2d-3f4g ')).toBe('AB2D3F4G');
  });
});

describe('the device label', () => {
  it('names the browser and the system', () => {
    expect(
      defaultDeviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      defaultDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    ).toBe('Firefox on Windows');
    expect(defaultDeviceLabel('')).toBe('Browser');
  });
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

describe('linking this browser', () => {
  it('exchanges the code and saves what comes back', async () => {
    const { impl, calls } = mockFetch([
      {
        status: 201,
        body: {
          userId: 'u9',
          token: 'tok_linked',
          displayName: 'Robin',
          expiresAt: '2099-03-01T00:00:00.000Z',
        },
      },
    ]);

    const linked = await linkDevice(' ab2d-3f4g ', ' Chrome on macOS ', { fetchImpl: impl });

    expect(linked).toEqual({
      userId: 'u9',
      token: 'tok_linked',
      displayName: 'Robin',
      expiresAt: '2099-03-01T00:00:00.000Z',
    });
    expect(loadSession()).toEqual(linked);

    expect(calls[0].url).toBe('https://api.example.test/v1/devices/link');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      code: 'AB2D3F4G',
      label: 'Chrome on macOS',
    });
    // No credential on an unauthenticated exchange, and none in the URL.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('surfaces a bad code as an ApiError and stores nothing', async () => {
    const { impl } = mockFetch([
      { status: 404, body: { error: { code: 'code_invalid', message: 'That code is not valid' } } },
    ]);

    await expect(linkDevice('AB2D3F4G', 'Chrome', { fetchImpl: impl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'code_invalid',
    });
    expect(loadSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unlinking
// ---------------------------------------------------------------------------

describe('unlinking this browser', () => {
  it('revokes the token this browser is using, then forgets it', async () => {
    saveSession(session());
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: {
          devices: [
            { id: 'aaaaaaaaaaaa', kind: 'primary', label: null, createdAt: '', lastSeenAt: null, expiresAt: null, current: false },
            { id: 'bbbbbbbbbbbb', kind: 'linked', label: 'Chrome', createdAt: '', lastSeenAt: null, expiresAt: null, current: true },
          ],
        },
      },
      { status: 204 },
    ]);

    const result = await unlinkThisBrowser(session(), { fetchImpl: impl });

    expect(result.revoked).toBe(true);
    expect(calls[1].url).toBe('https://api.example.test/v1/me/devices/bbbbbbbbbbbb');
    expect(calls[1].init.method).toBe('DELETE');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok_secret');
    expect(loadSession()).toBeNull();
  });

  it('forgets the token even when the server says it is already gone', async () => {
    saveSession(session());
    const { impl } = mockFetch([
      { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
    ]);

    const result = await unlinkThisBrowser(session(), { fetchImpl: impl });

    expect(result.revoked).toBe(false);
    expect(loadSession()).toBeNull();
  });

  it('forgets the token when the server cannot be reached at all', async () => {
    saveSession(session());
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(unlinkThisBrowser(session(), { fetchImpl: impl })).resolves.toEqual({
      revoked: false,
    });
    expect(loadSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The error type itself
// ---------------------------------------------------------------------------

describe('ApiError', () => {
  it('keeps the whole body, so a 409 can carry the id to adopt', () => {
    const err = new ApiError(409, 'plan_exists', 'taken', { existingId: 'p1' });
    expect((err.body as { existingId: string }).existingId).toBe('p1');
  });
});
