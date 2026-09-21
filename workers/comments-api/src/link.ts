/**
 * Linking a browser to the phone's account.
 *
 * The phone (an authenticated `primary` token) mints a short code; the browser
 * posts that code unauthenticated and receives a `linked` token for the same
 * user. There is no email and no password, so the code is the whole secret:
 * it is 8 characters from a 32-symbol alphabet (~40 bits), lives 10 minutes,
 * works once, and the exchange endpoint is capped per IP so the space cannot
 * be walked.
 */

import { HttpError, json, noContent, readJson } from './http';
import type { Env } from './http';
import {
  DEVICE_ID_LENGTH,
  LINKED_TOKEN_TTL_MS,
  deviceIdFromHash,
  generateToken,
  requirePrimaryUser,
  requireUser,
  sha256Hex,
} from './auth';
import type { TokenKind } from './auth';
import { RATE_BUCKETS, assertUnderRateLimit, recordRateEvent } from './rate-limit';
import type {
  DeviceTokenSummary,
  DevicesResponse,
  LinkCodeResponse,
  LinkDeviceResponse,
} from '../../../src/lib/comments-api-types';

/** No 0/O or 1/I: a code is read off a screen and typed on another device. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
/** Live (unused, unexpired) codes one account may hold at once. */
const MAX_LIVE_CODES = 5;
const MAX_LABEL_LEN = 60;
/**
 * How long a dead code lingers before the next mint sweeps it up. A code is
 * only good for 10 minutes, so a day is far past any use; the lag just keeps
 * the sweep clear of the row a request is using.
 */
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Random code from the ambiguity-free alphabet (32 symbols = no modulo bias). */
function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Accept a code however it was typed: spaces, dashes and lower case all fine. */
function normaliseCode(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_code', 'code is required');
  }
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

function validateLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_label', 'label must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_LABEL_LEN);
}

interface DeviceTokenRow {
  token_hash: string;
  kind: TokenKind;
  label: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// POST /v1/link-codes — the phone mints a code
// ---------------------------------------------------------------------------

export async function createLinkCode(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // The phone only: a linked browser must not be able to link further browsers.
  const user = await requirePrimaryUser(request, env, ctx);

  const now = new Date();
  const nowIso = now.toISOString();
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_codes
      WHERE user_id = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(user.id, nowIso)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_CODES) {
    throw new HttpError(
      429,
      'too_many_codes',
      `At most ${MAX_LIVE_CODES} link codes may be live at once`
    );
  }

  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();

  // Codes are short, so a collision with a live code is possible; retry rather
  // than hand the phone a code that belongs to someone else's account.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const inserted = await env.DB.prepare(
      `INSERT INTO link_codes (code, user_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(code) DO NOTHING
       RETURNING code`
    )
      .bind(code, user.id, nowIso, expiresAt)
      .first<{ code: string }>();
    if (inserted) {
      pruneExpiredCodes(env, now.getTime(), ctx);
      const payload: LinkCodeResponse = { code, expiresAt };
      return json(payload, 201);
    }
  }

  throw new HttpError(500, 'code_unavailable', 'Could not mint a link code, try again');
}

/**
 * Sweep long-dead codes off the whole table, not just this user's.
 *
 * Minting is the only thing that adds rows, so doing it here keeps the table
 * proportional to how much linking actually happens. Used and expired rows are
 * equally dead: `expires_at` is 10 minutes after the mint either way.
 */
function pruneExpiredCodes(env: Env, nowMs: number, ctx?: ExecutionContext): void {
  const cutoff = new Date(nowMs - CODE_RETENTION_MS).toISOString();
  const prune = env.DB.prepare(`DELETE FROM link_codes WHERE expires_at < ?`)
    .bind(cutoff)
    .run()
    .catch(() => {
      /* housekeeping; never fail a mint over it */
    });
  if (ctx) ctx.waitUntil(prune);
}

// ---------------------------------------------------------------------------
// POST /v1/devices/link — the browser exchanges the code for a token
// ---------------------------------------------------------------------------

export async function linkDevice(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const nowMs = Date.now();

  // Counted before the code is even looked at: a wrong guess must cost an
  // attempt, otherwise the limit protects nothing.
  await assertUnderRateLimit(
    env,
    RATE_BUCKETS.deviceLink,
    ip,
    nowMs,
    `Too many link attempts; try again later`
  );
  await recordRateEvent(env, RATE_BUCKETS.deviceLink, ip, nowMs, ctx);

  const body = await readJson(request);
  const code = normaliseCode(body.code);
  const label = validateLabel(body.label);
  const now = new Date(nowMs).toISOString();

  const invalid = new HttpError(404, 'code_invalid', 'That code is not valid or has expired');

  const row = await env.DB.prepare(`SELECT * FROM link_codes WHERE code = ?`)
    .bind(code)
    .first<{ code: string; user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at !== null || Date.parse(row.expires_at) <= nowMs) {
    throw invalid;
  }

  // Single use, race-safe: only the UPDATE that actually flips `used_at` wins.
  const claimed = await env.DB.prepare(
    `UPDATE link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL`
  )
    .bind(now, code)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    throw invalid;
  }

  const user = await env.DB.prepare(
    `SELECT id, display_name, is_banned FROM users WHERE id = ?`
  )
    .bind(row.user_id)
    .first<{ id: string; display_name: string; is_banned: number }>();
  // A deleted account is banned and anonymised; its codes must not mint tokens.
  if (!user || user.is_banned === 1) {
    throw invalid;
  }

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(nowMs + LINKED_TOKEN_TTL_MS).toISOString();

  await env.DB.prepare(
    `INSERT INTO device_tokens (token_hash, user_id, kind, label, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, 'linked', ?, ?, ?, ?, NULL)`
  )
    .bind(tokenHash, user.id, label, now, now, expiresAt)
    .run();

  const payload: LinkDeviceResponse = {
    userId: user.id,
    token,
    displayName: user.display_name,
    expiresAt,
  };
  return json(payload, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/me/devices — what is signed in to this account
// ---------------------------------------------------------------------------

export async function listDevices(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  const { results } = await env.DB.prepare(
    `SELECT token_hash, kind, label, created_at, last_seen_at, expires_at
       FROM device_tokens
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC, token_hash ASC`
  )
    .bind(user.id)
    .all<DeviceTokenRow>();

  const devices: DeviceTokenSummary[] = results.map((row) => ({
    id: deviceIdFromHash(row.token_hash),
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.token_hash === user.auth_token_hash,
  }));

  const payload: DevicesResponse = { devices };
  return json(payload);
}

// ---------------------------------------------------------------------------
// DELETE /v1/me/devices/:id — revoke one linked token
// ---------------------------------------------------------------------------

export async function revokeDevice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deviceId: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  // The id is exactly the published prefix: a shorter one would match several
  // of the user's tokens and revoke whichever the index happened to return.
  if (!new RegExp(`^[0-9a-f]{${DEVICE_ID_LENGTH}}$`).test(deviceId)) {
    throw new HttpError(404, 'not_found', 'No such device');
  }

  const row = await env.DB.prepare(
    `SELECT token_hash, kind FROM device_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND substr(token_hash, 1, ?) = ?`
  )
    .bind(user.id, DEVICE_ID_LENGTH, deviceId)
    .first<{ token_hash: string; kind: TokenKind }>();
  if (!row) {
    throw new HttpError(404, 'not_found', 'No such device');
  }
  if (row.kind === 'primary') {
    throw new HttpError(
      400,
      'primary_token',
      'The primary device cannot be revoked here — delete the account instead'
    );
  }

  await env.DB.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ?`)
    .bind(new Date().toISOString(), row.token_hash)
    .run();

  return noContent();
}
