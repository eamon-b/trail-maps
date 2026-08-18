/**
 * Thin typed fetch wrapper for the comments API.
 *
 * Two failure modes are kept distinct because the offline-first sync layer
 * treats them very differently:
 *   - `NetworkError` — the request never got an HTTP response (offline, DNS,
 *     reset). The outbox drain should STOP and retry later.
 *   - `ApiError` — the server answered with a non-2xx status. Carries the
 *     structured `{ status, code, message }` so callers can branch on 401
 *     (pause the queue) vs. 4xx validation (mark the item failed, keep it
 *     visible) vs. transient 5xx.
 *
 * The base URL is resolved from `EXPO_PUBLIC_API_BASE_URL`; when it is missing
 * (common in dev) the comments UI shows an "unconfigured" state and sync
 * no-ops, so callers should check `getBaseUrl()` before issuing requests rather
 * than relying on this module to guess.
 */

import type { ApiError as ApiErrorBody } from '@lib/comments-api-types';

/** A structured non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

export interface RequestConfig {
  /** Resolved API base URL, e.g. `http://localhost:8787`. No trailing slash. */
  baseUrl: string;
  /** Bearer token for authenticated endpoints. */
  token?: string;
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface RequestOptions extends RequestConfig {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON request body; serialized with `JSON.stringify`. */
  body?: unknown;
}

/** The configured API base URL, or `undefined` when unset. */
export function getBaseUrl(): string | undefined {
  const raw = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

/** True when the API is configured and requests can be issued. */
export function isApiConfigured(): boolean {
  return getBaseUrl() !== undefined;
}

/** A `fetch`-shaped response, structurally what both the global and mocks return. */
type ResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

/**
 * Decode a response body as JSON, mapping non-2xx statuses to `ApiError`.
 * Shared by the JSON and raw-bytes request paths. Returns `undefined` for 204s.
 */
async function decodeResponse<T>(response: ResponseLike): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  let parsed: unknown;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A body that isn't JSON on an error status is still an error.
      if (!response.ok) {
        throw new ApiError(response.status, 'http_error', raw || response.statusText || '');
      }
      throw new ApiError(response.status, 'invalid_response', 'Response body was not valid JSON');
    }
  }

  if (!response.ok) {
    const errBody = parsed as ApiErrorBody | undefined;
    const code = errBody?.error?.code ?? 'http_error';
    const message = errBody?.error?.message ?? response.statusText ?? 'Request failed';
    throw new ApiError(response.status, code, message);
  }

  return parsed as T;
}

/**
 * Issue a request and decode JSON. Throws `NetworkError` on transport failure
 * and `ApiError` on any non-2xx response. Returns `undefined` for 204s.
 */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const { baseUrl, token, fetchImpl, signal, method = 'GET', body } = options;
  const doFetch = fetchImpl ?? fetch;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}${path}`, {
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

export interface RawRequestOptions extends RequestConfig {
  method?: 'POST' | 'PUT';
  /** Raw request bytes sent verbatim as the body. */
  body: Uint8Array | ArrayBuffer;
  /** Value for the `Content-Type` header (e.g. `image/jpeg`). */
  contentType: string;
}

/**
 * Issue a request whose body is raw bytes (not JSON) under an explicit
 * `Content-Type`, decoding a JSON response. Used by the photo-upload endpoint,
 * which takes the image bytes directly. Same error contract as `apiRequest`.
 */
export async function apiRequestRaw<T>(path: string, options: RawRequestOptions): Promise<T> {
  const { baseUrl, token, fetchImpl, signal, method = 'POST', body, contentType } = options;
  const doFetch = fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': contentType,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      // RN's fetch accepts a typed-array/ArrayBuffer body; cast for the DOM types.
      body: body as unknown as BodyInit,
      signal,
    });
  } catch (cause) {
    throw new NetworkError(`Request to ${path} failed to reach the server`, cause);
  }

  return decodeResponse<T>(response);
}
