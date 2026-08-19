/**
 * Shared wire types for the FarOut comments API.
 *
 * The mobile app imports these via its `@lib` alias; the Cloudflare Worker in
 * `workers/comments-api/` imports them relatively (`../../../src/lib/`).
 *
 * PLAIN TYPES ONLY — no runtime imports, no DOM or Node globals. Keep this file
 * free of anything that would break either the RN bundler or workerd.
 */

/** Structured water report status for a waypoint comment. */
export type WaterStatus = 'flowing' | 'low' | 'dry';

/** Who soft-deleted a comment. */
export type DeletedBy = 'owner' | 'admin';

/** Standard error envelope returned by every non-2xx response. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Devices / identity
// ---------------------------------------------------------------------------

/** POST /v1/devices request body. */
export interface RegisterDeviceRequest {
  /** 1–40 chars after trimming, non-empty. */
  displayName: string;
}

/** POST /v1/devices 201 response. The raw token is returned exactly once. */
export interface RegisterDeviceResponse {
  userId: string;
  token: string;
  displayName: string;
}

/** GET /v1/me response. */
export interface MeResponse {
  userId: string;
  displayName: string;
  isAdmin: boolean;
}

/** PATCH /v1/me request body. */
export interface UpdateMeRequest {
  displayName: string;
}

/**
 * DELETE /v1/me — deletes the authenticated device account. Soft-deletes every
 * comment the user authored (tombstones flow to clients on their next sync),
 * removes their photos from storage, and invalidates the token. Returns 204.
 */

// ---------------------------------------------------------------------------
// Comments — reporting / moderation
// ---------------------------------------------------------------------------

/** Reasons a comment can be reported. */
export type ReportReason = 'spam' | 'offensive' | 'inaccurate' | 'other';

/** POST /v1/comments/:id/report request body. */
export interface ReportCommentRequest {
  reason: ReportReason;
  /** Optional free-text detail, <= 500 chars after trimming. */
  detail?: string | null;
}

/**
 * POST /v1/comments/:id/report response. 201 on first report; repeat reports
 * from the same device are idempotent and return 200 with the original id.
 */
export interface ReportCommentResponse {
  reportId: string;
}

/** A report row for the admin console. */
export interface AdminReport {
  id: string;
  commentId: string;
  trailId: string;
  waypointId: string;
  reporterUserId: string;
  reason: ReportReason;
  detail: string | null;
  createdAt: string;
  /** Snapshot of the reported comment's text at read time (null if deleted). */
  commentText: string | null;
  commentDeleted: boolean;
}

/** GET /v1/admin/reports response. */
export interface AdminReportsResponse {
  reports: AdminReport[];
}

// ---------------------------------------------------------------------------
// Waypoint descriptions (curated, served over the sync channel)
// ---------------------------------------------------------------------------

/** A curated waypoint description row. */
export interface WaypointDescription {
  waypointId: string;
  /** Markdown-free plain text. Empty string means "cleared" (tombstone). */
  description: string;
  updatedAt: string;
}

/**
 * GET /v1/trails/:trailId/descriptions?since=<iso> response. Unauthenticated
 * read, same delta semantics as the comment bulk endpoint: `since` filters to
 * rows updated after the client's high-water mark.
 */
export interface TrailDescriptionsResponse {
  descriptions: WaypointDescription[];
  /** Server clock at query time; the client persists this as the next `since`. */
  syncedAt: string;
}

/** PUT /v1/admin/trails/:trailId/descriptions/:waypointId request body. */
export interface UpsertDescriptionRequest {
  description: string;
}

// ---------------------------------------------------------------------------
// Comments — write
// ---------------------------------------------------------------------------

/**
 * PUT /v1/comments/:id request body (idempotent create).
 * The `:id` path segment is the client-minted UUID v4 idempotency key.
 */
export interface PutCommentRequest {
  trailId: string;
  waypointId: string;
  text?: string | null;
  waterStatus?: WaterStatus | null;
  /** ISO 8601; server clamps to <= now + 10 min. */
  observedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Comments — photo attachments
// ---------------------------------------------------------------------------

/**
 * Image MIME types accepted by `POST /v1/comments/:id/photos`. The request body
 * is the raw image bytes (not multipart / not JSON) with one of these as its
 * `Content-Type`; any other type is rejected 415.
 */
export type PhotoContentType = 'image/jpeg' | 'image/webp';

/**
 * 201 response from `POST /v1/comments/:id/photos`.
 * `photoUrl` is the URL of the just-uploaded photo; `photoUrls` is the comment's
 * full photo list (existing + new), in upload order.
 */
export interface UploadCommentPhotoResponse {
  photoUrl: string;
  photoUrls: string[];
}

// ---------------------------------------------------------------------------
// Comments — read (feed / sync / admin)
// ---------------------------------------------------------------------------

/**
 * A live (non-deleted) comment as returned by the per-waypoint feed and by the
 * PUT create response.
 */
export interface FeedComment {
  id: string;
  waypointId: string;
  displayName: string;
  text: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
  /**
   * Full public R2 URLs of attached photos, in upload order. Omitted (undefined)
   * when the comment has no photos.
   */
  photoUrls?: string[];
}

/** GET per-waypoint feed response. */
export interface FeedResponse {
  comments: FeedComment[];
  /** Opaque keyset cursor for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}

/**
 * A live comment as returned by the trail-wide bulk/delta endpoint. Carries
 * `updatedAt` so the client can persist a high-water mark for the next `since`.
 */
export interface SyncComment {
  id: string;
  waypointId: string;
  displayName: string;
  text: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Full public R2 URLs of attached photos, in upload order. Omitted (undefined)
   * when the comment has no photos.
   */
  photoUrls?: string[];
  deleted?: false;
}

/**
 * A tombstone for a comment deleted since the client's last sync. Only emitted
 * by the bulk endpoint when a `since` parameter is supplied.
 */
export interface SyncTombstone {
  id: string;
  waypointId: string;
  deleted: true;
  updatedAt: string;
}

/** An entry in the bulk/delta feed: either a live comment or a tombstone. */
export type SyncEntry = SyncComment | SyncTombstone;

/** GET trail-wide bulk/delta response. */
export interface BulkSyncResponse {
  comments: SyncEntry[];
  /** Keyset cursor for the next ascending page, or null when exhausted. */
  nextCursor: string | null;
  /** Server clock at query time; the client persists this as the next `since`. */
  syncedAt: string;
}

/** A fully-detailed comment row for the admin console. */
export interface AdminComment {
  id: string;
  trailId: string;
  waypointId: string;
  userId: string;
  displayName: string;
  text: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: DeletedBy | null;
}

/** GET /v1/admin/comments response. */
export interface AdminCommentsResponse {
  comments: AdminComment[];
}

/** Narrowing helper: is a sync entry a tombstone? */
export function isSyncTombstone(entry: SyncEntry): entry is SyncTombstone {
  return (entry as SyncTombstone).deleted === true;
}
