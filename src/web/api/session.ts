/**
 * The linked-browser session: this browser borrowing the phone's account.
 *
 * There is no email and no password anywhere in Tracknotes. The phone holds
 * the primary device token; a browser gets its own `linked` token by typing
 * an 8-character code the phone mints, and that token expires (180 days,
 * rolling) and can be revoked from the phone's device list. It lives in
 * `localStorage` under `tracknotes.webSession`, which is the weaker of the two
 * platforms' stores — hence the separate, expiring, revocable token rather
 * than a copy of the phone's.
 *
 * Every accessor swallows storage failures (private mode, blocked cookies) and
 * reports them by returning null: a planner with no session is a planner that
 * keeps plans locally, which is exactly the unconfigured behaviour.
 */

import type { DevicesResponse, LinkDeviceResponse } from '@lib/comments-api-types';
import { apiRequest, getApiBase, type FetchLike } from './client';

const SESSION_KEY = 'tracknotes.webSession';

/** The persisted linked-browser identity. */
export interface WebSession {
  userId: string;
  /** Bearer token. Never logged, never in a URL, never sent anywhere but the API base. */
  token: string;
  displayName: string;
  /** ISO timestamp the token stops working, or null if the server gave none. */
  expiresAt: string | null;
}

/** Injection points for the tests. */
export interface SessionDeps {
  fetchImpl?: FetchLike;
}

function isSession(value: unknown): value is WebSession {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.userId === 'string' &&
    typeof obj.token === 'string' &&
    typeof obj.displayName === 'string' &&
    (obj.expiresAt === null || typeof obj.expiresAt === 'string')
  );
}

/** True when the token's expiry has passed. A session with no expiry never does. */
export function isSessionExpired(session: WebSession, now: number = Date.now()): boolean {
  if (!session.expiresAt) return false;
  const at = Date.parse(session.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * The stored session, or null when this browser has none.
 *
 * An expired token is dropped here rather than handed out to fail on the next
 * request: the UI should say "link this browser again", not "sync failed".
 */
export function loadSession(): WebSession | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSession(parsed)) return null;
  if (isSessionExpired(parsed)) {
    clearSession();
    return null;
  }
  return parsed;
}

/** Persist the session. Returns false when storage refused it. */
export function saveSession(session: WebSession): boolean {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** Forget this browser's identity (unlinked, expired, or a 401). */
export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do: a storage that cannot be written cannot hold a session.
  }
}

// ---------------------------------------------------------------------------
// The link code
// ---------------------------------------------------------------------------

/**
 * A code as the server wants it: no spaces or dashes, upper case.
 *
 * The phone shows the code in groups and people type it back with whatever
 * separators they saw, so this is forgiving on the way in. The server
 * normalises identically; doing it here too keeps the length check honest.
 */
export function normaliseLinkCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** Characters in a link code, as minted by `workers/comments-api/src/link.ts`. */
export const LINK_CODE_LENGTH = 8;

/**
 * A default label for the device list, from the user agent: "Chrome on macOS".
 *
 * Deliberately crude and dependency-free — it names a browser in a list of at
 * most a handful, and the field is editable before it is sent.
 */
export function defaultDeviceLabel(userAgent: string): string {
  const browser =
    /\bEdg\//.test(userAgent) ? 'Edge'
    : /\bOPR\//.test(userAgent) ? 'Opera'
    : /\bFirefox\//.test(userAgent) ? 'Firefox'
    : /\bChrome\//.test(userAgent) ? 'Chrome'
    : /\bSafari\//.test(userAgent) ? 'Safari'
    : 'Browser';

  const os =
    /\bWindows\b/.test(userAgent) ? 'Windows'
    : /\b(iPhone|iPad|iPod)\b/.test(userAgent) ? 'iOS'
    : /\bMac OS X\b|\bMacintosh\b/.test(userAgent) ? 'macOS'
    : /\bAndroid\b/.test(userAgent) ? 'Android'
    : /\bLinux\b|\bX11\b/.test(userAgent) ? 'Linux'
    : null;

  return os ? `${browser} on ${os}` : browser;
}

/** The label this browser offers when linking, prefilled into the dialog. */
export function thisBrowserLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return defaultDeviceLabel(ua ?? '');
}

// ---------------------------------------------------------------------------
// Linking and unlinking
// ---------------------------------------------------------------------------

/**
 * Exchange a phone-minted code for this browser's own token, and store it.
 *
 * Throws `ApiError` (`code_invalid` for an unknown, used or expired code;
 * `rate_limited` after too many attempts from one address) or `NetworkError`.
 * Nothing is persisted unless the exchange succeeded.
 */
export async function linkDevice(
  code: string,
  label: string,
  deps: SessionDeps = {},
): Promise<WebSession> {
  if (!getApiBase()) {
    throw new Error('Cannot link a browser: API base URL is not configured');
  }
  const response = await apiRequest<LinkDeviceResponse>('/v1/devices/link', {
    method: 'POST',
    body: { code: normaliseLinkCode(code), label: label.trim() || null },
    fetchImpl: deps.fetchImpl,
  });
  const session: WebSession = {
    userId: response.userId,
    token: response.token,
    displayName: response.displayName,
    expiresAt: response.expiresAt ?? null,
  };
  saveSession(session);
  return session;
}

/**
 * Revoke this browser's token on the server, then forget it here.
 *
 * The token is identified by asking the server which device is talking to it
 * (`current: true` in `GET /v1/me/devices`) rather than by storing its hash:
 * the hash is the server's business, and one round trip is cheaper than
 * another thing to keep in sync.
 *
 * The local session is cleared whatever happens — a 401 means the token was
 * already revoked from the phone, and a network failure still means this
 * browser is done with it. The return value says whether the server end was
 * actually reached, so the UI can be honest about a token the phone may still
 * list.
 */
export async function unlinkThisBrowser(
  session: WebSession,
  deps: SessionDeps = {},
): Promise<{ revoked: boolean }> {
  let revoked = false;
  try {
    const { devices } = await apiRequest<DevicesResponse>('/v1/me/devices', {
      token: session.token,
      fetchImpl: deps.fetchImpl,
    });
    const current = devices.find(device => device.current);
    if (current) {
      await apiRequest<void>(`/v1/me/devices/${encodeURIComponent(current.id)}`, {
        method: 'DELETE',
        token: session.token,
        fetchImpl: deps.fetchImpl,
      });
      revoked = true;
    }
  } catch {
    // A 401 is the expected shape of "the phone already revoked this token";
    // a network failure or a 5xx still ends with this browser forgetting it.
    // Either way there is nothing for the caller to retry.
  }
  clearSession();
  return { revoked };
}
