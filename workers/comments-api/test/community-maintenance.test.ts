/**
 * Community routes: the follow-ups to the first review of PR #108 — superseded
 * public versions, durable de-attribution, stale reviews, the scheduled
 * handler, edit re-checks, the report limit race, admin restores racing a
 * delete, paging, and resubmitting a moderator-removed track.
 */
import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { authHeaders, deleteMe, makeAdmin, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import { envWithHook, makeTrail, registerAgedDevice, submitBody, submitRoute } from './community-fixtures';
import {
  STALE_REVIEW_AFTER_MS,
  adminSetCommunityStatus,
  deattributeStatement,
  deattributeStoredRoutes,
  listCommunityRoutes,
  listMyCommunityRoutes,
  patchCommunityRoute,
  rerunStaleReviews,
  retryPendingDeattributions,
  REVIEW_HIDE_NOTE,
} from '../src/community';
import type { ReviewClient } from '../src/community-review';
import type { Env } from '../src/http';
import type {
  CommunityAdminListResponse,
  CommunityChecksFailedBody,
  CommunityListResponse,
  CommunityRouteDetail,
} from '../../../src/lib/community-types';
import type { ProcessedTrail } from '../../../src/lib/trail-types';

const testEnv = env as unknown as Env;

async function submitOk(device: Device, overrides: Record<string, unknown> = {}): Promise<CommunityRouteDetail> {
  const res = await submitRoute(device, submitBody(overrides));
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return (await res.json()) as CommunityRouteDetail;
}

function request(device: Device | null, path: string, method = 'GET', body?: unknown): Request {
  return new Request(url(path), {
    method,
    headers: device ? authHeaders(device) : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function patchDirect(
  device: Device,
  id: string,
  body: unknown,
  deps: Parameters<typeof patchCommunityRoute>[4] = {},
  e: Env = testEnv
): Promise<CommunityRouteDetail> {
  const ctx = createExecutionContext();
  const res = await patchCommunityRoute(request(device, `/v1/community/routes/${id}`, 'PATCH', body), e, ctx, id, deps);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as CommunityRouteDetail;
}

async function patch(device: Device, id: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}`), {
    method: 'PATCH',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

async function setStatus(device: Device, id: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(`/v1/admin/community/routes/${id}/status`), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

async function del(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}`), { method: 'DELETE', headers: authHeaders(device) });
}

function keyOf(trailUrl: string): string {
  return trailUrl.replace(/^https:\/\/photos\.test\//, '');
}

async function publicKeys(id: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix: `community/v1/${id}.` })).objects.map((o) => o.key).sort();
}

async function privateKeys(id: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix: `community/private/${id}/` })).objects.map((o) => o.key);
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`).bind(id).first();
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

async function eventually(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never held');
}

async function objectText(key: string): Promise<string> {
  const object = await env.PHOTOS.get(key);
  if (!object) throw new Error(`no object ${key}`);
  return object.text();
}

/** The test env with its PHOTOS bucket's `method` always failing. */
function envFailing(method: 'put' | 'delete'): Env {
  const photos = env.PHOTOS;
  const PHOTOS = {
    put: (...args: Parameters<R2Bucket['put']>) =>
      method === 'put' ? Promise.reject(new Error('R2 down')) : photos.put(...args),
    delete: (...args: Parameters<R2Bucket['delete']>) =>
      method === 'delete' ? Promise.reject(new Error('R2 down')) : photos.delete(...args),
    get: (...args: Parameters<R2Bucket['get']>) => photos.get(...args),
    head: (...args: Parameters<R2Bucket['head']>) => photos.head(...args),
    list: (...args: Parameters<R2Bucket['list']>) => photos.list(...args),
  } as unknown as R2Bucket;
  return { ...testEnv, PHOTOS };
}

function looksGood(): ReviewClient & { calls: number } {
  const client = {
    calls: 0,
    beta: {
      messages: {
        create: async () => {
          client.calls++;
          return {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'test',
            content: [
              {
                type: 'text',
                text: JSON.stringify({ verdict: 'looks_good', confidence: 0.9, summary: 'A walk.', concerns: [] }),
                citations: null,
              },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    },
  };
  return client as unknown as ReviewClient & { calls: number };
}

// ---------------------------------------------------------------------------

describe('superseded public versions', () => {
  it('keeps the current and the previous version after an edit, and purges the rest', async () => {
    const owner = await registerDevice();
    const v1 = await submitOk(owner);
    const v2 = await patchDirect(owner, v1.id, { name: 'Second name' }, { purgeGraceMs: 0 });
    expect(await publicKeys(v1.id)).toEqual([keyOf(v1.trailUrl!), keyOf(v2.trailUrl!)].sort());

    const v3 = await patchDirect(owner, v1.id, { name: 'Third name' }, { purgeGraceMs: 0 });
    expect(await publicKeys(v1.id)).toEqual([keyOf(v2.trailUrl!), keyOf(v3.trailUrl!)].sort());
    expect(await env.PHOTOS.head(keyOf(v1.trailUrl!))).toBeNull();
  });

  it('leaves a version uploaded moments ago alone: a concurrent republish may not have named it yet', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const inFlight = `community/v1/${route.id}.0123456789ab.json`;
    await env.PHOTOS.put(inFlight, '{}');
    await patchDirect(owner, route.id, { name: 'Renamed once' });
    expect(await env.PHOTOS.head(inFlight)).not.toBeNull();
    await patchDirect(owner, route.id, { name: 'Renamed twice' }, { purgeGraceMs: 0 });
    expect(await env.PHOTOS.head(inFlight)).toBeNull();
  });

  it('does nothing to a hidden route, which has no public copy to keep', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    const edited = await patchDirect(owner, route.id, { name: 'Edited while hidden' }, { purgeGraceMs: 0 });
    expect(edited.trailUrl).toBeNull();
    expect(await publicKeys(route.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('durable de-attribution', () => {
  it('marks the routes pending in the statement that clears the name, but not removed ones', async () => {
    const owner = await registerDevice('Marked Walker');
    const live = await submitOk(owner);
    const gone = await submitOk(owner);
    expect((await del(owner, gone.id)).status).toBe(204);
    await deattributeStatement(testEnv, owner.userId).run();
    expect((await row(live.id)).deattribute_pending).toBe(1);
    expect((await row(live.id)).submitted_by_name).toBeNull();
    expect((await row(gone.id)).deattribute_pending).toBe(0);
  });

  it('stays pending when the rewrite fails, and the retry finishes it', async () => {
    const owner = await registerDevice('Retry Walker');
    const route = await submitOk(owner);
    await deattributeStatement(testEnv, owner.userId).run();
    await deattributeStoredRoutes(envFailing('put'), owner.userId);
    let r = await row(route.id);
    expect(r.deattribute_pending).toBe(1);
    expect(await objectText(r.private_key as string)).toContain('Retry Walker');

    await retryPendingDeattributions(testEnv);
    r = await row(route.id);
    expect(r.deattribute_pending).toBe(0);
    expect(await objectText(r.private_key as string)).not.toContain('Retry Walker');
    expect(await objectText(r.r2_key as string)).not.toContain('Retry Walker');
    expect(await publicKeys(route.id)).toEqual([r.r2_key]);
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
  });

  it('stays pending when the old copies cannot be purged, and the retry purges them', async () => {
    const owner = await registerDevice('Purge Walker');
    const route = await submitOk(owner);
    await deattributeStatement(testEnv, owner.userId).run();
    await deattributeStoredRoutes(envFailing('delete'), owner.userId);
    expect((await row(route.id)).deattribute_pending).toBe(1);
    // The old version, naming the account, is still up.
    expect(await env.PHOTOS.head(keyOf(route.trailUrl!))).not.toBeNull();
    // A retry this soon spares the interrupted attempt's private leftovers:
    // a concurrent attempt could be writing one.
    await retryPendingDeattributions(testEnv, undefined, 60_000);
    expect((await privateKeys(route.id)).length).toBeGreaterThan(1);
    await env.DB.prepare(`UPDATE community_routes SET deattribute_pending = 1 WHERE id = ?`).bind(route.id).run();

    await retryPendingDeattributions(testEnv, undefined, 0);
    const r = await row(route.id);
    expect(r.deattribute_pending).toBe(0);
    expect(await env.PHOTOS.head(keyOf(route.trailUrl!))).toBeNull();
    expect(await publicKeys(route.id)).toEqual([r.r2_key]);
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
    expect(await objectText(r.private_key as string)).not.toContain('Purge Walker');
  });

  it('clears the mark after DELETE /v1/me finishes, and the retry leaves the route alone', async () => {
    const owner = await registerDevice('Clean Walker');
    const route = await submitOk(owner);
    expect((await deleteMe(owner)).status).toBe(204);
    await eventually(async () => (await row(route.id)).deattribute_pending === 0);
    const before = await row(route.id);
    await retryPendingDeattributions(testEnv);
    expect((await row(route.id)).updated_at).toBe(before.updated_at);
  });

  it('runs from the scheduled handler', async () => {
    const owner = await registerDevice('Cron Walker');
    const route = await submitOk(owner);
    await deattributeStatement(testEnv, owner.userId).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *' }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const r = await row(route.id);
    expect(r.deattribute_pending).toBe(0);
    expect(await objectText(r.r2_key as string)).not.toContain('Cron Walker');
  });
});

// ---------------------------------------------------------------------------

describe('stale reviews', () => {
  async function makePending(id: string, ageMs: number): Promise<void> {
    await env.DB.prepare(
      `UPDATE community_routes SET review_status = 'pending', review_json = '{"status":"pending"}', updated_at = ?
        WHERE id = ?`
    )
      .bind(new Date(Date.now() - ageMs).toISOString(), id)
      .run();
  }

  it('re-runs a review left pending for over ten minutes, and only that one', async () => {
    const owner = await registerDevice();
    const stale = await submitOk(owner);
    const fresh = await submitOk(owner);
    await makePending(stale.id, STALE_REVIEW_AFTER_MS + 60_000);
    await makePending(fresh.id, 60_000);
    const client = looksGood();
    await rerunStaleReviews(testEnv, { client });
    expect((await row(stale.id)).review_status).toBe('done');
    expect((await row(fresh.id)).review_status).toBe('pending');
    expect(client.calls).toBeGreaterThanOrEqual(1);
  });

  it('records skipped, sending nothing, without an API key', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    await makePending(route.id, STALE_REVIEW_AFTER_MS + 60_000);
    await rerunStaleReviews(testEnv);
    expect((await row(route.id)).review_status).toBe('skipped');
  });

  it('keeps its guard: a route that changes during the review gets no verdict', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    await makePending(route.id, STALE_REVIEW_AFTER_MS + 60_000);
    const client = {
      beta: {
        messages: {
          create: async (...args: unknown[]) => {
            // The admin verifies while the model is thinking.
            await env.DB.prepare(`UPDATE community_routes SET updated_at = ? WHERE id = ?`)
              .bind(new Date().toISOString(), route.id)
              .run();
            return (looksGood().beta.messages.create as (...a: unknown[]) => unknown)(...args);
          },
        },
      },
    } as unknown as ReviewClient;
    await rerunStaleReviews(testEnv, { client });
    expect((await row(route.id)).review_status).toBe('pending');
  });

  it('leaves removed routes alone', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    expect((await del(owner, route.id)).status).toBe(204);
    await makePending(route.id, STALE_REVIEW_AFTER_MS + 60_000);
    const client = looksGood();
    await rerunStaleReviews(testEnv, { client }, 1000);
    expect((await row(route.id)).review_status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

describe('PATCH re-runs the metadata check', () => {
  const LINKS =
    'https://example.com/aaaaaaaaaaaaaaaaaaaa https://example.com/bbbbbbbbbbbbbbbbbbbbbbbbb https://example.com/cccccccccccccccc walk';

  function metadataOf(checks: { id: string; level: string; message: string }[]) {
    return checks.filter((c) => c.id === 'metadata');
  }

  it('updates the stored metadata entry when the description changes', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    expect(metadataOf(route.checks)[0].level).toBe('pass');

    const res = await patch(owner, route.id, { description: LINKS });
    expect(res.status).toBe(200);
    const linked = (await res.json()) as CommunityRouteDetail;
    expect(metadataOf(linked.checks)).toHaveLength(1);
    expect(metadataOf(linked.checks)[0]).toMatchObject({ level: 'warn' });
    expect(metadataOf(linked.checks)[0].message).toContain('description is mostly links');
    // Every other check is as it was.
    expect(linked.checks.filter((c) => c.id !== 'metadata')).toEqual(route.checks.filter((c) => c.id !== 'metadata'));

    const fixed = (await (
      await patch(owner, route.id, { description: 'Along the ridge, then down to the creek and back out again.' })
    ).json()) as CommunityRouteDetail;
    expect(metadataOf(fixed.checks)[0].level).toBe('pass');
  });

  it("keeps the waypoints' link warning while the new text passes", async () => {
    const owner = await registerDevice();
    const trail: ProcessedTrail = makeTrail();
    for (const w of trail.waypoints) w.description = LINKS;
    const route = await submitOk(owner, { trail });
    const warning = metadataOf(route.checks)[0];
    expect(warning.level).toBe('warn');
    expect(warning.message).toContain('waypoint descriptions');

    const renamed = (await (await patch(owner, route.id, { name: 'A new name' })).json()) as CommunityRouteDetail;
    expect(metadataOf(renamed.checks)).toEqual([warning]);
  });

  it('refuses text the check fails with the submit 422 shape', async () => {
    // The handler's own length validation (400) normally fires first; the
    // check is reached directly here, with the row's text already too long.
    const owner = await registerDevice();
    const route = await submitOk(owner);
    await env.DB.prepare(`UPDATE community_routes SET description = ? WHERE id = ?`)
      .bind('x'.repeat(20_000), route.id)
      .run();
    const res = await patch(owner, route.id, { name: 'Only the name changes' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as CommunityChecksFailedBody;
    expect(body.error.code).toBe('checks_failed');
    expect(metadataOf(body.checks)[0].level).toBe('fail');
    expect((await row(route.id)).name).toBe(route.name);
  });
});

// ---------------------------------------------------------------------------

describe('report limit', () => {
  it('lets only one of several parallel reports past the last unit of the allowance', async () => {
    const owner = await registerDevice();
    const reporter = await registerAgedDevice();
    const routes = await Promise.all(Array.from({ length: 5 }, () => submitOk(owner)));
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 19 }, () =>
        env.DB.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES ('community_report', ?, ?)`).bind(
          reporter.userId,
          now
        )
      )
    );
    const statuses = await Promise.all(
      routes.map(async (r) =>
        (
          await SELF.fetch(url(`/v1/community/routes/${r.id}/report`), {
            method: 'POST',
            headers: authHeaders(reporter),
            body: JSON.stringify({ reason: 'spam' }),
          })
        ).status
      )
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    const stored = await env.DB.prepare(`SELECT COUNT(*) AS n FROM community_route_reports WHERE user_id = ?`)
      .bind(reporter.userId)
      .first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });

  it('does not charge a repeat of a report already filed', async () => {
    const owner = await registerDevice();
    const reporter = await registerAgedDevice();
    const route = await submitOk(owner);
    const send = () =>
      SELF.fetch(url(`/v1/community/routes/${route.id}/report`), {
        method: 'POST',
        headers: authHeaders(reporter),
        body: JSON.stringify({ reason: 'spam' }),
      });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(200);
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rate_events WHERE bucket = 'community_report' AND key = ?`
    )
      .bind(reporter.userId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('admin restore racing the owner', () => {
  async function restoreDirect(admin: Device, id: string, hooked: Env): Promise<unknown> {
    const ctx = createExecutionContext();
    try {
      return await adminSetCommunityStatus(
        request(admin, `/v1/admin/community/routes/${id}/status`, 'POST', { status: 'unverified' }),
        hooked,
        ctx,
        id
      );
    } finally {
      await waitOnExecutionContext(ctx);
    }
  }

  it('404s when the owner deleted the route, purging it, after the admin read it', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    const hooked = envWithHook('get', async () => {
      expect((await del(owner, route.id)).status).toBe(204);
      await eventually(async () => (await privateKeys(route.id)).length === 0);
    });
    await expect(restoreDirect(admin, route.id, hooked)).rejects.toMatchObject({ status: 404 });
    expect((await row(route.id)).status).toBe('removed');
    expect(await publicKeys(route.id)).toEqual([]);
  });

  it('409s when an owner edit replaced the private copy after the admin read it', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    const oldPrivate = (await row(route.id)).private_key as string;
    const hooked = envWithHook('get', async () => {
      expect((await patch(owner, route.id, { name: 'Edited under review' })).status).toBe(200);
      await eventually(async () => (await env.PHOTOS.head(oldPrivate)) === null);
    });
    await expect(restoreDirect(admin, route.id, hooked)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.name).toBe('Edited under review');
  });
});

// ---------------------------------------------------------------------------

describe('paging', () => {
  async function page(
    handler: 'public' | 'mine',
    device: Device | null,
    query: string,
    pageSize: number
  ): Promise<{ status: number; body: CommunityListResponse }> {
    const ctx = createExecutionContext();
    const res =
      handler === 'public'
        ? await listCommunityRoutes(request(null, `/v1/community/routes${query}`), testEnv, { pageSize })
        : await listMyCommunityRoutes(request(device, `/v1/me/community/routes${query}`), testEnv, ctx, { pageSize });
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: (await res.json()) as CommunityListResponse };
  }

  async function walk(handler: 'public' | 'mine', device: Device | null, filter: string, pageSize: number) {
    const ids: string[] = [];
    let cursor: string | null | undefined = null;
    let pages = 0;
    do {
      const sep = filter ? '&' : '?';
      const q: string = cursor ? `${filter}${sep}cursor=${encodeURIComponent(cursor)}` : filter;
      const { status, body } = await page(handler, device, q, pageSize);
      expect(status).toBe(200);
      expect(body.routes.length).toBeLessThanOrEqual(pageSize);
      ids.push(...body.routes.map((r) => r.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    return { ids, pages };
  }

  it('pages the public list in a total order, ties broken by id', async () => {
    const owner = await registerDevice();
    const routes = await Promise.all(
      Array.from({ length: 5 }, () => submitOk(owner, { country: 'JP', state: null }))
    );
    // Three share one stamp: the cursor must still not skip or repeat any.
    const tie = '2026-01-01T00:00:00.000Z';
    for (const r of routes.slice(0, 3)) {
      await env.DB.prepare(`UPDATE community_routes SET created_at = ? WHERE id = ?`).bind(tie, r.id).run();
    }
    const { ids, pages } = await walk('public', null, '?country=JP', 2);
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(routes.map((r) => r.id).sort());
    const tied = routes.slice(0, 3).map((r) => r.id).sort().reverse();
    expect(ids.slice(2)).toEqual(tied);
  });

  it('pages the owner list', async () => {
    const owner = await registerDevice();
    const routes = await Promise.all(Array.from({ length: 3 }, () => submitOk(owner)));
    const { ids, pages } = await walk('mine', owner, '', 2);
    expect(pages).toBe(2);
    expect([...ids].sort()).toEqual(routes.map((r) => r.id).sort());
  });

  it('says there is no next page on the last one, and 400s a malformed cursor', async () => {
    const body = (await (await SELF.fetch(url('/v1/community/routes?country=JP'))).json()) as CommunityListResponse;
    expect(body.nextCursor).toBeNull();
    expect((await SELF.fetch(url('/v1/community/routes?cursor=%25%25'))).status).toBe(400);
    expect((await SELF.fetch(url(`/v1/community/routes?cursor=${btoa('not-a-date|c_xxxxxxxxxxxxxxxx')}`))).status).toBe(400);
    expect((await SELF.fetch(url(`/v1/community/routes?cursor=${btoa('2026-01-01T00:00:00.000Z|nope')}`))).status).toBe(400);
  });

  it('gives the admin queue the newest reports of each route, with the full count', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'verified' }); // stays up however many reports it gets
    const reporters = await Promise.all(Array.from({ length: 22 }, () => registerDevice()));
    await env.DB.batch(
      reporters.map((d, i) =>
        env.DB.prepare(
          `INSERT INTO community_route_reports (route_id, user_id, reason, note, created_at) VALUES (?, ?, 'spam', ?, ?)`
        ).bind(route.id, d.userId, `report ${i}`, new Date(Date.now() + i).toISOString())
      )
    );
    const res = await SELF.fetch(url('/v1/admin/community/routes'), { headers: authHeaders(admin) });
    const body = (await res.json()) as CommunityAdminListResponse;
    const entry = body.routes.find((r) => r.id === route.id)!;
    expect(entry.reportCount).toBe(22);
    expect(entry.reports).toHaveLength(20);
    expect(entry.reports![0].note).toBe('report 21');
  });
});

// ---------------------------------------------------------------------------

describe('resubmitting a removed track', () => {
  it('refuses a track an admin removed', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const trail = makeTrail();
    const route = await submitOk(owner, { trail });
    expect((await del(admin, route.id)).status).toBe(204);
    expect(await row(route.id)).toMatchObject({ removed_by: 'admin', blocks_resubmit: 1 });

    for (const who of [owner, await registerDevice()]) {
      const res = await submitRoute(who, submitBody({ trail }));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string }; existingId?: string };
      expect(body.error.code).toBe('duplicate');
      expect(body.existingId).toBeUndefined();
    }
  });

  it("refuses a track whose owner deleted it while an admin had it hidden", async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const trail = makeTrail();
    const route = await submitOk(owner, { trail });
    expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    expect((await del(owner, route.id)).status).toBe(204);
    expect(await row(route.id)).toMatchObject({ removed_by: 'owner', blocks_resubmit: 1 });
    expect((await submitRoute(owner, submitBody({ trail }))).status).toBe(409);
  });

  it('accepts a track its owner deleted, even one the automatic review had hidden', async () => {
    const owner = await registerDevice();
    const trail = makeTrail();
    const route = await submitOk(owner, { trail });
    expect((await del(owner, route.id)).status).toBe(204);
    expect(await row(route.id)).toMatchObject({ removed_by: 'owner', blocks_resubmit: 0 });
    const again = await submitOk(owner, { trail });

    await env.DB.prepare(`UPDATE community_routes SET status = 'hidden', status_note = ? WHERE id = ?`)
      .bind(REVIEW_HIDE_NOTE, again.id)
      .run();
    expect((await del(owner, again.id)).status).toBe(204);
    expect((await row(again.id)).blocks_resubmit).toBe(0);
    expect((await submitRoute(owner, submitBody({ trail }))).status).toBe(201);
  });
});
