/**
 * Comment reporting rules: the reason list the picker renders, detail
 * validation, and the outbox payload shape.
 *
 * Reporting is offline-first like posting — a report is enqueued and drained,
 * never awaited on the network — so everything the UI and the drain both need
 * (labels, limits, payload build/parse) lives here as plain functions with no
 * React or SQLite dependency.
 *
 * The detail cap mirrors the server's `MAX_REPORT_DETAIL_LEN`, so an over-long
 * note is rejected before it costs a round trip (the server stays the
 * authority).
 */

import type { ReportReason } from '@lib/comments-api-types';

/** Server-side cap on a report's free-text detail. */
export const MAX_REPORT_DETAIL_LENGTH = 500;

/** The reasons offered by the picker, in display order. */
export const REPORT_REASONS: readonly ReportReason[] = [
  'spam',
  'offensive',
  'inaccurate',
  'other',
];

const REASON_LABELS: Record<ReportReason, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive or abusive',
  inaccurate: 'Inaccurate or misleading',
  other: 'Something else',
};

/** Human-readable label for a report reason. */
export function reportReasonLabel(reason: ReportReason): string {
  return REASON_LABELS[reason];
}

/** Payload persisted for a `kind='report'` outbox row. */
export interface ReportOutboxPayload {
  commentId: string;
  reason: ReportReason;
  /** Trimmed detail, or null when the reporter left it empty. */
  detail: string | null;
}

export type ReportCheck =
  | { ok: true; value: ReportOutboxPayload }
  | { ok: false; message: string };

/** True when `value` is one of the four wire reasons. */
export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * Validate a picker submission into an outbox payload. A missing/unknown reason
 * and an over-long detail are the only client-side failures; an empty detail is
 * legitimate and normalizes to null.
 */
export function validateReport(input: {
  commentId: string;
  reason: ReportReason | null;
  detail?: string | null;
}): ReportCheck {
  if (!input.commentId) {
    return { ok: false, message: 'This comment can’t be reported.' };
  }
  if (!isReportReason(input.reason)) {
    return { ok: false, message: 'Choose a reason.' };
  }
  const trimmed = (input.detail ?? '').trim();
  if (trimmed.length > MAX_REPORT_DETAIL_LENGTH) {
    return {
      ok: false,
      message: `Details can be at most ${MAX_REPORT_DETAIL_LENGTH} characters.`,
    };
  }
  return {
    ok: true,
    value: {
      commentId: input.commentId,
      reason: input.reason,
      detail: trimmed.length > 0 ? trimmed : null,
    },
  };
}

/**
 * Parse a stored `kind='report'` outbox payload. Returns null for anything
 * malformed (a corrupt row is dropped by the drain rather than retried forever).
 */
export function parseReportPayload(json: string): ReportOutboxPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.commentId !== 'string' || raw.commentId.length === 0) return null;
  if (!isReportReason(raw.reason)) return null;
  const detail = typeof raw.detail === 'string' ? raw.detail : null;
  return { commentId: raw.commentId, reason: raw.reason, detail };
}
