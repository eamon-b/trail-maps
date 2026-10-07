import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, banUser, deleteMe, makeAdmin, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import { GPX_TEXT, base64, makeTrail, submitBody, submitRoute } from './community-fixtures';
import type {
  CommunityAdminListResponse,
  CommunityChecksFailedBody,
  CommunityListResponse,
  CommunityRouteDetail,
} from '../../../src/lib/community-types';
import type { ProcessedTrail } from '../../../src/lib/trail-types';

async function submitOk(device: Device, overrides: Record<string, unknown> = {}): Promise<CommunityRouteDetail> {
  const res = await submitRoute(device, submitBody(overrides));
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return (await res.json()) as CommunityRouteDetail;
}

async function getRoute(id: string, device?: Device): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}`), device ? { headers: authHeaders(device) } : {});
}

async function list(query = ''): Promise<CommunityListResponse> {
  const res = await SELF.fetch(url(`/v1/community/routes${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as CommunityListResponse;
}

async function patch(device: Device, id: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}`), {
    method: 'PATCH',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

async function del(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}`), { method: 'DELETE', headers: authHeaders(device) });
}

async function report(device: Device, id: string, body: unknown = { reason: 'spam' }): Promise<Response> {
  return SELF.fetch(url(`/v1/community/routes/${id}/report`), {
    method: 'POST',
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

function keyOf(trailUrl: string): string {
  return trailUrl.replace(/^https:\/\/photos\.test\//, '');
}

async function storedTrail(trailUrl: string): Promise<ProcessedTrail> {
  const object = await env.PHOTOS.get(keyOf(trailUrl));
  if (!object) throw new Error(`no object for ${trailUrl}`);
  return (await object.json()) as ProcessedTrail;
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`).bind(id).first();
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

describe('POST /v1/community/routes', () => {
  it('publishes a passing route as unverified, with server-written config', async () => {
    const device = await registerDevice('Ridge Walker');
    const route = await submitOk(device, { credit: 'Recorded on my own walk, May 2026.' });

    expect(route.id).toMatch(/^c_[A-Za-z0-9_-]{16}$/);
    expect(route.status).toBe('unverified');
    expect(route.country).toBe('AU');
    expect(route.state).toBe('VIC');
    expect(route.licence).toBe('CC0-1.0');
    expect(route.submittedBy).toBe('Ridge Walker');
    expect(route.lengthKm).toBeGreaterThan(20);
    expect(route.hasElevation).toBe(true);
    expect(route.waypointCount).toBe(3);
    expect(route.isOwner).toBe(true);
    // No ANTHROPIC_API_KEY in tests: the review is recorded as skipped.
    expect(route.review?.status).toBe('skipped');
    expect(route.reviewed).toBe(false);
    expect(route.checks.find((c) => c.id === 'duplicate')?.level).toBe('pass');
    expect(route.trailUrl).toMatch(
      new RegExp(`^https://photos\\.test/community/v1/${route.id}\\.${route.md5.slice(0, 12)}\\.json$`)
    );

    const object = await env.PHOTOS.get(keyOf(route.trailUrl));
    expect(object).not.toBeNull();
    expect(object!.httpMetadata?.contentType).toBe('application/json');
    expect(object!.httpMetadata?.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(object!.size).toBe(route.bytes);

    const stored = await storedTrail(route.trailUrl);
    expect(stored.config.id).toBe(route.id);
    expect(stored.config.name).toBe('Ridge and river loop');
    expect(stored.config.source).toBe('community');
    expect(stored.config.country).toBe('AU');
    expect(stored.config.states).toEqual(['VIC']);
    expect(stored.config.description).toContain('ridge to the lookout');
    expect(stored.config.dataSource?.text).toBe(
      'Shared by Ridge Walker under CC0. Recorded on my own walk, May 2026.'
    );
  });

  it('stores the md5 of the exact bytes', async () => {
    const device = await registerDevice();
    const route = await submitOk(device);
    const object = await env.PHOTOS.get(keyOf(route.trailUrl));
    const bytes = await object!.arrayBuffer();
    const digest = await crypto.subtle.digest('MD5', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(route.md5);
  });

  it('keeps an uploaded GPX privately', async () => {
    const device = await registerDevice();
    const route = await submitOk(device, { gpxBase64: base64(GPX_TEXT) });
    const r = await row(route.id);
    expect(r.gpx_key).toBe(`community/gpx/${route.id}.gpx`);
    const gpx = await env.PHOTOS.get(r.gpx_key as string);
    expect(await gpx!.text()).toBe(GPX_TEXT);
  });

  it('never trusts client stats or extra fields', async () => {
    const device = await registerDevice();
    const trail = makeTrail() as unknown as Record<string, unknown>;
    (trail.config as Record<string, unknown>).lengthKm = 9999;
    (trail.config as Record<string, unknown>).id = 'heysen';
    trail.injected = 'x';
    const route = await submitOk(device, { trail, lengthKm: 1, ascentM: 1 });
    expect(route.lengthKm).toBeLessThan(30);
    const stored = await storedTrail(route.trailUrl);
    expect(stored.config.id).toBe(route.id);
    expect(stored.config.lengthKm).toBeLessThan(30);
    expect('injected' in stored).toBe(false);
  });

  it('requires a user, and refuses a banned one', async () => {
    const anon = await SELF.fetch(url('/v1/community/routes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody()),
    });
    expect(anon.status).toBe(401);

    const device = await registerDevice();
    await banUser(device.userId);
    const res = await submitRoute(device);
    expect(res.status).toBe(403);
  });

  it.each([
    ['rightsConfirmed missing', { rightsConfirmed: undefined }, 'rights_not_confirmed'],
    ['rightsConfirmed truthy but not true', { rightsConfirmed: 'yes' }, 'rights_not_confirmed'],
    ['short name', { name: 'ab' }, 'invalid_name'],
    ['control char in name', { name: 'Ridge\u0007walk' }, 'invalid_name'],
    ['newline in name', { name: 'Ridge\nwalk' }, 'invalid_name'],
    ['short description', { description: 'Too short.' }, 'invalid_description'],
    ['long credit', { credit: 'x'.repeat(301) }, 'invalid_credit'],
    ['bad country', { country: 'Australia' }, 'invalid_country'],
    ['bad state', { state: 'XX' }, 'invalid_state'],
    ['state for a stateless country', { country: 'JP', state: 'VIC' }, 'invalid_state'],
    ['gpx not base64', { gpxBase64: '%%%%' }, 'invalid_gpx'],
    ['gpx not xml', { gpxBase64: base64('hello world, not a gpx') }, 'invalid_gpx'],
    ['xml but not gpx', { gpxBase64: base64('<kml></kml>') }, 'invalid_gpx'],
  ])('400 on %s', async (_label, overrides, code) => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody(overrides as Record<string, unknown>));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(code);
  });

  it('accepts a lower-case country and state, storing them upper case', async () => {
    const device = await registerDevice();
    const route = await submitOk(device, { country: 'nz', state: 'si' });
    expect(route.country).toBe('NZ');
    expect(route.state).toBe('SI');
  });

  it('422s with the checks when a check fails', async () => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody({ trail: makeTrail({ count: 10 }) }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as CommunityChecksFailedBody;
    expect(body.error.code).toBe('checks_failed');
    expect(body.checks.find((c) => c.id === 'points')?.level).toBe('fail');
  });

  it('422s on a malformed trail', async () => {
    const device = await registerDevice();
    const trail = makeTrail();
    trail.track.points[5].lat = 200;
    const res = await submitRoute(device, submitBody({ trail }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as CommunityChecksFailedBody;
    expect(body.checks.find((c) => c.id === 'shape')?.level).toBe('fail');
  });

  it('409s on an identical route, and accepts it again once the first is removed', async () => {
    const device = await registerDevice();
    const trail = makeTrail();
    const first = await submitOk(device, { trail });
    const again = await submitRoute(device, submitBody({ trail, name: 'Same route, new name' }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { existingId: string }).existingId).toBe(first.id);

    expect((await del(device, first.id)).status).toBe(204);
    const third = await submitRoute(device, submitBody({ trail }));
    expect(third.status).toBe(201);
  });

  it('warns about a near-duplicate of a live route', async () => {
    const device = await registerDevice();
    const start = { lat: -30.5, lon: 150.5 };
    await submitOk(device, { trail: makeTrail({ start }) });
    const route = await submitOk(device, { trail: makeTrail({ start, waypointName: 'Different camp' }) });
    expect(route.checks.find((c) => c.id === 'duplicate')?.level).toBe('warn');
  });

  it('413s an oversized body', async () => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody({ gpxBase64: 'A'.repeat(28 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('limits a user to 10 submissions a day', async () => {
    const device = await registerDevice();
    for (let i = 0; i < 10; i++) await submitOk(device);
    const res = await submitRoute(device);
    expect(res.status).toBe(429);
    // A failed check costs nothing.
    const other = await registerDevice();
    for (let i = 0; i < 12; i++) {
      expect((await submitRoute(other, submitBody({ trail: makeTrail({ count: 5 }) }))).status).toBe(422);
    }
    await submitOk(other);
  });
});

describe('GET /v1/community/routes', () => {
  it('lists live routes, filtered, cacheable', async () => {
    const device = await registerDevice();
    const vic = await submitOk(device, { country: 'AU', state: 'VIC' });
    const nz = await submitOk(device, { country: 'NZ', state: 'NI' });

    const res = await SELF.fetch(url('/v1/community/routes'));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const all = (await res.json()) as CommunityListResponse;
    const ids = all.routes.map((r) => r.id);
    expect(ids).toContain(vic.id);
    expect(ids).toContain(nz.id);
    const summary = all.routes.find((r) => r.id === vic.id)!;
    expect('description' in summary).toBe(false);
    expect('review' in summary).toBe(false);

    const nzOnly = await list('?country=nz');
    expect(nzOnly.routes.every((r) => r.country === 'NZ')).toBe(true);
    expect(nzOnly.routes.map((r) => r.id)).toContain(nz.id);

    const vicOnly = await list('?country=AU&state=VIC');
    expect(vicOnly.routes.map((r) => r.id)).toContain(vic.id);
    expect(vicOnly.routes.map((r) => r.id)).not.toContain(nz.id);

    const verified = await list('?status=verified');
    expect(verified.routes.map((r) => r.id)).not.toContain(vic.id);

    expect((await SELF.fetch(url('/v1/community/routes?status=hidden'))).status).toBe(400);
  });
});

describe('GET /v1/community/routes/:id', () => {
  it('shows the public detail without the review', async () => {
    const device = await registerDevice();
    const route = await submitOk(device);
    const res = await getRoute(route.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommunityRouteDetail;
    expect(body.description).toContain('ridge');
    expect(body.review).toBeUndefined();
    expect(body.isOwner).toBeUndefined();
    expect(body.checks.length).toBeGreaterThan(5);

    const stranger = await registerDevice();
    const asStranger = (await (await getRoute(route.id, stranger)).json()) as CommunityRouteDetail;
    expect(asStranger.review).toBeUndefined();

    const asOwner = (await (await getRoute(route.id, device)).json()) as CommunityRouteDetail;
    expect(asOwner.isOwner).toBe(true);
    expect(asOwner.review?.status).toBe('skipped');
    expect(asOwner.reports).toBeUndefined();
  });

  it('404s an unknown or malformed id', async () => {
    expect((await getRoute('c_AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await getRoute('nope')).status).toBe(404);
  });

  it('hides a hidden route from everyone but its owner and admins', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await setStatus(admin, route.id, { status: 'hidden', note: 'checking' })).status).toBe(200);

    expect((await getRoute(route.id)).status).toBe(404);
    expect((await getRoute(route.id, await registerDevice())).status).toBe(404);
    expect((await getRoute(route.id, owner)).status).toBe(200);
    const asAdmin = (await (await getRoute(route.id, admin)).json()) as CommunityRouteDetail;
    expect(asAdmin.statusNote).toBe('checking');
    expect(asAdmin.reportCount).toBe(0);
    expect((await list()).routes.map((r) => r.id)).not.toContain(route.id);
  });
});

describe('PATCH /v1/community/routes/:id', () => {
  it('lets the owner edit, republishing the JSON at a new key', async () => {
    const owner = await registerDevice('Editor');
    const route = await submitOk(owner);
    const res = await patch(owner, route.id, {
      name: 'Renamed loop',
      credit: 'With thanks to the club',
      country: 'AU',
      state: 'NSW',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommunityRouteDetail;
    expect(body.name).toBe('Renamed loop');
    expect(body.state).toBe('NSW');
    expect(body.md5).not.toBe(route.md5);
    expect(body.trailUrl).not.toBe(route.trailUrl);

    const stored = await storedTrail(body.trailUrl);
    expect(stored.config.name).toBe('Renamed loop');
    expect(stored.config.states).toEqual(['NSW']);
    expect(stored.config.dataSource?.text).toBe('Shared by Editor under CC0. With thanks to the club');
    expect(await env.PHOTOS.get(keyOf(route.trailUrl))).toBeNull();
  });

  it('drops a verified route back to unverified', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    const verified = (await (await setStatus(admin, route.id, { status: 'verified' })).json()) as CommunityRouteDetail;
    expect(verified.status).toBe('verified');
    expect(verified.verifiedAt).not.toBeNull();

    const body = (await (await patch(owner, route.id, { description: 'A rewritten description of the whole walk.' })).json()) as CommunityRouteDetail;
    expect(body.status).toBe('unverified');
    expect(body.verifiedAt).toBeNull();
  });

  it('is a no-op when nothing changed', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const body = (await (await patch(owner, route.id, { name: route.name })).json()) as CommunityRouteDetail;
    expect(body.md5).toBe(route.md5);
  });

  it('refuses anyone but the owner, a banned owner, and bad input', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    expect((await patch(await registerDevice(), route.id, { name: 'Mine now' })).status).toBe(404);
    expect((await patch(owner, route.id, { state: 'XX' })).status).toBe(400);
    expect((await patch(owner, route.id, { name: 'x' })).status).toBe(400);
    await banUser(owner.userId);
    expect((await patch(owner, route.id, { name: 'Banned edit' })).status).toBe(403);
  });
});

describe('DELETE /v1/community/routes/:id', () => {
  it('lets the owner remove a route and purges its objects', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner, { gpxBase64: base64(GPX_TEXT) });
    expect((await del(await registerDevice(), route.id)).status).toBe(404);
    expect((await del(owner, route.id)).status).toBe(204);
    expect((await del(owner, route.id)).status).toBe(204);
    expect((await getRoute(route.id, owner)).status).toBe(404);
    expect((await list()).routes.map((r) => r.id)).not.toContain(route.id);
    const r = await row(route.id);
    expect(r.status).toBe('removed');
    expect(r.removed_at).not.toBeNull();
    expect(await env.PHOTOS.get(keyOf(route.trailUrl))).toBeNull();
    expect(await env.PHOTOS.get(`community/gpx/${route.id}.gpx`)).toBeNull();
  });

  it('lets an admin remove any route', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await del(admin, route.id)).status).toBe(204);
  });
});

describe('POST /v1/community/routes/:id/report', () => {
  it('hides an unverified route after three distinct reports', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const a = await registerDevice();
    expect((await report(a, route.id, { reason: 'spam', note: 'advert' })).status).toBe(201);
    expect((await report(a, route.id, { reason: 'spam' })).status).toBe(200);
    expect((await report(await registerDevice(), route.id, { reason: 'unsafe' })).status).toBe(201);
    expect((await row(route.id)).status).toBe('unverified');
    expect((await report(await registerDevice(), route.id, { reason: 'copyright' })).status).toBe(201);
    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.status_note).toBe('Hidden after 3 reports');
    expect((await getRoute(route.id)).status).toBe(404);
  });

  it('leaves a verified route up, for the admin to weigh', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'verified' });
    for (let i = 0; i < 3; i++) await report(await registerDevice(), route.id);
    expect((await row(route.id)).status).toBe('verified');
    const asAdmin = (await (await getRoute(route.id, admin)).json()) as CommunityRouteDetail;
    expect(asAdmin.reportCount).toBe(3);
    expect(asAdmin.reports?.[0].reason).toBe('spam');
  });

  it('refuses bad reasons, own routes, banned users and missing routes', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const reporter = await registerDevice();
    expect((await report(reporter, route.id, { reason: 'boring' })).status).toBe(400);
    expect((await report(owner, route.id)).status).toBe(400);
    expect((await report(reporter, 'c_AAAAAAAAAAAAAAAA')).status).toBe(404);
    await banUser(reporter.userId);
    expect((await report(reporter, route.id)).status).toBe(403);
  });
});

describe('GET /v1/me/community/routes', () => {
  it("lists the caller's routes in any status but removed", async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const a = await submitOk(owner);
    const b = await submitOk(owner);
    const c = await submitOk(owner);
    await setStatus(admin, b.id, { status: 'hidden' });
    await del(owner, c.id);
    const res = await SELF.fetch(url('/v1/me/community/routes'), { headers: authHeaders(owner) });
    const body = (await res.json()) as CommunityAdminListResponse;
    const ids = body.routes.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(c.id);
    expect(body.routes.every((r) => r.isOwner === true && r.review !== undefined)).toBe(true);
    expect((await SELF.fetch(url('/v1/me/community/routes'))).status).toBe(401);
  });
});

describe('admin', () => {
  it('requires an admin', async () => {
    const device = await registerDevice();
    const route = await submitOk(device);
    expect((await SELF.fetch(url('/v1/admin/community/routes'), { headers: authHeaders(device) })).status).toBe(403);
    expect((await setStatus(device, route.id, { status: 'verified' })).status).toBe(403);
    const rerun = await SELF.fetch(url(`/v1/admin/community/routes/${route.id}/review`), {
      method: 'POST',
      headers: authHeaders(device),
    });
    expect(rerun.status).toBe(403);
  });

  it('lists the queue with hidden routes first and reports attached', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const live = await submitOk(owner);
    const hidden = await submitOk(owner);
    await setStatus(admin, hidden.id, { status: 'hidden' });
    await report(await registerDevice(), live.id, { reason: 'inaccurate', note: 'wrong creek' });

    const res = await SELF.fetch(url('/v1/admin/community/routes'), { headers: authHeaders(admin) });
    const body = (await res.json()) as CommunityAdminListResponse;
    const ids = body.routes.map((r) => r.id);
    expect(ids.indexOf(hidden.id)).toBeLessThan(ids.indexOf(live.id));
    const liveDetail = body.routes.find((r) => r.id === live.id)!;
    expect(liveDetail.reportCount).toBe(1);
    expect(liveDetail.reports?.[0]).toMatchObject({ reason: 'inaccurate', note: 'wrong creek' });
    expect(liveDetail.review).toBeDefined();
  });

  it('verifies, unverifies, and validates the status', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect((await setStatus(admin, route.id, { status: 'removed' })).status).toBe(400);
    const v = (await (await setStatus(admin, route.id, { status: 'verified', note: 'walked it' })).json()) as CommunityRouteDetail;
    expect(v.status).toBe('verified');
    expect((await row(route.id)).verified_by).toBe(admin.userId);
    expect((await list('?status=verified')).routes.map((r) => r.id)).toContain(route.id);
    const u = (await (await setStatus(admin, route.id, { status: 'unverified' })).json()) as CommunityRouteDetail;
    expect(u.verifiedAt).toBeNull();
  });

  it('re-runs the review (skipped without a key)', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    const res = await SELF.fetch(url(`/v1/admin/community/routes/${route.id}/review`), {
      method: 'POST',
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommunityRouteDetail;
    expect(body.review?.status).toBe('skipped');
  });
});

describe('account deletion', () => {
  it('keeps CC0 routes up but de-attributes them', async () => {
    const owner = await registerDevice('Soon Gone');
    const route = await submitOk(owner);
    expect((await deleteMe(owner)).status).toBe(204);

    const r = await row(route.id);
    expect(r.submitted_by_name).toBeNull();
    expect(r.status).toBe('unverified');

    // The JSON rewrite runs off the response path; give it a moment.
    let detail: CommunityRouteDetail | null = null;
    for (let i = 0; i < 50; i++) {
      detail = (await (await getRoute(route.id)).json()) as CommunityRouteDetail;
      if (detail.md5 !== route.md5) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(detail!.submittedBy).toBeNull();
    expect(detail!.md5).not.toBe(route.md5);
    const stored = await storedTrail(detail!.trailUrl);
    expect(stored.config.dataSource?.text).toBe('Shared by a Tracknotes user under CC0.');
    expect(JSON.stringify(stored)).not.toContain('Soon Gone');
  });
});
