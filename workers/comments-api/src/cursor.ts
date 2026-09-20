/**
 * Keyset pagination cursors — `base64("sortValue|id")`.
 *
 * Shared by every delta-sync endpoint (comments, plans) so one cursor format
 * exists rather than one per resource.
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
