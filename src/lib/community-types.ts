/**
 * Wire types for community routes: the contract between the comments-api
 * worker (`workers/comments-api/src/community*.ts`), the web pages and the app.
 * Spec: `plans/community-routes.md`.
 *
 * Platform-neutral and dependency-free (types plus a few constants), so the
 * worker, Vite and Metro can all import it.
 */

/**
 * Where a community route stands.
 *
 * - `unverified` — passed the automatic checks; public, labelled Unverified.
 * - `verified` — an admin approved it.
 * - `hidden` — taken down by the AI review, user reports or an admin; visible
 *   only to its owner and admins.
 * - `removed` — deleted by its owner or an admin (a tombstone).
 */
export type CommunityRouteStatus = 'unverified' | 'verified' | 'hidden' | 'removed';

/** Statuses anyone can see. */
export const PUBLIC_COMMUNITY_STATUSES: readonly CommunityRouteStatus[] = ['unverified', 'verified'];

/** Prefix of every community route id (`c_` + 16 url-safe random chars). */
export const COMMUNITY_ID_PREFIX = 'c_';

export function isCommunityRouteId(id: string): boolean {
  return /^c_[A-Za-z0-9_-]{16}$/.test(id);
}

export type CommunityCheckLevel = 'pass' | 'warn' | 'fail';

/** One automatic check's outcome. See `src/lib/community-checks.ts`. */
export interface CommunityCheck {
  id: string;
  level: CommunityCheckLevel;
  message: string;
}

export type CommunityReviewStatus = 'pending' | 'done' | 'failed' | 'skipped';

export type CommunityReviewVerdict = 'looks_good' | 'needs_human' | 'reject';

/** The AI review of a submission. Full detail is for owners and admins only. */
export interface CommunityAiReview {
  status: CommunityReviewStatus;
  verdict?: CommunityReviewVerdict;
  /** 0..1 */
  confidence?: number;
  summary?: string;
  concerns?: string[];
  suggestedCountry?: string;
  suggestedState?: string;
  model?: string;
  reviewedAt?: string;
  /** Why a `failed` review failed (API error class, refusal), for admins. */
  error?: string;
}

export const COMMUNITY_REPORT_REASONS = [
  'spam',
  'offensive',
  'inaccurate',
  'unsafe',
  'copyright',
  'other',
] as const;
export type CommunityReportReason = (typeof COMMUNITY_REPORT_REASONS)[number];

/** Distinct user reports that hide a route until an admin looks. */
export const COMMUNITY_REPORTS_TO_HIDE = 3;

export const COMMUNITY_LIMITS = {
  nameMin: 3,
  nameMax: 80,
  descriptionMin: 20,
  descriptionMax: 2000,
  creditMax: 300,
  /** Serialised ProcessedTrail. */
  trailJsonMaxBytes: 4 * 1024 * 1024,
  /** Raw GPX, before base64. A larger file is shared without its GPX. */
  gpxMaxBytes: 5 * 1024 * 1024,
  /** Routes a user may publish per day. */
  submitsPerDay: 10,
  /** Submit requests a user may make per day, failed ones included. */
  submitAttemptsPerDay: 30,
} as const;

/**
 * What a list shows: enough to draw a card and group it, without the track.
 * The track is `trailUrl` (a `ProcessedTrail` JSON on the public R2 domain).
 */
export interface CommunityRouteSummary {
  id: string;
  name: string;
  status: CommunityRouteStatus;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** A state/region code from `trail-regions.ts`, or null when none applies. */
  state: string | null;
  lengthKm: number;
  ascentM: number;
  hasElevation: boolean;
  waypointCount: number;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  start: { lat: number; lon: number };
  /** The submitter's display name at submission time (may be null). */
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  /** True once the AI review has run (its content is not public). */
  reviewed: boolean;
  /**
   * Public URL of the trail JSON (content-addressed, immutable). Always set in
   * the public list and public detail; null in an owner's or admin's view of a
   * hidden route, whose public copies are deleted while it is hidden (the
   * detail then carries metadata only).
   */
  trailUrl: string | null;
  /** md5 of the trail JSON, for cache keys. */
  md5: string;
  bytes: number;
}

/** A single route: the summary plus the text and, for owners/admins, more. */
export interface CommunityRouteDetail extends CommunityRouteSummary {
  description: string;
  credit: string | null;
  licence: 'CC0-1.0';
  checks: CommunityCheck[];
  /** Present only for the owner and admins. */
  review?: CommunityAiReview;
  /** Present only for the owner and admins. */
  isOwner?: boolean;
  /** Present only for admins. */
  reportCount?: number;
  /** Present only for admins. */
  reports?: { reason: CommunityReportReason; note: string | null; createdAt: string }[];
  /** Present only for admins: the last status change note. */
  statusNote?: string | null;
  /** Present for the owner and admins when status is 'hidden': what hid the route. */
  hiddenReason?: 'review' | 'reports' | 'admin';
}

export interface CommunitySubmitRequest {
  name: string;
  description: string;
  credit?: string | null;
  country: string;
  state?: string | null;
  /** Must be true: "I recorded this myself or it is openly licensed; I release it as CC0". */
  rightsConfirmed: true;
  /** The processed trail (`importGpx(...).trail`), after any elevation backfill. */
  trail: unknown;
  /**
   * Optional raw GPX, base64 (at most `COMMUNITY_LIMITS.gpxMaxBytes` before
   * encoding), kept privately under an unguessable key for re-processing and
   * never returned.
   */
  gpxBase64?: string;
}

export interface CommunityPatchRequest {
  name?: string;
  description?: string;
  credit?: string | null;
  country?: string;
  state?: string | null;
}

export interface CommunityListResponse {
  routes: CommunityRouteSummary[];
  /**
   * Keyset cursor for the next page (`?cursor=`), or null on the last page.
   * Optional on the wire so a client also reads a server that predates paging.
   */
  nextCursor?: string | null;
}

export interface CommunityAdminListResponse {
  routes: CommunityRouteDetail[];
}

/** 422 body from a submit that failed a check. */
export interface CommunityChecksFailedBody {
  error: { code: 'checks_failed'; message: string };
  checks: CommunityCheck[];
}
