/**
 * Typed `fetch` wrapper for the comments/plans API, browser edition.
 *
 * The mirror of `mobile/src/api/client.ts`, and deliberately the same shape:
 * two failure modes kept apart because the sync arm treats them differently.
 *
 *   - `NetworkError` — no HTTP response at all (offline, DNS, a reset). The
 *     planner says "Offline, will retry" and tries again on `online`.
 *   - `ApiError` — the server answered non-2xx. Carries `{status, code, message}`
 *     so a caller can branch on 401 (the browser was unlinked), 409
 *     `plan_exists` (adopt the server's id) or anything else (report the code).
 *
 * The base URL comes from `VITE_API_BASE_URL`, read at call time rather than
 * at import time so a test can stub it. When it is unset the whole sync arm is
 * hidden — callers check `getApiBase()` first rather than letting this module
 * guess an origin.
 *
 * The bearer token only ever travels in the `Authorization` header of a
 * request to that base: never in a URL, never in a log line.
 */

import type { ApiError as ApiErrorBody } from '@lib/comments-api-types';

/** A structured non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * The decoded error body, when there was one. The standard envelope is
   * `{error: {code, message}}`, but a few responses carry more beside it —
   * 409 `plan_exists` adds `existingId`, which the sync arm adopts.
   */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A request that never received an HTTP response (offline / transport error). */
export class NetworkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** Injectable fetch, structurally compatible with the global. */
export type FetchLike = typeof fetch;

export interface ApiRequestOptions {
  /** Bearer token for an authenticated endpoint. Omit for the public reads. */
  token?: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON request body; serialised with `JSON.stringify`. */
  body?: unknown;
  signal?: AbortSignal;
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Explicit origin, overriding `getApiBase()` (tests, a one-off tool). */
  baseUrl?: string;
}

/**
 * The configured API origin without a trailing slash, or `undefined` when the
 * site was built without one.
 */
export function getApiBase(): string | undefined {
  const raw = import.meta.env?.VITE_API_BASE_URL;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

/** True when the API is configured and requests can be issued. */
export function isApiConfigured(): boolean {
  return getApiBase() !== undefined;
}

/** A `fetch`-shaped response — what both the global and a test double return. */
interface ResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
}

/** Decode a response as JSON, mapping non-2xx to `ApiError`. 204 → `undefined`. */
async function decodeResponse<T>(response: ResponseLike): Promise<T> {
  if (response.status === 204) return undefined as T;

  const raw = await response.text();
  let parsed: unknown;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A body that is not JSON on an error status is still an error.
      if (!response.ok) {
        throw new ApiError(response.status, 'http_error', raw || response.statusText || '');
      }
      throw new ApiError(response.status, 'invalid_response', 'Response body was not valid JSON');
    }
  }

  if (!response.ok) {
    const envelope = parsed as ApiErrorBody | undefined;
    const code = envelope?.error?.code ?? 'http_error';
    const message = envelope?.error?.message ?? response.statusText ?? 'Request failed';
    throw new ApiError(response.status, code, message, parsed);
  }

  return parsed as T;
}

/**
 * Issue a request and decode JSON. Throws `NetworkError` when the request
 * never reached the server and `ApiError` on any non-2xx. Returns `undefined`
 * for a 204.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { token, method = 'GET', body, signal, fetchImpl, baseUrl } = options;
  const base = baseUrl ?? getApiBase();
  if (!base) {
    throw new Error('API base URL is not configured (VITE_API_BASE_URL)');
  }

  const doFetch = fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw new NetworkError(`Request to ${path} failed to reach the server`, cause);
  }

  return decodeResponse<T>(response);
}
