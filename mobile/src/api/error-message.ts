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
    // 401 is about the token and nothing else, so it always reads as identity.
    // A 403 is the server saying WHY this account may not do this — a banned
    // account, a link code asked for from a linked browser rather than the
    // phone — and its sentence is the only part a hiker can act on, so it is
    // shown like any other 4xx. Identity copy is the fallback when it is silent.
    if (err.status === 401) return AUTH_ERROR_MESSAGE;
    // 4xx validation messages from the API are already human-readable
    // ("displayName must be at most 40 characters"); 5xx messages are not.
    if (err.status < 500 && err.message.trim().length > 0) return err.message;
    if (err.status === 403) return AUTH_ERROR_MESSAGE;
    return fallback;
  }
  return fallback;
}
