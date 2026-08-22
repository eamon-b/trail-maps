/**
 * Offline-first comment sync.
 *
 * Two engines, both dependency-injected so they run against the in-memory test
 * DB with fixture fetches:
 *
 *   pullTrail(trailId)  — GET the trail-wide bulk/delta feed since the stored
 *                         high-water mark, upsert live rows, apply tombstones,
 *                         then persist the server's `syncedAt` as the next
 *                         `since`. First sync (no cursor) is a full snapshot.
 *                         It also pulls curated waypoint descriptions on their
 *                         own high-water mark (`sync_state.meta_synced_at`) —
 *                         independently, so a failure there never fails the
 *                         comment pull.
 *
 *   drainOutbox()       — walk the FIFO outbox, PUT/DELETE/POST each item against
 *                         the idempotent write endpoints. On 2xx flip the mirrored
 *                         comment to `source='server'` and drop the outbox row.
 *                         A network error STOPS the drain (retry later); a 401
 *                         PAUSES the whole queue (identity needs attention); a
 *                         4xx validation error marks the single item failed but
 *                         keeps it (and the optimistic comment) visible.
 *                         A `report` item is settled by a 2xx (201 first report,
 *                         200 idempotent repeat) and equally by a 404/410 —
 *                         a comment that no longer exists needs no moderation.
 *
 * Retry backoff is `min(2^attempts * 30s, 1h)` measured from the item's
 * `created_at`; attempts start at 0 (send immediately), and each 4xx failure
 * bumps them.
 */

import type {
  PhotoContentType,
  PutCommentRequest,
  ReportReason,
  WaterStatus,
} from '@lib/comments-api-types';
import { isSyncTombstone } from '@lib/comments-api-types';
import { getDatabase } from '../db/database';
import type { SqlDatabase } from '../db/sql-database';
import * as commentsRepo from '../db/comments-repo';
import type { CommentSource } from '../db/comments-repo';
import * as outboxRepo from '../db/outbox-repo';
import * as waypointMetaRepo from '../db/waypoint-meta-repo';
import { ApiError, NetworkError, getBaseUrl, type FetchLike } from '../api/client';
import * as commentsApi from '../api/comments';
import { getSession, type Session } from '../api/auth';
import { uuidv4 } from '../api/uuid';
import { isServerKnown } from '../services/server-trails';
import type { SelectedPhoto } from '../features/comments/photo-upload';
import { parseReportPayload, validateReport } from '../features/comments/report-comment';
import { emitSyncChange } from './sync-events';

/** Payload persisted for a `kind='photo'` outbox row. */
export interface PhotoOutboxPayload {
  /** The comment this photo attaches to; the upload is gated on its confirm. */
  commentId: string;
  /** Local URI the upload reads bytes from. */
  localUri: string;
  contentType: PhotoContentType;
}

/** Read raw bytes from a local (`file://` / `content://`) URI for upload. */
export type ReadBytes = (uri: string) => Promise<Uint8Array>;

/**
 * Default byte reader: RN's `fetch` resolves local file/content URIs, and
 * `arrayBuffer()` gives us the raw bytes to POST. Injectable so tests avoid the
 * filesystem entirely.
 */
async function defaultReadBytes(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Retry delay for an item that has failed `attempts` times. */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(2 ** attempts * BACKOFF_BASE_MS, BACKOFF_MAX_MS);
}

/** Whether an outbox item is eligible to send at `nowMs` (backoff elapsed). */
export function isDrainable(
  item: { createdAt: string; attempts: number },
  nowMs: number,
): boolean {
  const created = Date.parse(item.createdAt);
  const base = Number.isNaN(created) ? 0 : created;
  return nowMs >= base + backoffMs(item.attempts);
}

export interface SyncDeps {
  db?: SqlDatabase;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  getSessionFn?: () => Promise<Session | null>;
  /** Manual retry: ignore the backoff window and attempt every queued item. */
  force?: boolean;
  /** Test seam for reading photo bytes from a local URI. */
  readBytes?: ReadBytes;
}

async function resolveDb(deps: SyncDeps): Promise<SqlDatabase> {
  return deps.db ?? (await getDatabase());
}

/**
 * The outbox choke point: every user-authored write (comment, its photo, and a
 * moderation report) is minted by `submitComment` / `submitReport`, so guarding
 * those two is enough to make a `u_` trail id unrepresentable in the queue —
 * a `delete` row can only follow a comment that got in, and the drain is
 * therefore id-clean by construction.
 *
 * This is defence in depth: the UI never offers a composer on an imported
 * guide. Reaching it means a bug, so it throws rather than silently dropping
 * the user's note.
 */
function assertServerTrail(trailId: string): void {
  if (!isServerKnown(trailId)) {
    throw new Error(
      `Refusing to queue a server write for "${trailId}": imported trails have no server side.`,
    );
  }
}

// ---------------------------------------------------------------------------
// sync_state high-water mark
// ---------------------------------------------------------------------------

async function readSince(db: SqlDatabase, trailId: string): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ last_synced_at: string | null }>(
    'SELECT last_synced_at FROM sync_state WHERE trail_id = ?',
    [trailId],
  );
  return row?.last_synced_at ?? undefined;
}

async function writeSince(db: SqlDatabase, trailId: string, syncedAt: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_state (trail_id, last_synced_at) VALUES (?, ?)
     ON CONFLICT(trail_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
    [trailId, syncedAt],
  );
}

// ---------------------------------------------------------------------------
// pullTrailMeta — curated waypoint descriptions
// ---------------------------------------------------------------------------

/**
 * Pull the curated waypoint descriptions for a trail (delta since the stored
 * `meta_synced_at`) and mirror them locally. Cleared rows — empty descriptions —
 * are stored as-is; the repo hides them from readers.
 *
 * Returns the waypoint ids the pull touched. Throws on transport/API failure:
 * the caller decides how loudly to fail (`pullTrail` swallows it so a broken
 * description endpoint never breaks comment sync).
 */
async function pullTrailMeta(
  db: SqlDatabase,
  trailId: string,
  ctx: commentsApi.ApiContext,
): Promise<string[]> {
  const since = await waypointMetaRepo.readMetaSyncedAt(db, trailId);
  const result = await commentsApi.getTrailDescriptions(ctx, { trailId, since });
  const rows = result.descriptions ?? [];
  await waypointMetaRepo.upsertDescriptions(db, trailId, rows);
  await waypointMetaRepo.writeMetaSyncedAt(db, trailId, result.syncedAt);
  return rows.map((row) => row.waypointId).filter((id): id is string => !!id);
}

// ---------------------------------------------------------------------------
// pullTrail
// ---------------------------------------------------------------------------

export type PullOutcome =
  | 'unconfigured'
  | 'pulled'
  | 'offline'
  | 'error'
  /** The trail is user-imported: it has no server side, so nothing was pulled. */
  | 'not-server-trail';

export interface PullResult {
  outcome: PullOutcome;
  applied: number;
  syncedAt: string | null;
}

/**
 * Pull the trail-wide delta (or full snapshot) and apply it locally.
 *
 * The server-boundary gate comes before everything, including the base-URL
 * read: an imported trail must not produce a request under any configuration.
 */
export async function pullTrail(trailId: string, deps: SyncDeps = {}): Promise<PullResult> {
  if (!isServerKnown(trailId)) {
    return { outcome: 'not-server-trail', applied: 0, syncedAt: null };
  }

  const baseUrl = deps.baseUrl ?? getBaseUrl();
  if (!baseUrl) return { outcome: 'unconfigured', applied: 0, syncedAt: null };

  const db = await resolveDb(deps);
  const ctx: commentsApi.ApiContext = { baseUrl, fetchImpl: deps.fetchImpl };
  const since = await readSince(db, trailId);

  let result: commentsApi.TrailCommentsResult;
  try {
    result = await commentsApi.listTrailComments(ctx, { trailId, since });
  } catch (e) {
    if (e instanceof NetworkError) return { outcome: 'offline', applied: 0, syncedAt: null };
    return { outcome: 'error', applied: 0, syncedAt: null };
  }

  let applied = 0;
  const changedWaypoints = new Set<string>();
  for (const entry of result.entries) {
    if (isSyncTombstone(entry)) {
      await commentsRepo.applyTombstone(db, entry.id);
    } else {
      await commentsRepo.upsertServerComment(db, {
        id: entry.id,
        trailId,
        waypointId: entry.waypointId,
        displayName: entry.displayName,
        text: entry.text,
        waterStatus: entry.waterStatus,
        observedAt: entry.observedAt,
        createdAt: entry.createdAt,
        photoUrls: entry.photoUrls,
      });
      if (entry.waypointId) changedWaypoints.add(entry.waypointId);
    }
    applied += 1;
  }

  await writeSince(db, trailId, result.syncedAt);

  // Descriptions ride the same trigger but are a SEPARATE channel: a failure
  // here (offline mid-pull, endpoint not deployed yet) must not turn a
  // successful comment pull into an error, so it is swallowed and simply
  // retried on the next pull.
  let metaApplied = 0;
  try {
    const metaWaypoints = await pullTrailMeta(db, trailId, ctx);
    metaApplied = metaWaypoints.length;
    for (const id of metaWaypoints) changedWaypoints.add(id);
  } catch {
    // Keep the comment pull's outcome; the meta high-water mark is unchanged.
  }

  // Nudge any mounted feed for this trail to re-read the freshly-applied rows.
  if (applied > 0 || metaApplied > 0) {
    emitSyncChange({ trailId, waypointIds: [...changedWaypoints] });
  }
  return { outcome: 'pulled', applied, syncedAt: result.syncedAt };
}

// ---------------------------------------------------------------------------
// drainOutbox
// ---------------------------------------------------------------------------

export type DrainOutcome =
  | 'idle'
  | 'drained'
  | 'offline'
  | 'unauthorized'
  | 'unconfigured'
  | 'no-identity';

export interface DrainResult {
  outcome: DrainOutcome;
  sent: number;
  failed: number;
}

// Drains must not overlap: listPending includes stale 'sending' rows (crash
// recovery), so two concurrent drains would both pick up an in-flight photo
// row and double-upload it (photo POSTs append; only comment PUTs are
// idempotent). Concurrent callers coalesce onto the active drain, and one
// follow-up drain runs afterwards so work enqueued mid-drain isn't stranded
// until the next external trigger.
let activeDrain: Promise<DrainResult> | null = null;
let followUpRequested = false;

/** Drain the outbox FIFO against the API. See module docs for semantics. */
export async function drainOutbox(deps: SyncDeps = {}): Promise<DrainResult> {
  if (activeDrain) {
    followUpRequested = true;
    return activeDrain;
  }
  activeDrain = (async () => {
    let result = await drainOutboxNow(deps);
    while (followUpRequested) {
      followUpRequested = false;
      result = await drainOutboxNow(deps);
    }
    return result;
  })().finally(() => {
    activeDrain = null;
  });
  return activeDrain;
}

async function drainOutboxNow(deps: SyncDeps = {}): Promise<DrainResult> {
  const baseUrl = deps.baseUrl ?? getBaseUrl();
  if (!baseUrl) return { outcome: 'unconfigured', sent: 0, failed: 0 };

  const db = await resolveDb(deps);
  const nowMs = (deps.now ?? Date.now)();
  const session = await (deps.getSessionFn ?? getSession)();
  if (!session) return { outcome: 'no-identity', sent: 0, failed: 0 };

  const ctx: commentsApi.ApiContext = {
    baseUrl,
    fetchImpl: deps.fetchImpl,
    token: session.token,
  };
  const readBytes = deps.readBytes ?? defaultReadBytes;

  const items = await outboxRepo.listPending(db);
  let sent = 0;
  let failed = 0;

  // Track what changed so a single event fires on the way out (whether the
  // drain finished cleanly or bailed early), nudging any mounted feed to re-read.
  const changedWaypoints = new Set<string>();
  let changedTrail: string | undefined;
  const noteChange = (item: { trailId: string | null; waypointId: string | null }) => {
    if (item.waypointId) changedWaypoints.add(item.waypointId);
    if (item.trailId) changedTrail = item.trailId;
  };
  const finish = (outcome: DrainOutcome): DrainResult => {
    if (sent > 0) emitSyncChange({ trailId: changedTrail, waypointIds: [...changedWaypoints] });
    return { outcome, sent, failed };
  };

  // Photos gated on a not-yet-confirmed comment in the first pass. A second
  // pass re-checks them so a comment+photo composed together lands in ONE
  // drain, deterministically — regardless of outbox ordering or clock ticks.
  const gatedPhotos: typeof items = [];

  const processItems = async (
    list: typeof items,
    collectGated: boolean,
  ): Promise<DrainResult | null> => {
  for (const item of list) {
    if (!deps.force && !isDrainable(item, nowMs)) continue;

    // A photo can only be attached once its comment exists server-side. Gate the
    // upload on the comment row being `source='server'` (the PUT confirmed);
    // until then leave the photo row pending — do NOT mark it sending or charge
    // an attempt. The second pass picks up photos whose comment confirmed during
    // this drain; this check is the correctness guarantee, not the ordering.
    if (item.kind === 'photo') {
      const { commentId } = JSON.parse(item.payloadJson) as PhotoOutboxPayload;
      const comment = await commentsRepo.getById(db, commentId);
      if (!comment || comment.source !== 'server') {
        if (collectGated) gatedPhotos.push(item);
        continue;
      }
    }

    // A report we can't parse can never succeed — drop it instead of retrying a
    // payload we can't turn into a request.
    if (item.kind === 'report' && parseReportPayload(item.payloadJson) === null) {
      await outboxRepo.remove(db, item.id);
      continue;
    }

    await outboxRepo.markSending(db, item.id);

    try {
      if (item.kind === 'delete') {
        await commentsApi.deleteComment(ctx, item.id);
        await commentsRepo.deleteById(db, item.id);
      } else if (item.kind === 'photo') {
        const payload = JSON.parse(item.payloadJson) as PhotoOutboxPayload;
        const bytes = await readBytes(payload.localUri);
        const res = await commentsApi.uploadCommentPhoto(
          ctx,
          payload.commentId,
          bytes,
          payload.contentType,
        );
        await commentsRepo.setPhotoUrls(db, payload.commentId, res.photoUrls);
      } else if (item.kind === 'report') {
        // Pre-checked above, so this parse always succeeds; reports own no
        // local comment row, the outbox row IS the whole record.
        const payload = parseReportPayload(item.payloadJson);
        if (payload) {
          await commentsApi.reportComment(ctx, payload.commentId, {
            reason: payload.reason,
            detail: payload.detail,
          });
        }
      } else {
        const payload = JSON.parse(item.payloadJson) as PutCommentRequest;
        const server = await commentsApi.putComment(ctx, item.id, payload);
        await commentsRepo.confirmServer(db, item.id, {
          displayName: server.displayName,
          text: server.text,
          waterStatus: server.waterStatus,
          observedAt: server.observedAt,
          createdAt: server.createdAt,
        });
      }
      await outboxRepo.remove(db, item.id);
      noteChange(item);
      sent += 1;
    } catch (e) {
      if (e instanceof NetworkError) {
        await outboxRepo.markPending(db, item.id);
        return finish('offline');
      }
      if (e instanceof ApiError && e.status === 401) {
        await outboxRepo.markPending(db, item.id);
        return finish('unauthorized');
      }
      if (e instanceof ApiError && e.status === 404 && item.kind === 'delete') {
        // Already gone server-side — the delete is a no-op success.
        await commentsRepo.deleteById(db, item.id);
        await outboxRepo.remove(db, item.id);
        noteChange(item);
        sent += 1;
        continue;
      }
      if (
        e instanceof ApiError &&
        item.kind === 'report' &&
        (e.status === 404 || e.status === 410)
      ) {
        // Unknown or already-deleted comment — there is nothing left to
        // moderate, so the report is settled rather than failed.
        await outboxRepo.remove(db, item.id);
        noteChange(item);
        sent += 1;
        continue;
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        await outboxRepo.markFailed(db, item.id, `${e.code}: ${e.message}`);
        failed += 1;
        continue;
      }
      // 5xx / unknown — retryable transient; stop and try again later.
      await outboxRepo.markPending(db, item.id);
      return finish('offline');
    }
  }
  return null;
  };

  const early = await processItems(items, true);
  if (early) return early;
  if (gatedPhotos.length > 0) {
    const late = await processItems(gatedPhotos, false);
    if (late) return late;
  }

  return finish(sent > 0 || failed > 0 ? 'drained' : 'idle');
}

// ---------------------------------------------------------------------------
// Compose / delete orchestration used by the detail screen
// ---------------------------------------------------------------------------

export interface SubmitCommentInput {
  trailId: string;
  waypointId: string;
  text?: string | null;
  waterStatus?: WaterStatus | null;
  observedAt?: string | null;
  session: Session;
  /** Optional photo to attach; uploaded after the comment itself confirms. */
  photo?: SelectedPhoto | null;
}

export interface SubmitCommentResult {
  id: string;
  drain: DrainResult;
}

/**
 * Compose a comment: mint its id, insert the optimistic local row, enqueue the
 * outbox write, and attempt an immediate drain. The row is visible instantly
 * regardless of connectivity; the drain result tells the caller whether it went
 * out now or is waiting.
 */
export async function submitComment(
  input: SubmitCommentInput,
  deps: SyncDeps = {},
): Promise<SubmitCommentResult> {
  assertServerTrail(input.trailId);
  const db = await resolveDb(deps);
  const nowMs = (deps.now ?? Date.now)();
  const id = uuidv4();
  const createdAt = new Date(nowMs).toISOString();

  const trimmed = input.text?.trim() ?? '';
  const text = trimmed.length > 0 ? trimmed : null;
  const waterStatus = input.waterStatus ?? null;
  const observedAt = input.observedAt ?? null;

  const photo = input.photo ?? null;

  await commentsRepo.insertLocalComment(db, {
    id,
    trailId: input.trailId,
    waypointId: input.waypointId,
    authorId: input.session.userId,
    authorName: input.session.displayName,
    body: text,
    waterStatus,
    observedAt,
    createdAt,
    // Optimistic local preview: show the picked image immediately; the upload
    // replaces this with the server URL on success.
    photoUrls: photo ? [photo.uri] : undefined,
  });

  const payload: PutCommentRequest = {
    trailId: input.trailId,
    waypointId: input.waypointId,
    text,
    waterStatus,
    observedAt,
  };
  await outboxRepo.enqueue(db, {
    id,
    kind: 'comment',
    trailId: input.trailId,
    waypointId: input.waypointId,
    payload,
    createdAt,
  });

  if (photo) {
    // Same createdAt as the comment: the drain's photo gate + its second pass
    // guarantee comment-then-photo within one drain, so no clock-tick ordering
    // hack is needed (a +1ms timestamp made the row ineligible when the drain
    // ran within the same millisecond).
    const photoPayload: PhotoOutboxPayload = {
      commentId: id,
      localUri: photo.uri,
      contentType: photo.contentType,
    };
    await outboxRepo.enqueue(db, {
      id: uuidv4(),
      kind: 'photo',
      trailId: input.trailId,
      waypointId: input.waypointId,
      payload: photoPayload,
      createdAt,
    });
  }

  const drain = await drainOutbox({
    ...deps,
    db,
    getSessionFn: deps.getSessionFn ?? (async () => input.session),
  });
  return { id, drain };
}

export interface SubmitReportInput {
  /** The reported comment's server id. */
  commentId: string;
  trailId: string;
  waypointId: string;
  reason: ReportReason;
  detail?: string | null;
  /** A report is authenticated, so the reporter must be registered first. */
  session: Session;
}

export interface SubmitReportResult {
  /** The outbox row id (a fresh uuid — reports own no comment row). */
  id: string;
  drain: DrainResult;
}

/**
 * Report a comment for moderation: validate, enqueue, and attempt an immediate
 * drain. Nothing is written to the comment cache — the report is invisible in
 * the feed, and the server treats a repeat report from the same device as
 * idempotent, so a queued report is safe to send whenever connectivity returns.
 *
 * Throws when the reason/detail fail validation so the caller can surface the
 * message inline.
 */
export async function submitReport(
  input: SubmitReportInput,
  deps: SyncDeps = {},
): Promise<SubmitReportResult> {
  assertServerTrail(input.trailId);
  const check = validateReport({
    commentId: input.commentId,
    reason: input.reason,
    detail: input.detail,
  });
  if (!check.ok) throw new Error(check.message);

  const db = await resolveDb(deps);
  const nowMs = (deps.now ?? Date.now)();
  const id = uuidv4();

  await outboxRepo.enqueue(db, {
    id,
    kind: 'report',
    trailId: input.trailId,
    waypointId: input.waypointId,
    payload: check.value,
    createdAt: new Date(nowMs).toISOString(),
  });

  const drain = await drainOutbox({
    ...deps,
    db,
    getSessionFn: deps.getSessionFn ?? (async () => input.session),
  });
  return { id, drain };
}

/**
 * Delete one of the current user's comments. A never-synced local comment is
 * simply cancelled (its optimistic row + pending outbox item are removed); a
 * server-confirmed comment is optimistically removed locally and a `delete`
 * write is enqueued + drained.
 */
export async function deleteOwnComment(
  input: { id: string; source: CommentSource },
  deps: SyncDeps = {},
): Promise<DrainResult | undefined> {
  const db = await resolveDb(deps);

  if (input.source === 'local') {
    await outboxRepo.remove(db, input.id);
    await commentsRepo.deleteById(db, input.id);
    return undefined;
  }

  await commentsRepo.deleteById(db, input.id);
  await outboxRepo.enqueue(db, { id: input.id, kind: 'delete', payload: { id: input.id } });
  return drainOutbox({ ...deps, db });
}

/** Manual "retry" — drain ignoring backoff so failed items are attempted now. */
export async function retryOutbox(deps: SyncDeps = {}): Promise<DrainResult> {
  return drainOutbox({ ...deps, force: true });
}
