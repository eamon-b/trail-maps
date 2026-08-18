/**
 * User-facing copy for a failed comments-API call.
 *
 * The sync layer branches on `NetworkError` vs. `ApiError` (see `client.ts`);
 * the UI needs the same distinction expressed as a sentence a hiker can act on.
 * Offline is by far the common case out on trail, so it gets an explicit
 * "check your connection" message rather than a generic failure.
 */

import { ApiError, NetworkError } from './client';

/** Shown when the request never reached the server (offline, DNS, reset). */
export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server — check your connection and try again.";

/** Shown when the server rejected our bearer token / device identity. */
export const AUTH_ERROR_MESSAGE =
  "The server didn't accept this device's identity. Please try again later.";

/**
 * Map a thrown API failure onto user-facing copy.
 *
 * `fallback` covers everything we can't say anything specific about (5xx,
 * unconfigured base URL, unexpected throws) — pass copy that names the action
 * that failed, e.g. "Couldn't post your comment. Please try again."
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return NETWORK_ERROR_MESSAGE;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return AUTH_ERROR_MESSAGE;
    // 4xx validation messages from the API are already human-readable
    // ("displayName must be at most 40 characters"); 5xx messages are not.
    if (err.status < 500 && err.message.trim().length > 0) return err.message;
    return fallback;
  }
  return fallback;
}
