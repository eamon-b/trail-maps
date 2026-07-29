/**
 * Shared HTTP helpers: the worker environment binding, CORS, and JSON/error
 * response builders. Kept dependency-free so every module (auth, devices,
 * comments, router) can import it without cycles.
 */

import type { ApiError } from '../../../src/lib/comments-api-types';

export interface Env {
  DB: D1Database;
}

/** Wide-open CORS — this is a public, read-mostly hobby API. */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** Build a JSON response with CORS headers attached. */
export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...extra,
    },
  });
}

/** Build a `{ error: { code, message } }` response. */
export function errorResponse(status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status);
}

/** A 204 with no body but with CORS headers. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Thrown by handlers/validators to short-circuit with a specific status. The
 * router catches it and renders the standard error envelope.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Parse a JSON request body, throwing a 400 HttpError on malformed input. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}
