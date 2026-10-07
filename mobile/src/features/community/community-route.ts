/**
 * Community route wording and report rules, with no UI attached.
 */

import {
  COMMUNITY_REPORT_REASONS,
  type CommunityReportReason,
} from '@lib/community-types';

export const REPORT_REASON_LABELS: Record<CommunityReportReason, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive',
  inaccurate: 'Inaccurate or not a walking route',
  unsafe: 'Unsafe',
  copyright: 'Copied without permission',
  other: 'Something else',
};

export const REPORT_REASON_CHOICES = COMMUNITY_REPORT_REASONS.map((value) => ({
  value,
  label: REPORT_REASON_LABELS[value],
}));

export const MAX_REPORT_NOTE_LENGTH = 500;

export function isReportReason(value: unknown): value is CommunityReportReason {
  return (
    typeof value === 'string' && (COMMUNITY_REPORT_REASONS as readonly string[]).includes(value)
  );
}

/** The note to send: trimmed, null when empty. "Something else" needs one. */
export function validateReport(
  reason: string | null,
  note: string,
): { ok: true; reason: CommunityReportReason; note: string | null } | { ok: false; message: string } {
  if (!isReportReason(reason)) return { ok: false, message: 'Choose a reason.' };
  const trimmed = note.trim();
  if (trimmed.length > MAX_REPORT_NOTE_LENGTH) {
    return { ok: false, message: `Keep the note under ${MAX_REPORT_NOTE_LENGTH} characters.` };
  }
  if (reason === 'other' && trimmed.length === 0) {
    return { ok: false, message: 'Say what is wrong with the route.' };
  }
  return { ok: true, reason, note: trimmed.length > 0 ? trimmed : null };
}
