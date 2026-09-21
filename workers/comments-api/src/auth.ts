/**
 * Authentication: bearer-token parsing, hashing, and user lookup.
 *
 * Tokens are opaque 32-byte random strings minted at device registration. We
 * store only `sha256(token)` and compare hashes on each request, so a database
 * leak never exposes usable credentials. Read endpoints (feeds, bulk sync) are
 * public and never call these helpers.
 *
 * The lookup is against `device_tokens`, not `users.token_hash`: one account
 * may hold several tokens — the phone's `primary` one plus a `linked` token per
 * browser that was paired with a link code. A linked token expires; **rolling**
 * is implemented as `expires_at = now + 180 days` rewritten on every
 * authenticated request (rather than derived from `last_seen_at` at read time),
 * so the stored column is always the truth and `GET /v1/me/devices` can show it
 * without recomputation. Revoked or expired rows authenticate nothing.
 *
 * `users.token_hash` is still written by `POST /v1/devices` and `DELETE /v1/me`
 * for one release so a rollback to the pre-0004 worker keeps working. The only
 * thing that still reads it is `healMissingPrimaryToken`, which adopts an
 * account the 0004 backfill could not have seen.
 */

import { HttpError } from './http';
import type { Env } from './http';

export interface UserRow {
  id: string;
  display_name: string;
  token_hash: string;
  is_admin: number;
  is_banned: number;
  created_at: string;
  last_seen_at: string | null;
}

/** The kinds of device token an account can hold. */
export type TokenKind = 'primary' | 'linked';

/**
 * The authenticated user plus the token that got them here — handlers that care
 * which device is calling (the device list, revocation) read the token fields.
 */
export interface AuthUser extends UserRow {
  /** sha256 hex of the presented bearer token (the `device_tokens` primary key). */
  auth_token_hash: string;
  auth_token_kind: TokenKind;
}

/** How long a `linked` (browser) token lives past its last authenticated use. */
export const LINKED_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Opaque handle for a token in the device list / revoke route: no hash leaves the server. */
export const DEVICE_ID_LENGTH = 12;

/** The public, opaque id of a device token (never the hash itself). */
export function deviceIdFromHash(tokenHash: string): string {
  return tokenHash.slice(0, DEVICE_ID_LENGTH);
}

/** Lowercase hex SHA-256 of raw bytes. */
export async function sha256HexBytes(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return sha256HexBytes(data.buffer as ArrayBuffer);
}

/** Mint a fresh 32-byte token encoded as URL-safe base64 (no padding). */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Extract the raw bearer token from the Authorization header, or null. */
export function parseBearer(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/** The `device_tokens` row joined to its account, as the lookup returns it. */
type TokenLookupRow = UserRow & {
  token_kind: TokenKind;
  token_expires_at: string | null;
  token_revoked_at: string | null;
};

/** The one authenticating query: a token row joined to the account it belongs to. */
async function lookupToken(env: Env, tokenHash: string): Promise<TokenLookupRow | null> {
  return env.DB.prepare(
    `SELECT u.id, u.display_name, u.token_hash, u.is_admin, u.is_banned, u.created_at,
            u.last_seen_at, t.kind AS token_kind, t.expires_at AS token_expires_at,
            t.revoked_at AS token_revoked_at
       FROM device_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  )
    .bind(tokenHash)
    .first<TokenLookupRow>();
}

/**
 * Adopt a pre-0004 account that the migration's backfill missed.
 *
 * `0004`'s `INSERT … SELECT … FROM users` is a one-shot snapshot, so a phone
 * that registered against the old worker between `migrate:remote` and `deploy`
 * has a `users` row and no `device_tokens` row — and would then be refused
 * forever, since nothing else reads `users.token_hash` any more. Mint the row
 * the backfill would have written (same shape: `primary`, no label, no expiry)
 * the first time such a token is presented.
 *
 * Only reached on a lookup miss, so an ordinary request never pays for it, and
 * `INSERT OR IGNORE` makes two simultaneous first requests idempotent — both
 * then read the one row back. A revoked or expired token is not a miss — its
 * row exists — so nothing here can undo a revocation, and a banned (or
 * deleted, which is banned + anonymised) account is excluded by the SELECT.
 */
async function healMissingPrimaryToken(
  env: Env,
  tokenHash: string
): Promise<TokenLookupRow | null> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO device_tokens
       (token_hash, user_id, kind, label, created_at, last_seen_at, expires_at, revoked_at)
     SELECT token_hash, id, 'primary', NULL, created_at, last_seen_at, NULL, NULL
       FROM users WHERE token_hash = ? AND is_banned = 0`
  )
    .bind(tokenHash)
    .run();
  return lookupToken(env, tokenHash);
}

/**
 * Look up the authenticated user for this request, or null if unauthenticated,
 * revoked or expired.
 *
 * Touches the token row's `last_seen_at` (and rolls a linked token's
 * `expires_at`) best-effort — fire-and-forget via `ctx.waitUntil` when
 * available — so it never blocks the response or fails the request.
 */
export async function getUser(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<AuthUser | null> {
  const token = parseBearer(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  let row = await lookupToken(env, tokenHash);

  // Only on the miss: an account whose `device_tokens` row was never written.
  if (!row) {
    row = await healMissingPrimaryToken(env, tokenHash);
  }

  if (!row) return null;

  const nowMs = Date.now();
  if (row.token_revoked_at !== null) return null;
  if (row.token_expires_at !== null && Date.parse(row.token_expires_at) <= nowMs) return null;

  const nowIso = new Date(nowMs).toISOString();
  const rolledExpiry =
    row.token_kind === 'linked' ? new Date(nowMs + LINKED_TOKEN_TTL_MS).toISOString() : null;
  const touch = env.DB.prepare(
    `UPDATE device_tokens
        SET last_seen_at = ?, expires_at = COALESCE(?, expires_at)
      WHERE token_hash = ?`
  )
    .bind(nowIso, rolledExpiry, tokenHash)
    .run()
    .catch(() => {
      /* last_seen_at is advisory; ignore failures */
    });
  if (ctx) ctx.waitUntil(touch);

  return {
    id: row.id,
    display_name: row.display_name,
    token_hash: row.token_hash,
    is_admin: row.is_admin,
    is_banned: row.is_banned,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    auth_token_hash: tokenHash,
    auth_token_kind: row.token_kind,
  };
}

/** Require an authenticated user or throw 401. */
export async function requireUser(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<AuthUser> {
  const user = await getUser(request, env, ctx);
  if (!user) {
    throw new HttpError(401, 'unauthorized', 'A valid bearer token is required');
  }
  return user;
}

/**
 * Require the account's own `primary` token (the phone) or throw 401/403.
 *
 * A `linked` browser token is a convenience for reading and editing plans, not
 * the account itself: it must not be able to mint further link codes or delete
 * the account behind the phone's back. Anything that changes who can reach the
 * account goes through here.
 */
export async function requirePrimaryUser(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<AuthUser> {
  const user = await requireUser(request, env, ctx);
  if (user.auth_token_kind !== 'primary') {
    throw new HttpError(
      403,
      'primary_token_required',
      'This action is only available on the device that owns the account'
    );
  }
  return user;
}

/** Require an authenticated admin or throw 401/403. */
export async function requireAdmin(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<AuthUser> {
  const user = await requireUser(request, env, ctx);
  if (user.is_admin !== 1) {
    throw new HttpError(403, 'forbidden', 'Admin privileges required');
  }
  return user;
}
