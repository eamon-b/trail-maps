import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  banUser,
  createComment,
  makeAdmin,
  registerDevice,
  reportComment,
  url,
} from './helpers';
import type {
  AdminReportsResponse,
  ReportCommentResponse,
} from '../../../src/lib/comments-api-types';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** Read the admin report list with a freshly-promoted admin device. */
async function readAdminReports(): Promise<AdminReportsResponse> {
  const admin = await registerDevice('Moderator');
  await makeAdmin(admin.userId);
  const res = await SELF.fetch(url('/v1/admin/reports?limit=500'), {
    headers: authHeaders(admin),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AdminReportsResponse;
}

/**
 * Seed `count` reports for a user straight into D1 (with a real comment row each,
 * so the foreign keys hold) to push them to the rate-limit cap without dozens of
 * HTTP round-trips.
 */
async function seedReports(userId: string, count: number): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const commentId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO comments (id, trail_id, waypoint_id, user_id, text, created_at, updated_at)
       VALUES (?, 'heysen', 'seeded-report-target', ?, 'seed', ?, ?)`
    )
      .bind(commentId, userId, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO comment_reports (id, comment_id, user_id, reason, detail, created_at)
       VALUES (?, ?, ?, 'spam', NULL, ?)`
    )
      .bind(crypto.randomUUID(), commentId, userId, now)
      .run();
  }
}

describe('POST /v1/comments/:id/report — happy path', () => {
  it('files a report (201) and returns a server-minted id', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, { waypointId: 'report-happy-wp' });

    const res = await reportComment(reporter, id, { reason: 'spam', detail: '  buy my thing  ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReportCommentResponse;
    expect(body.reportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const row = await env.DB.prepare(
      `SELECT comment_id, user_id, reason, detail FROM comment_reports WHERE id = ?`
    )
      .bind(body.reportId)
      .first<{ comment_id: string; user_id: string; reason: string; detail: string | null }>();
    expect(row).toMatchObject({
      comment_id: id,
      user_id: reporter.userId,
      reason: 'spam',
      detail: 'buy my thing', // trimmed
    });
  });

  it('accepts every reason in the enum, and a missing detail', async () => {
    const author = await registerDevice('Author');
    const { id } = await createComment(author, { waypointId: 'report-reasons-wp' });

    for (const reason of ['spam', 'offensive', 'inaccurate', 'other']) {
      const reporter = await registerDevice(`Reporter ${reason}`);
      const res = await reportComment(reporter, id, { reason });
      expect(res.status).toBe(201);
    }

    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(detail IS NULL) AS nulls FROM comment_reports WHERE comment_id = ?`
    )
      .bind(id)
      .first<{ n: number; nulls: number }>();
    expect(stored?.n).toBe(4);
    expect(stored?.nulls).toBe(4);
  });

  it('lets a banned user report (reporting is a safety action)', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Banned Reporter');
    await banUser(reporter.userId);
    const { id } = await createComment(author, { waypointId: 'report-banned-wp' });

    const res = await reportComment(reporter, id, { reason: 'offensive' });
    expect(res.status).toBe(201);
  });

  it('lets an author report their own comment', async () => {
    const author = await registerDevice('Author');
    const { id } = await createComment(author, { waypointId: 'report-self-wp' });
    const res = await reportComment(author, id, { reason: 'other' });
    expect(res.status).toBe(201);
  });
});

describe('POST /v1/comments/:id/report — idempotency', () => {
  it('replays the original report id on a repeat submission (200)', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, { waypointId: 'report-replay-wp' });

    const first = await reportComment(reporter, id, { reason: 'spam' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as ReportCommentResponse;

    // A retry, even with a different reason, replays rather than stacking.
    const second = await reportComment(reporter, id, { reason: 'other', detail: 'changed my mind' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ReportCommentResponse;
    expect(secondBody.reportId).toBe(firstBody.reportId);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ? AND user_id = ?`
    )
      .bind(id, reporter.userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('keeps separate reports from different reporters', async () => {
    const author = await registerDevice('Author');
    const a = await registerDevice('Reporter A');
    const b = await registerDevice('Reporter B');
    const { id } = await createComment(author, { waypointId: 'report-two-wp' });

    const resA = await reportComment(a, id, { reason: 'spam' });
    const resB = await reportComment(b, id, { reason: 'inaccurate' });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const idA = ((await resA.json()) as ReportCommentResponse).reportId;
    const idB = ((await resB.json()) as ReportCommentResponse).reportId;
    expect(idA).not.toBe(idB);
  });
});

describe('POST /v1/comments/:id/report — auth, existence, validation', () => {
  it('401 without a token', async () => {
    const author = await registerDevice('Author');
    const { id } = await createComment(author, { waypointId: 'report-noauth-wp' });
    const res = await SELF.fetch(url(`/v1/comments/${id}/report`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 for a non-UUID comment id', async () => {
    const reporter = await registerDevice('Reporter');
    const res = await reportComment(reporter, 'not-a-uuid', { reason: 'spam' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_comment_id');
  });

  it('404 for a comment that does not exist', async () => {
    const reporter = await registerDevice('Reporter');
    const res = await reportComment(reporter, crypto.randomUUID(), { reason: 'spam' });
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('not_found');
  });

  it('410 for a soft-deleted comment', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, { waypointId: 'report-deleted-wp' });
    const del = await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(author),
    });
    expect(del.status).toBe(204);

    const res = await reportComment(reporter, id, { reason: 'spam' });
    expect(res.status).toBe(410);
    expect(errorCode(await res.json())).toBe('comment_deleted');
  });

  it('400 invalid_reason for a missing or unknown reason', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, { waypointId: 'report-reason-bad-wp' });

    const missing = await reportComment(reporter, id, {});
    expect(missing.status).toBe(400);
    expect(errorCode(await missing.json())).toBe('invalid_reason');

    const unknown = await reportComment(reporter, id, { reason: 'annoying' });
    expect(unknown.status).toBe(400);
    expect(errorCode(await unknown.json())).toBe('invalid_reason');

    const wrongType = await reportComment(reporter, id, { reason: 7 });
    expect(wrongType.status).toBe(400);
    expect(errorCode(await wrongType.json())).toBe('invalid_reason');
  });

  it('400 invalid_detail for an over-long or non-string detail', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, { waypointId: 'report-detail-bad-wp' });

    const tooLong = await reportComment(reporter, id, { reason: 'spam', detail: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
    expect(errorCode(await tooLong.json())).toBe('invalid_detail');

    const wrongType = await reportComment(reporter, id, { reason: 'spam', detail: 12 });
    expect(wrongType.status).toBe(400);
    expect(errorCode(await wrongType.json())).toBe('invalid_detail');

    // Exactly 500 is fine, and nothing was stored by the rejected attempts.
    const ok = await reportComment(reporter, id, { reason: 'spam', detail: 'y'.repeat(500) });
    expect(ok.status).toBe(201);
  });

  it('405 for a wrong method on the report path', async () => {
    const author = await registerDevice('Author');
    const { id } = await createComment(author, { waypointId: 'report-method-wp' });
    const res = await SELF.fetch(url(`/v1/comments/${id}/report`), { method: 'GET' });
    expect(res.status).toBe(405);
    expect(errorCode(await res.json())).toBe('method_not_allowed');
  });
});

describe('POST /v1/comments/:id/report — rate limit', () => {
  it('429 once 20 reports have been filed in the window', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Prolific Reporter');
    const { id } = await createComment(author, { waypointId: 'report-rate-wp' });

    await seedReports(reporter.userId, 20);

    const res = await reportComment(reporter, id, { reason: 'spam' });
    expect(res.status).toBe(429);
    expect(errorCode(await res.json())).toBe('rate_limited');

    // A different reporter is unaffected.
    const other = await registerDevice('Fresh Reporter');
    expect((await reportComment(other, id, { reason: 'spam' })).status).toBe(201);
  });

  it('does not rate-limit an idempotent replay at the cap', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Capped Reporter');
    const { id } = await createComment(author, { waypointId: 'report-rate-replay-wp' });

    const first = await reportComment(reporter, id, { reason: 'spam' });
    expect(first.status).toBe(201);
    const reportId = ((await first.json()) as ReportCommentResponse).reportId;

    // Push the user to the cap with 19 more seeded rows (20 total).
    await seedReports(reporter.userId, 19);

    const replay = await reportComment(reporter, id, { reason: 'spam' });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as ReportCommentResponse).reportId).toBe(reportId);
  });
});

describe('GET /v1/admin/reports', () => {
  it('401 unauthenticated, 403 for a non-admin', async () => {
    const anon = await SELF.fetch(url('/v1/admin/reports'));
    expect(anon.status).toBe(401);

    const plain = await registerDevice('Plain');
    const res = await SELF.fetch(url('/v1/admin/reports'), { headers: authHeaders(plain) });
    expect(res.status).toBe(403);
    expect(errorCode(await res.json())).toBe('forbidden');
  });

  it('returns reports newest-first with comment context', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id: older } = await createComment(author, {
      waypointId: 'admin-report-older-wp',
      text: 'first comment',
    });
    const { id: newer } = await createComment(author, {
      waypointId: 'admin-report-newer-wp',
      text: 'second comment',
    });

    const first = await reportComment(reporter, older, { reason: 'spam', detail: 'ad' });
    expect(first.status).toBe(201);
    expect((await reportComment(reporter, newer, { reason: 'offensive' })).status).toBe(201);

    // Both reports can land in the same millisecond, which would leave the
    // created_at DESC ordering to the random-uuid tiebreak. Backdate the first so
    // the newest-first assertion below is deterministic.
    const firstId = ((await first.json()) as ReportCommentResponse).reportId;
    await env.DB.prepare(`UPDATE comment_reports SET created_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString(), firstId)
      .run();

    const body = await readAdminReports();
    const mine = body.reports.filter((r) => r.reporterUserId === reporter.userId);
    expect(mine).toHaveLength(2);

    // Newest first.
    expect(mine[0].commentId).toBe(newer);
    expect(mine[1].commentId).toBe(older);

    expect(mine[0]).toMatchObject({
      trailId: 'heysen',
      waypointId: 'admin-report-newer-wp',
      reason: 'offensive',
      detail: null,
      commentText: 'second comment',
      commentDeleted: false,
    });
    expect(mine[1]).toMatchObject({
      waypointId: 'admin-report-older-wp',
      reason: 'spam',
      detail: 'ad',
      commentText: 'first comment',
      commentDeleted: false,
    });
    expect(typeof mine[0].createdAt).toBe('string');
  });

  it('hides the text and flags commentDeleted once the comment is removed', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Reporter');
    const { id } = await createComment(author, {
      waypointId: 'admin-report-gone-wp',
      text: 'offending text',
    });
    expect((await reportComment(reporter, id, { reason: 'offensive' })).status).toBe(201);

    await SELF.fetch(url(`/v1/comments/${id}`), {
      method: 'DELETE',
      headers: authHeaders(author),
    });

    const body = await readAdminReports();
    const row = body.reports.find((r) => r.commentId === id);
    expect(row).toBeDefined();
    expect(row?.commentDeleted).toBe(true);
    expect(row?.commentText).toBeNull();
    // The report itself survives as a moderation record.
    expect(row?.reason).toBe('offensive');
  });

  it('405 for a wrong method', async () => {
    const admin = await registerDevice('Moderator');
    await makeAdmin(admin.userId);
    const res = await SELF.fetch(url('/v1/admin/reports'), {
      method: 'POST',
      headers: authHeaders(admin),
      body: '{}',
    });
    expect(res.status).toBe(405);
  });
});
