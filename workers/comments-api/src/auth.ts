/**
 * Authentication: bearer-token parsing, hashing, and user lookup.
 *
 * Tokens are opaque 32-byte random strings minted at device registration. We
 * store only `sha256(token)` and compare hashes on each request, so a database
 * leak never exposes usable credentials. Read endpoints (feeds, bulk sync) are
 * public and never call these helpers.
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

/**
 * Look up the authenticated user for this request, or null if unauthenticated.
 * Updates `last_seen_at` best-effort (fire-and-forget via `ctx.waitUntil` when
 * available) so it never blocks the response or fails the request.
 */
export async function getUser(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<UserRow | null> {
  const token = parseBearer(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const user = await env.DB.prepare(
    `SELECT id, display_name, token_hash, is_admin, is_banned, created_at, last_seen_at
       FROM users WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<UserRow>();

  if (!user) return null;

  const touch = env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), user.id)
    .run()
    .catch(() => {
      /* last_seen_at is advisory; ignore failures */
    });
  if (ctx) ctx.waitUntil(touch);

  return user;
}

/** Require an authenticated user or throw 401. */
export async function requireUser(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<UserRow> {
  const user = await getUser(request, env, ctx);
  if (!user) {
    throw new HttpError(401, 'unauthorized', 'A valid bearer token is required');
  }
  return user;
}

/** Require an authenticated admin or throw 401/403. */
export async function requireAdmin(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<UserRow> {
  const user = await requireUser(request, env, ctx);
  if (user.is_admin !== 1) {
    throw new HttpError(403, 'forbidden', 'Admin privileges required');
  }
  return user;
}
