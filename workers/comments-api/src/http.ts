/**
 * Shared HTTP helpers: the worker environment binding, CORS, and JSON/error
 * response builders. Kept dependency-free so every module (auth, devices,
 * comments, router) can import it without cycles.
 */

import type { ApiError } from '../../../src/lib/comments-api-types';

export interface Env {
  DB: D1Database;
  /** R2 bucket holding comment photo attachments under the `comments/` prefix. */
  PHOTOS: R2Bucket;
  /** Public read base for R2 objects, e.g. the bucket's custom domain (no trailing slash needed). */
  PHOTOS_PUBLIC_BASE: string;
  /** Origin of the deployed web site; share links are built from it. */
  SITE_BASE: string;
  /**
   * Secret: Anthropic API key for the community-route AI review
   * (`community-review.ts`) and the review of reported or screen-flagged
   * comments and shared waypoints (`content-review.ts`). Optional — when
   * unset a route review is `skipped` (routes stay Unverified until an admin
   * looks), and comments and waypoints are hidden only by reporters.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Workers AI: the Llama Guard screen of new comments and shared waypoints
   * (`content-review.ts`), and the AI Gateway URL the Anthropic calls go
   * through. Optional — unbound in a test that does not stub it.
   */
  AI?: Ai;
  /** Name of the AI Gateway every model call is routed through; unset = straight to the provider. */
  AI_GATEWAY_ID?: string;
  /** Secret: the gateway's token, when it is an Authenticated Gateway. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * Overpass instances the community-route POI enrichment asks, in order,
   * comma-separated (`community-pois.ts`). Empty or unset switches the
   * enrichment off: routes are then shared without POIs.
   */
  OVERPASS_ENDPOINTS?: string;
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
