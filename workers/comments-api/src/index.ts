/**
 * FarOut comments API — a Cloudflare Worker over D1.
 *
 * Hand-rolled router (no framework), mirroring the sibling `contour-tiles`
 * worker: wide-open CORS, a JSON `/health` endpoint, and a single `fetch`
 * entrypoint. All application errors surface as `{ error: { code, message } }`.
 */

import { CORS_HEADERS, HttpError, errorResponse, json } from './http';
import type { Env } from './http';
import { deleteMe, getMe, registerDevice, updateMe } from './devices';
import { getTrailDescriptions, upsertTrailDescription } from './descriptions';
import { getAdminReports, reportComment } from './reports';
import {
  deleteComment,
  getAdminComments,
  getBulkSync,
  getWaypointFeed,
  putComment,
} from './comments';
import { uploadCommentPhoto } from './photos';

/** Split a pathname into decoded, non-empty segments. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0).map(decodeURIComponent);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const seg = segments(url.pathname);

  // GET /health
  if (method === 'GET' && seg.length === 1 && seg[0] === 'health') {
    return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
  }

  // Everything else lives under /v1
  if (seg[0] === 'v1') {
    const rest = seg.slice(1);

    // Handlers are `await`ed (not returned bare) so a synchronously-thrown
    // HttpError attaches its rejection handler in the same microtask — a bare
    // `return handler()` leaves the rejected promise momentarily unhandled,
    // which workerd reports as an unhandled rejection.

    // /v1/devices
    if (rest.length === 1 && rest[0] === 'devices') {
      if (method === 'POST') return await registerDevice(request, env);
      return methodNotAllowed();
    }

    // /v1/me
    if (rest.length === 1 && rest[0] === 'me') {
      if (method === 'GET') return await getMe(request, env, ctx);
      if (method === 'PATCH') return await updateMe(request, env, ctx);
      if (method === 'DELETE') return await deleteMe(request, env, ctx);
      return methodNotAllowed();
    }

    // /v1/comments/:id
    if (rest.length === 2 && rest[0] === 'comments') {
      const id = rest[1];
      if (method === 'PUT') return await putComment(request, env, ctx, id);
      if (method === 'DELETE') return await deleteComment(request, env, ctx, id);
      return methodNotAllowed();
    }

    // /v1/comments/:id/photos
    if (rest.length === 3 && rest[0] === 'comments' && rest[2] === 'photos') {
      if (method === 'POST') return await uploadCommentPhoto(request, env, ctx, rest[1]);
      return methodNotAllowed();
    }

    // /v1/comments/:id/report
    if (rest.length === 3 && rest[0] === 'comments' && rest[2] === 'report') {
      if (method === 'POST') return await reportComment(request, env, ctx, rest[1]);
      return methodNotAllowed();
    }

    // /v1/admin/comments
    if (rest.length === 2 && rest[0] === 'admin' && rest[1] === 'comments') {
      if (method === 'GET') return await getAdminComments(request, env, ctx);
      return methodNotAllowed();
    }

    // /v1/admin/reports
    if (rest.length === 2 && rest[0] === 'admin' && rest[1] === 'reports') {
      if (method === 'GET') return await getAdminReports(request, env, ctx);
      return methodNotAllowed();
    }

    // /v1/admin/trails/:trailId/descriptions/:waypointId
    if (
      rest.length === 5 &&
      rest[0] === 'admin' &&
      rest[1] === 'trails' &&
      rest[3] === 'descriptions'
    ) {
      if (method === 'PUT') {
        return await upsertTrailDescription(request, env, ctx, rest[2], rest[4]);
      }
      return methodNotAllowed();
    }

    // /v1/trails/:trailId/comments
    if (rest.length === 3 && rest[0] === 'trails' && rest[2] === 'comments') {
      if (method === 'GET') return await getBulkSync(request, env, rest[1]);
      return methodNotAllowed();
    }

    // /v1/trails/:trailId/descriptions
    if (rest.length === 3 && rest[0] === 'trails' && rest[2] === 'descriptions') {
      if (method === 'GET') return await getTrailDescriptions(request, env, rest[1]);
      return methodNotAllowed();
    }

    // /v1/trails/:trailId/waypoints/:waypointId/comments
    if (
      rest.length === 5 &&
      rest[0] === 'trails' &&
      rest[2] === 'waypoints' &&
      rest[4] === 'comments'
    ) {
      if (method === 'GET') return await getWaypointFeed(request, env, rest[1], rest[3]);
      return methodNotAllowed();
    }
  }

  return errorResponse(404, 'not_found', 'No such route');
}

function methodNotAllowed(): Response {
  return errorResponse(405, 'method_not_allowed', 'Method not allowed for this route');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.code, err.message);
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`Unhandled error: ${message}`);
      return errorResponse(500, 'internal_error', 'Internal server error');
    }
  },
};
