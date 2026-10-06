/**
 * Delta-sync paging: keyset cursors — `base64("sortValue|id")` — and the
 * `since` high-water-mark boundary.
 *
 * Shared by every delta-sync endpoint (comments, descriptions, plans) so one
 * cursor format and one boundary rule exist rather than one per resource.
 */

import { HttpError } from './http';

/** Encode a keyset cursor from the last row's sort value and id. */
export function encodeCursor(sortValue: string, id: string): string {
  return btoa(`${sortValue}|${id}`);
}

/** Decode a cursor, throwing 400 on anything malformed. Null passes through. */
export function decodeCursor(raw: string | null): { sortValue: string; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not valid base64');
  }
  const sep = decoded.indexOf('|');
  if (sep === -1) {
    throw new HttpError(400, 'invalid_cursor', 'malformed cursor');
  }
  return { sortValue: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

/**
 * Add a delta feed's `since` filter on `column` (an ISO `updated_at`).
 *
 * `>=`, not `>`. Every feed stamps `syncedAt` *before* its SELECT runs and the
 * client sends that stamp back as the next `since`, so a write committed in
 * the same millisecond just after the stamp has `updated_at == since`; with
 * `>` it falls between two pulls and is never delivered. Re-delivering the
 * boundary row is free: every client applies a feed row as an idempotent
 * upsert / tombstone (and plans are last-writer-wins with an equal `updatedAt`
 * a no-op), so a row seen twice changes nothing.
 */
export function appendSinceFilter(
  conditions: string[],
  binds: unknown[],
  column: string,
  since: string
): void {
  conditions.push(`${column} >= ?`);
  binds.push(since);
}
