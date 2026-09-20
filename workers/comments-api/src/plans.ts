/**
 * Day-planner plans: one live document per (user, trail).
 *
 * Unlike comments, plans are private — every read is scoped to the
 * authenticated user, and the only public surface is a share link the owner
 * mints explicitly. The sync channel is deliberately the same shape as the
 * comment one (`since` + keyset cursor + tombstones + `syncedAt`) so the
 * mobile drain and the web client can reuse their existing machinery.
 */

import { HttpError, json, noContent, readJson } from './http';
import type { Env } from './http';
import { requireUser } from './auth';
import { decodeCursor, encodeCursor } from './cursor';
import { RATE_BUCKETS, assertUnderRateLimit, recordRateEvent } from './rate-limit';
import {
  assertClientPlanId,
  parseLimit,
  serialisePlanDocument,
  validatePlanDocument,
} from './validation';
import type { PlanDocument } from '../../../src/lib/plan-types';
import type {
  PlanSyncEntry,
  PlanSyncEntryUnion,
  PlansSyncResponse,
  SharePlanResponse,
  SharedPlanResponse,
} from '../../../src/lib/comments-api-types';

const PLANS_DEFAULT_LIMIT = 100;
const PLANS_MAX_LIMIT = 500;

/** Bytes of randomness behind a share id: 16 → 22 url-safe base64 chars. */
const SHARE_ID_BYTES = 16;

/** A row as stored in the `plans` table. */
export interface PlanRow {
  id: string;
  user_id: string;
  trail_id: string;
  document_json: string;
  share_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function parseDocument(row: PlanRow): PlanDocument {
  return JSON.parse(row.document_json) as PlanDocument;
}

function toPlanSyncEntry(row: PlanRow): PlanSyncEntry {
  return {
    id: row.id,
    trailId: row.trail_id,
    document: parseDocument(row),
    shareId: row.share_id,
    updatedAt: row.updated_at,
  };
}

/** A 22-char url-safe id with no padding (128 bits). */
function generateShareId(): string {
  const bytes = new Uint8Array(SHARE_ID_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shareUrl(env: Env, shareId: string): string {
  const base = (env.SITE_BASE ?? '').replace(/\/+$/, '');
  return `${base}/shared-plan.html?s=${shareId}`;
}

/** Load a plan the caller owns, or 404 — a plan of someone else's is not theirs to see. */
async function requireOwnPlan(env: Env, id: string, userId: string): Promise<PlanRow> {
  const row = await env.DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(id).first<PlanRow>();
  if (!row || row.user_id !== userId) {
    throw new HttpError(404, 'not_found', 'Plan not found');
  }
  return row;
}

// ---------------------------------------------------------------------------
// GET /v1/plans — this user's plans (full snapshot or delta)
// ---------------------------------------------------------------------------

export async function listPlans(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), PLANS_DEFAULT_LIMIT, PLANS_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const since = url.searchParams.get('since');
  const syncedAt = new Date().toISOString();

  const conditions = ['user_id = ?'];
  const binds: unknown[] = [user.id];

  if (since) {
    // Delta mode: everything touched after `since`, tombstones included.
    conditions.push('updated_at > ?');
    binds.push(since);
  } else {
    // Snapshot mode: only live rows.
    conditions.push('deleted_at IS NULL');
  }

  if (cursor) {
    conditions.push('(updated_at > ? OR (updated_at = ? AND id > ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM plans
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?`
  )
    .bind(...binds, limit + 1)
    .all<PlanRow>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.updated_at, last.id);
  }

  const plans: PlanSyncEntryUnion[] = page.map((row) =>
    row.deleted_at !== null
      ? { id: row.id, trailId: row.trail_id, deleted: true as const, updatedAt: row.updated_at }
      : toPlanSyncEntry(row)
  );

  const payload: PlansSyncResponse = { plans, nextCursor, syncedAt };
  return json(payload);
}

// ---------------------------------------------------------------------------
// PUT /v1/plans/:id — full replace (create or overwrite)
// ---------------------------------------------------------------------------

export async function putPlan(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertClientPlanId(id);
  const user = await requireUser(request, env, ctx);

  const body = await readJson(request);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const document = validatePlanDocument(body, id, now);
  const documentJson = serialisePlanDocument(document);

  const existing = await env.DB.prepare(`SELECT * FROM plans WHERE id = ?`)
    .bind(id)
    .first<PlanRow>();
  if (existing && existing.user_id !== user.id) {
    throw new HttpError(409, 'id_conflict', 'This plan id belongs to another user');
  }

  // One live plan per trail per user: a different id already holding this
  // trail is a client that lost track of its document, not a second plan.
  const clash = await env.DB.prepare(
    `SELECT id FROM plans
      WHERE user_id = ? AND trail_id = ? AND deleted_at IS NULL AND id != ?`
  )
    .bind(user.id, document.trailId, id)
    .first<{ id: string }>();
  if (clash) {
    return json(
      {
        error: {
          code: 'plan_exists',
          message: 'This trail already has a plan on this account',
        },
        existingId: clash.id,
      },
      409
    );
  }

  await assertUnderRateLimit(
    env,
    RATE_BUCKETS.planPut,
    user.id,
    nowMs,
    `Plan write limit of ${RATE_BUCKETS.planPut.limit} per day reached`
  );

  let row: PlanRow | null;
  if (existing) {
    // Full replace — including an undelete, so a plan the user removed on one
    // device and rebuilt on another lands on the same id.
    row = await env.DB.prepare(
      `UPDATE plans
          SET trail_id = ?, document_json = ?, updated_at = ?, deleted_at = NULL
        WHERE id = ?
      RETURNING *`
    )
      .bind(document.trailId, documentJson, now, id)
      .first<PlanRow>();
  } else {
    row = await env.DB.prepare(
      `INSERT INTO plans (id, user_id, trail_id, document_json, share_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
       RETURNING *`
    )
      .bind(id, user.id, document.trailId, documentJson, now, now)
      .first<PlanRow>();
  }

  if (!row) {
    throw new HttpError(500, 'write_failed', 'Plan could not be stored');
  }

  await recordRateEvent(env, RATE_BUCKETS.planPut, user.id, nowMs, ctx);

  return json(toPlanSyncEntry(row), existing ? 200 : 201);
}

// ---------------------------------------------------------------------------
// DELETE /v1/plans/:id — soft delete (tombstone)
// ---------------------------------------------------------------------------

export async function deletePlan(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const row = await requireOwnPlan(env, id, user.id);

  // Idempotent: already tombstoned → 204 without re-stamping it.
  if (row.deleted_at !== null) {
    return noContent();
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, id)
    .run();

  return noContent();
}

// ---------------------------------------------------------------------------
// POST/DELETE /v1/plans/:id/share — mint or revoke the public read link
// ---------------------------------------------------------------------------

/**
 * Both share routes bump `updated_at` and rewrite the document's own
 * `updatedAt` to match, so the row and the document never disagree and the
 * owner's other devices learn the share state on their next delta pull.
 */
function stampDocument(row: PlanRow, updatedAt: string): string {
  const document = parseDocument(row);
  document.updatedAt = updatedAt;
  return JSON.stringify(document);
}

export async function sharePlan(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const row = await requireOwnPlan(env, id, user.id);
  if (row.deleted_at !== null) {
    throw new HttpError(404, 'not_found', 'Plan not found');
  }

  // Idempotent: a plan that is already shared replays its id and URL.
  if (row.share_id !== null) {
    const payload: SharePlanResponse = {
      shareId: row.share_id,
      url: shareUrl(env, row.share_id),
    };
    return json(payload);
  }

  const shareId = generateShareId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE plans SET share_id = ?, document_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(shareId, stampDocument(row, now), now, id)
    .run();

  const payload: SharePlanResponse = { shareId, url: shareUrl(env, shareId) };
  return json(payload);
}

export async function unsharePlan(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const row = await requireOwnPlan(env, id, user.id);

  // Idempotent: nothing shared → 204.
  if (row.share_id === null) {
    return noContent();
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE plans SET share_id = NULL, document_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(stampDocument(row, now), now, id)
    .run();

  return noContent();
}

// ---------------------------------------------------------------------------
// GET /v1/shared/plans/:shareId — public, read-only
// ---------------------------------------------------------------------------

export async function getSharedPlan(env: Env, shareId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.*, u.display_name AS display_name
       FROM plans p JOIN users u ON u.id = p.user_id
      WHERE p.share_id = ? AND p.deleted_at IS NULL`
  )
    .bind(shareId)
    .first<PlanRow & { display_name: string }>();

  // A revoked, deleted or never-minted share id is indistinguishable: 404.
  if (!row) {
    throw new HttpError(404, 'not_found', 'No such shared plan');
  }

  const payload: SharedPlanResponse = {
    document: parseDocument(row),
    trailId: row.trail_id,
    ownerDisplayName: row.display_name,
  };
  return json(payload, 200, { 'Cache-Control': 'no-store' });
}
