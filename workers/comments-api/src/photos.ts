/**
 * Photo attachments for comments.
 *
 * Storage: R2 (`PHOTOS` binding), objects keyed `comments/{commentId}/{index}.{ext}`.
 * Public reads happen directly against `PHOTOS_PUBLIC_BASE` (the bucket's r2.dev
 * URL); the worker only ever returns full public URLs. The comment row carries a
 * JSON array of those URLs in `photo_urls_json` (NULL = none).
 */

import { HttpError, json } from './http';
import type { Env } from './http';
import { requireUser, sha256HexBytes } from './auth';
import type { CommentRow } from './comments';
import type {
  PhotoContentType,
  UploadCommentPhotoResponse,
} from '../../../src/lib/comments-api-types';

/** Max photos attachable to a single comment. */
const MAX_PHOTOS_PER_COMMENT = 4;
/** Max size of a single uploaded image. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Max photo uploads a single user may make in a rolling 24h window. */
const PHOTO_RATE_LIMIT_PER_DAY = 40;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const CONTENT_TYPE_EXT: Record<PhotoContentType, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Parse `photo_urls_json` into a string array. Returns undefined for NULL/empty
 * or anything that isn't a JSON array of strings, so callers can omit the field.
 */
export function parsePhotoUrls(raw: string | null): string[] | undefined {
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((u) => typeof u !== 'string')) {
    return undefined;
  }
  return parsed.length > 0 ? (parsed as string[]) : undefined;
}

/**
 * Parse `photo_hashes_json` into a string array of sha-256 hex digests, parallel
 * to `photo_urls_json`. Rows predating the column are NULL → empty list, so
 * their photos simply aren't dedupe-protected.
 */
export function parsePhotoHashes(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.some((h) => typeof h !== 'string')) {
    return [];
  }
  return parsed as string[];
}

/** Extract + validate the request's image content type, or throw 415. */
function requirePhotoContentType(request: Request): PhotoContentType {
  const header = request.headers.get('Content-Type') ?? '';
  const type = header.split(';', 1)[0].trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/webp') {
    return type;
  }
  throw new HttpError(
    415,
    'unsupported_media_type',
    'Photo Content-Type must be image/jpeg or image/webp'
  );
}

// ---------------------------------------------------------------------------
// POST /v1/comments/:id/photos — attach an image (owner only)
// ---------------------------------------------------------------------------

export async function uploadCommentPhoto(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`)
    .bind(id)
    .first<CommentRow>();
  if (!row) {
    throw new HttpError(404, 'not_found', 'Comment not found');
  }
  if (row.deleted_at !== null) {
    // Tombstoned — its photos are being (or have been) removed from R2.
    throw new HttpError(410, 'comment_deleted', 'Comment has been deleted');
  }
  if (row.user_id !== user.id) {
    throw new HttpError(403, 'forbidden', 'You may only add photos to your own comments');
  }

  const contentType = requirePhotoContentType(request);

  // Cheap pre-check from Content-Length before buffering the body.
  const declaredLen = request.headers.get('Content-Length');
  if (declaredLen !== null && Number(declaredLen) > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'Photo must be at most 5 MB');
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new HttpError(400, 'empty_photo', 'Photo body must not be empty');
  }
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'Photo must be at most 5 MB');
  }

  const existing = parsePhotoUrls(row.photo_urls_json) ?? [];
  const hashes = parsePhotoHashes(row.photo_hashes_json);
  const hash = await sha256HexBytes(bytes);

  // Replay detection: a retried upload of bytes we already stored is a success,
  // not a new photo. It short-circuits ahead of the quota checks so a client
  // retrying its 4th photo isn't told the comment is full, and neither R2 nor the
  // row is touched.
  const replayIndex = hashes.indexOf(hash);
  if (replayIndex !== -1 && replayIndex < existing.length) {
    const replay: UploadCommentPhotoResponse = {
      photoUrl: existing[replayIndex],
      photoUrls: existing,
    };
    return json(replay, 200);
  }

  if (existing.length >= MAX_PHOTOS_PER_COMMENT) {
    throw new HttpError(
      409,
      'too_many_photos',
      `A comment may have at most ${MAX_PHOTOS_PER_COMMENT} photos`
    );
  }

  // Daily upload cap — mirror the comment rate-limit pattern, summing the photo
  // counts of comments this user has touched in the last 24h.
  const nowMs = Date.now();
  const windowStart = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  const countRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(json_array_length(photo_urls_json)), 0) AS n
       FROM comments
      WHERE user_id = ? AND photo_urls_json IS NOT NULL AND updated_at >= ?`
  )
    .bind(user.id, windowStart)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= PHOTO_RATE_LIMIT_PER_DAY) {
    throw new HttpError(
      429,
      'rate_limited',
      `Photo upload limit of ${PHOTO_RATE_LIMIT_PER_DAY} per day reached`
    );
  }

  const index = existing.length;
  const ext = CONTENT_TYPE_EXT[contentType];
  const key = `comments/${id}/${index}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });

  const base = env.PHOTOS_PUBLIC_BASE.replace(/\/+$/, '');
  const photoUrl = `${base}/${key}`;
  const photoUrls = [...existing, photoUrl];
  // Hashes stay index-aligned with URLs; a NULL/garbled legacy column is padded
  // so `photo_hashes_json[i]` always describes `photo_urls_json[i]`.
  const photoHashes = [...existing.map((_, i) => hashes[i] ?? ''), hash];

  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `UPDATE comments
        SET photo_urls_json = ?, photo_hashes_json = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(JSON.stringify(photoUrls), JSON.stringify(photoHashes), nowIso, id)
    .run();

  const payload: UploadCommentPhotoResponse = { photoUrl, photoUrls };
  return json(payload, 201);
}

/**
 * Best-effort removal of every R2 object under a comment's prefix. Called from
 * soft-delete via `ctx.waitUntil` so tombstoned comments don't leak images.
 * Already-cached client URLs may 404 afterwards — that's acceptable.
 */
export async function deleteCommentPhotos(env: Env, commentId: string): Promise<void> {
  const prefix = `comments/${commentId}/`;
  const listed = await env.PHOTOS.list({ prefix });
  const keys = listed.objects.map((o) => o.key);
  if (keys.length > 0) {
    await env.PHOTOS.delete(keys);
  }
}
