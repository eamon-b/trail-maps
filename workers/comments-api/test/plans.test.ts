import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  createPlan,
  deleteMe,
  listPlans,
  planBody,
  putPlan,
  registerDevice,
  url,
} from './helpers';
import type { Device } from './helpers';
import type {
  PlanSyncEntry,
  PlansSyncResponse,
  SharePlanResponse,
  SharedPlanResponse,
} from '../../../src/lib/comments-api-types';
import type { PlanDocument } from '../../../src/lib/plan-types';

async function planRow(id: string): Promise<{
  user_id: string;
  trail_id: string;
  share_id: string | null;
  updated_at: string;
  deleted_at: string | null;
} | null> {
  return env.DB.prepare(
    `SELECT user_id, trail_id, share_id, updated_at, deleted_at FROM plans WHERE id = ?`
  )
    .bind(id)
    .first();
}

async function share(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/plans/${id}/share`), {
    method: 'POST',
    headers: authHeaders(device),
  });
}

async function unshare(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/plans/${id}/share`), {
    method: 'DELETE',
    headers: authHeaders(device),
  });
}

async function deletePlan(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/plans/${id}`), {
    method: 'DELETE',
    headers: authHeaders(device),
  });
}

describe('PUT /v1/plans/:id', () => {
  it('creates a plan (201) and replaces it (200)', async () => {
    const device = await registerDevice('Planner');
    const { id, res } = await createPlan(device);
    expect(res.status).toBe(201);

    const created = (await res.json()) as PlanSyncEntry;
    expect(created.id).toBe(id);
    expect(created.trailId).toBe('heysen');
    expect(created.shareId).toBeNull();
    expect(created.document.stops).toHaveLength(2);
    expect(created.document.updatedAt).toBe(created.updatedAt);
    expect(created.document.version).toBe(1);

    const replaced = await putPlan(
      device,
      id,
      planBody(id, { name: 'Renamed', stops: [{ km: 5, name: 'Creek', nights: 1 }] })
    );
    expect(replaced.status).toBe(200);
    const body = (await replaced.json()) as PlanSyncEntry;
    expect(body.document.name).toBe('Renamed');
    expect(body.document.stops).toHaveLength(1);
  });

  it('normalises the stored document: trimmed name, dropped empty note', async () => {
    const device = await registerDevice('Tidy');
    const id = crypto.randomUUID();
    const res = await putPlan(
      device,
      id,
      planBody(id, {
        name: '  Spaced  ',
        stops: [{ km: 1, name: ' Camp ', nights: 1, note: '   ', booked: false }],
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanSyncEntry;
    expect(body.document.name).toBe('Spaced');
    expect(body.document.stops[0]).toEqual({ km: 1, name: 'Camp', nights: 1 });
  });

  it('401s without a token', async () => {
    const id = crypto.randomUUID();
    const res = await SELF.fetch(url(`/v1/plans/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planBody(id)),
    });
    expect(res.status).toBe(401);
  });

  it('409 id_conflict when the id belongs to another user', async () => {
    const owner = await registerDevice('Owner');
    const other = await registerDevice('Other');
    const { id } = await createPlan(owner);

    const res = await putPlan(other, id, planBody(id, { name: 'Hijack' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('id_conflict');

    // The stored row is untouched.
    expect((await planRow(id))?.user_id).toBe(owner.userId);
  });

  it('409 plan_exists with the existing id for a second live plan on one trail', async () => {
    const device = await registerDevice('Double');
    const { id: first } = await createPlan(device);
    const second = crypto.randomUUID();

    const res = await putPlan(device, second, planBody(second));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; existingId: string };
    expect(body.error.code).toBe('plan_exists');
    expect(body.existingId).toBe(first);
    expect(await planRow(second)).toBeNull();

    // A different trail is fine.
    const third = crypto.randomUUID();
    const ok = await putPlan(device, third, planBody(third, { trailId: 'larapinta' }));
    expect(ok.status).toBe(201);
  });

  it('allows a new plan for a trail whose previous plan was deleted', async () => {
    const device = await registerDevice('Recycler');
    const { id } = await createPlan(device);
    expect((await deletePlan(device, id)).status).toBe(204);

    const next = crypto.randomUUID();
    expect((await putPlan(device, next, planBody(next))).status).toBe(201);
  });

  it('rejects a body id that does not match the path', async () => {
    const device = await registerDevice('Mismatch');
    const id = crypto.randomUUID();
    const res = await putPlan(device, id, planBody(crypto.randomUUID()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('id_mismatch');
  });

  it('rejects a non-uuid path id', async () => {
    const device = await registerDevice('Not a uuid');
    const res = await putPlan(device, 'plan-1', planBody('plan-1'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_plan_id');
  });

  it('rejects an imported (u_) trail with trail_not_allowed', async () => {
    const device = await registerDevice('Importer');
    const id = crypto.randomUUID();
    const res = await putPlan(device, id, planBody(id, { trailId: 'u_1a2b3c' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('trail_not_allowed');
    expect(await planRow(id)).toBeNull();
  });

  it('rejects more than 500 stops', async () => {
    const device = await registerDevice('Too many stops');
    const id = crypto.randomUUID();
    const stops = Array.from({ length: 501 }, (_, i) => ({ km: i, name: `S${i}`, nights: 1 }));
    const res = await putPlan(device, id, planBody(id, { stops }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too_many_stops');
  });

  it('rejects a document over 64 KB', async () => {
    const device = await registerDevice('Fat plan');
    const id = crypto.randomUUID();
    // 200 stops x a 500-char note comfortably clears 64 KB while staying under
    // every per-field limit, so the size guard is what rejects it.
    const stops = Array.from({ length: 200 }, (_, i) => ({
      km: i,
      name: `Stop ${i}`,
      nights: 1,
      note: 'x'.repeat(500),
    }));
    const res = await putPlan(device, id, planBody(id, { stops }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('plan_too_large');
    expect(await planRow(id)).toBeNull();
  });

  it('rejects unsorted stops, bad nights, bad direction and bad start dates', async () => {
    const device = await registerDevice('Invalid');
    const cases: Array<[Partial<Omit<PlanDocument, 'updatedAt'>>, string]> = [
      [
        {
          stops: [
            { km: 20, name: 'Later', nights: 1 },
            { km: 10, name: 'Earlier', nights: 1 },
          ],
        },
        'stops_unsorted',
      ],
      [{ stops: [{ km: 1, name: 'Camp', nights: 0 }] }, 'invalid_stop'],
      [{ stops: [{ km: 1, name: 'Camp', nights: 15 }] }, 'invalid_stop'],
      [{ stops: [{ km: 1, name: 'Camp', nights: 1, note: 'x'.repeat(501) }] }, 'invalid_stop'],
      [{ direction: 'EAST' as never }, 'invalid_direction'],
      [{ startDate: '01/04/2026' as never }, 'invalid_start_date'],
      [{ startDate: '2026-02-31' as never }, 'invalid_start_date'],
      [{ name: 'x'.repeat(81) }, 'invalid_plan_name'],
      [{ version: 2 as never }, 'invalid_plan_version'],
    ];

    for (const [overrides, code] of cases) {
      const id = crypto.randomUUID();
      const res = await putPlan(device, id, planBody(id, overrides));
      expect(res.status, code).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('rate limits plan writes at 240 a day', async () => {
    const device = await registerDevice('Busy');
    const { id } = await createPlan(device);
    const now = new Date().toISOString();

    // Backfill the log to one below the ceiling rather than issuing 240 PUTs
    // (the create above already logged one).
    const statements = Array.from({ length: 238 }, () =>
      env.DB.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?)`).bind(
        'plan_put',
        device.userId,
        now
      )
    );
    await env.DB.batch(statements);

    expect((await putPlan(device, id, planBody(id, { name: 'At the limit' }))).status).toBe(200);

    const blocked = await putPlan(device, id, planBody(id, { name: 'Over' }));
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    // Events outside the window do not count.
    await env.DB.prepare(`UPDATE rate_events SET created_at = ? WHERE key = ?`)
      .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), device.userId)
      .run();
    expect((await putPlan(device, id, planBody(id, { name: 'Next day' }))).status).toBe(200);
  });
});

describe('GET /v1/plans', () => {
  it('lists only the caller’s plans', async () => {
    const mine = await registerDevice('Mine');
    const theirs = await registerDevice('Theirs');
    const { id: a } = await createPlan(mine);
    const { id: b } = await createPlan(theirs);

    const res = await listPlans(mine);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansSyncResponse;
    expect(body.plans.map((p) => p.id)).toEqual([a]);
    expect(body.plans.some((p) => p.id === b)).toBe(false);
    expect(body.syncedAt).toMatch(/^\d{4}-/);
    expect(body.nextCursor).toBeNull();
  });

  it('401s without a token', async () => {
    expect((await SELF.fetch(url('/v1/plans'))).status).toBe(401);
  });

  it('omits deleted plans from the snapshot and emits a tombstone in the delta', async () => {
    const device = await registerDevice('Tombstone');
    const { id, res } = await createPlan(device);
    const created = (await res.json()) as PlanSyncEntry;
    const since = new Date(Date.parse(created.updatedAt) - 1).toISOString();

    expect((await deletePlan(device, id)).status).toBe(204);

    const snapshot = (await (await listPlans(device)).json()) as PlansSyncResponse;
    expect(snapshot.plans.some((p) => p.id === id)).toBe(false);

    const delta = (await (
      await listPlans(device, `?since=${encodeURIComponent(since)}`)
    ).json()) as PlansSyncResponse;
    const entry = delta.plans.find((p) => p.id === id);
    expect(entry).toBeDefined();
    expect(entry && 'deleted' in entry ? entry.deleted : false).toBe(true);
    expect(entry && 'document' in entry).toBe(false);
    expect(entry?.updatedAt).not.toBe(created.updatedAt);
  });

  it('pages with a keyset cursor', async () => {
    const device = await registerDevice('Pager');
    const trails = ['heysen', 'larapinta', 'aawt'];
    for (const trailId of trails) {
      const id = crypto.randomUUID();
      expect((await putPlan(device, id, planBody(id, { trailId }))).status).toBe(201);
    }

    const first = (await (await listPlans(device, '?limit=2')).json()) as PlansSyncResponse;
    expect(first.plans).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = (await (
      await listPlans(device, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json()) as PlansSyncResponse;
    expect(second.plans).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.plans, ...second.plans].map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects a malformed cursor', async () => {
    const device = await registerDevice('Bad cursor');
    const res = await listPlans(device, '?cursor=' + encodeURIComponent(btoa('no-separator')));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_cursor');
  });
});

describe('DELETE /v1/plans/:id', () => {
  it('soft deletes, bumps updated_at and is idempotent', async () => {
    const device = await registerDevice('Deleter');
    const { id, res } = await createPlan(device);
    const created = (await res.json()) as PlanSyncEntry;

    expect((await deletePlan(device, id)).status).toBe(204);
    const row = await planRow(id);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.updated_at).toBe(row?.deleted_at);
    expect(row?.updated_at).not.toBe(created.updatedAt);

    expect((await deletePlan(device, id)).status).toBe(204);
    expect((await planRow(id))?.updated_at).toBe(row?.updated_at);
  });

  it('404s for another user’s plan and leaves it alone', async () => {
    const owner = await registerDevice('Keeper');
    const other = await registerDevice('Snoop');
    const { id } = await createPlan(owner);

    expect((await deletePlan(other, id)).status).toBe(404);
    expect((await planRow(id))?.deleted_at).toBeNull();
  });
});

describe('plan sharing', () => {
  it('mints a share id idempotently and serves it without auth', async () => {
    const device = await registerDevice('Sharer');
    const { id } = await createPlan(device);

    const res = await share(device, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SharePlanResponse;
    expect(body.shareId).toHaveLength(22);
    expect(body.url).toBe(`https://site.test/shared-plan.html?s=${body.shareId}`);

    const again = (await (await share(device, id)).json()) as SharePlanResponse;
    expect(again.shareId).toBe(body.shareId);

    const publicRes = await SELF.fetch(url(`/v1/shared/plans/${body.shareId}`));
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get('Cache-Control')).toBe('no-store');
    const shared = (await publicRes.json()) as SharedPlanResponse;
    expect(shared.trailId).toBe('heysen');
    expect(shared.ownerDisplayName).toBe('Sharer');
    expect(shared.document.stops).toHaveLength(2);
  });

  it('surfaces the share id on the sync entry', async () => {
    const device = await registerDevice('Sync share');
    const { id } = await createPlan(device);
    const { shareId } = (await (await share(device, id)).json()) as SharePlanResponse;

    const body = (await (await listPlans(device)).json()) as PlansSyncResponse;
    const entry = body.plans.find((p) => p.id === id) as PlanSyncEntry;
    expect(entry.shareId).toBe(shareId);
    // Row and document agree on the clock after a share.
    expect(entry.document.updatedAt).toBe(entry.updatedAt);
  });

  it('404s after the share is revoked', async () => {
    const device = await registerDevice('Revoker');
    const { id } = await createPlan(device);
    const { shareId } = (await (await share(device, id)).json()) as SharePlanResponse;

    expect((await unshare(device, id)).status).toBe(204);
    expect((await SELF.fetch(url(`/v1/shared/plans/${shareId}`))).status).toBe(404);
    // Idempotent revoke.
    expect((await unshare(device, id)).status).toBe(204);

    // Re-sharing mints a fresh id, so an old link stays dead.
    const next = (await (await share(device, id)).json()) as SharePlanResponse;
    expect(next.shareId).not.toBe(shareId);
  });

  it('404s once the plan itself is deleted', async () => {
    const device = await registerDevice('Deleted share');
    const { id } = await createPlan(device);
    const { shareId } = (await (await share(device, id)).json()) as SharePlanResponse;

    expect((await deletePlan(device, id)).status).toBe(204);
    expect((await SELF.fetch(url(`/v1/shared/plans/${shareId}`))).status).toBe(404);
    expect((await share(device, id)).status).toBe(404);
  });

  it('404s for an unknown share id and refuses another user’s plan', async () => {
    const owner = await registerDevice('Owner share');
    const other = await registerDevice('Other share');
    const { id } = await createPlan(owner);

    expect((await SELF.fetch(url('/v1/shared/plans/nope'))).status).toBe(404);
    expect((await share(other, id)).status).toBe(404);
    expect((await unshare(other, id)).status).toBe(404);
  });
});

describe('DELETE /v1/me — plan cascade', () => {
  it('soft deletes the account’s plans and kills its share links', async () => {
    const device = await registerDevice('Doomed planner');
    const { id } = await createPlan(device);
    const { shareId } = (await (await share(device, id)).json()) as SharePlanResponse;

    expect((await deleteMe(device)).status).toBe(204);

    const row = await planRow(id);
    expect(row?.deleted_at).not.toBeNull();
    expect((await SELF.fetch(url(`/v1/shared/plans/${shareId}`))).status).toBe(404);
    expect((await listPlans(device)).status).toBe(401);
  });
});

describe('plan route methods', () => {
  it('405s on unsupported methods', async () => {
    const device = await registerDevice('Methods');
    const { id } = await createPlan(device);
    expect((await SELF.fetch(url('/v1/plans'), { method: 'POST', headers: authHeaders(device) })).status).toBe(405);
    expect(
      (await SELF.fetch(url(`/v1/plans/${id}`), { method: 'GET', headers: authHeaders(device) }))
        .status
    ).toBe(405);
    expect(
      (
        await SELF.fetch(url(`/v1/plans/${id}/share`), {
          method: 'GET',
          headers: authHeaders(device),
        })
      ).status
    ).toBe(405);
  });
});
