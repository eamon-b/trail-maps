/**
 * Device identity endpoints: register a device, read/update the current user.
 */

import { json, readJson } from './http';
import type { Env } from './http';
import { generateToken, requireUser, sha256Hex } from './auth';
import type { UserRow } from './auth';
import { validateDisplayName } from './validation';
import type {
  MeResponse,
  RegisterDeviceResponse,
} from '../../../src/lib/comments-api-types';

/** POST /v1/devices — mint a new anonymous user + token. */
export async function registerDevice(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const displayName = validateDisplayName(body.displayName);

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (id, display_name, token_hash, is_admin, is_banned, created_at, last_seen_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(userId, displayName, tokenHash, now, now)
    .run();

  const payload: RegisterDeviceResponse = { userId, token, displayName };
  return json(payload, 201);
}

function meResponse(user: UserRow): MeResponse {
  return {
    userId: user.id,
    displayName: user.display_name,
    isAdmin: user.is_admin === 1,
  };
}

/** GET /v1/me — return the authenticated user's public identity. */
export async function getMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  return json(meResponse(user));
}

/** PATCH /v1/me — update the authenticated user's display name. */
export async function updateMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const body = await readJson(request);
  const displayName = validateDisplayName(body.displayName);

  await env.DB.prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
    .bind(displayName, user.id)
    .run();

  return json(meResponse({ ...user, display_name: displayName }));
}
