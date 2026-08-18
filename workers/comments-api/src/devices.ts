/**
 * Device identity endpoints: register a device, read/update the current user.
 */

import { json, noContent, readJson } from './http';
import type { Env } from './http';
import { generateToken, requireUser, sha256Hex } from './auth';
import type { UserRow } from './auth';
import { deleteCommentPhotos } from './photos';
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

/** Display name shown for comments left by a deleted account (they're tombstoned). */
const DELETED_DISPLAY_NAME = 'Deleted user';

/**
 * DELETE /v1/me — delete the authenticated device account (Apple UGC requirement).
 *
 * The user row is scrubbed rather than removed: the feed and sync queries inner-join
 * `users`, so a hard delete would silently drop the tombstones that tell offline
 * clients the comments are gone. Instead every live comment is soft-deleted (so the
 * tombstones flow through delta sync), the row is anonymised, and `token_hash` is
 * replaced with the hash of a fresh token nobody ever sees — the account stays
 * unique but is permanently unauthenticatable.
 *
 * Reports the user filed are deliberately kept: they are a moderation record and
 * only reference the now-scrubbed row.
 */
export async function deleteMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  // Snapshot which comments have photos before the update clears the column.
  const { results: withPhotos } = await env.DB.prepare(
    `SELECT id FROM comments WHERE user_id = ? AND photo_urls_json IS NOT NULL`
  )
    .bind(user.id)
    .all<{ id: string }>();

  const now = new Date().toISOString();
  const deadTokenHash = await sha256Hex(generateToken());

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE comments
          SET deleted_at = ?, deleted_by = 'owner', updated_at = ?,
              photo_urls_json = NULL, photo_hashes_json = NULL
        WHERE user_id = ? AND deleted_at IS NULL`
    ).bind(now, now, user.id),
    env.DB.prepare(
      `UPDATE users
          SET display_name = ?, token_hash = ?, is_admin = 0, is_banned = 1
        WHERE id = ?`
    ).bind(DELETED_DISPLAY_NAME, deadTokenHash, user.id),
  ]);

  // Best-effort R2 cleanup off the response path, as with single-comment deletes.
  if (withPhotos.length > 0) {
    ctx.waitUntil(
      Promise.all(withPhotos.map((row) => deleteCommentPhotos(env, row.id))).then(() => undefined)
    );
  }

  return noContent();
}
