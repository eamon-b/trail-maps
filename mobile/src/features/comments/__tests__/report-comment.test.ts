/**
 * Report validation + outbox payload round-trip.
 *
 * The drain has to be able to rebuild a request from a row written by an older
 * build (or a corrupt one), so parse is deliberately total: it returns null
 * rather than throwing, and the drain drops such rows instead of retrying them
 * forever.
 */

import {
  MAX_REPORT_DETAIL_LENGTH,
  REPORT_REASONS,
  isReportReason,
  parseReportPayload,
  reportReasonLabel,
  validateReport,
} from '../report-comment';

describe('report reasons', () => {
  it('offers the four wire reasons, each with a label', () => {
    expect(REPORT_REASONS).toEqual(['spam', 'offensive', 'inaccurate', 'other']);
    for (const reason of REPORT_REASONS) {
      expect(reportReasonLabel(reason).length).toBeGreaterThan(0);
    }
  });

  it('narrows unknown values', () => {
    expect(isReportReason('spam')).toBe(true);
    expect(isReportReason('libellous')).toBe(false);
    expect(isReportReason(null)).toBe(false);
  });
});

describe('validateReport', () => {
  it('builds a payload with a trimmed detail', () => {
    const check = validateReport({ commentId: 'c1', reason: 'spam', detail: '  buy pills  ' });
    expect(check).toEqual({
      ok: true,
      value: { commentId: 'c1', reason: 'spam', detail: 'buy pills' },
    });
  });

  it('normalizes an empty or whitespace detail to null', () => {
    expect(validateReport({ commentId: 'c1', reason: 'other', detail: '   ' })).toEqual({
      ok: true,
      value: { commentId: 'c1', reason: 'other', detail: null },
    });
    expect(validateReport({ commentId: 'c1', reason: 'other' })).toEqual({
      ok: true,
      value: { commentId: 'c1', reason: 'other', detail: null },
    });
  });

  it('requires a reason', () => {
    const check = validateReport({ commentId: 'c1', reason: null });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toBe('Choose a reason.');
  });

  it('requires a comment id', () => {
    expect(validateReport({ commentId: '', reason: 'spam' }).ok).toBe(false);
  });

  it('rejects an over-long detail before spending a round trip', () => {
    const check = validateReport({
      commentId: 'c1',
      reason: 'other',
      detail: 'x'.repeat(MAX_REPORT_DETAIL_LENGTH + 1),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(String(MAX_REPORT_DETAIL_LENGTH));
  });

  it('accepts a detail exactly at the cap', () => {
    expect(
      validateReport({
        commentId: 'c1',
        reason: 'other',
        detail: 'x'.repeat(MAX_REPORT_DETAIL_LENGTH),
      }).ok,
    ).toBe(true);
  });
});

describe('parseReportPayload', () => {
  it('round-trips a validated payload', () => {
    const check = validateReport({ commentId: 'c1', reason: 'offensive', detail: 'slurs' });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(parseReportPayload(JSON.stringify(check.value))).toEqual(check.value);
  });

  it.each([
    ['not json', '{oops'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['a missing comment id', JSON.stringify({ reason: 'spam' })],
    ['an empty comment id', JSON.stringify({ commentId: '', reason: 'spam' })],
    ['an unknown reason', JSON.stringify({ commentId: 'c1', reason: 'vibes' })],
  ])('returns null for %s', (_label, json) => {
    expect(parseReportPayload(json)).toBeNull();
  });

  it('coerces a missing detail to null', () => {
    expect(parseReportPayload(JSON.stringify({ commentId: 'c1', reason: 'spam' }))).toEqual({
      commentId: 'c1',
      reason: 'spam',
      detail: null,
    });
  });
});
