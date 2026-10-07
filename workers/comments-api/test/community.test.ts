import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, banUser, deleteMe, makeAdmin, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import {
  GPX_TEXT,
  base64,
  envWithHook,
  makeTrail,
  registerAgedDevice,
  submitBody,
  submitRoute,
} from './community-fixtures';
import {
  adminSetCommunityStatus,
  deattributeStatement,
  deattributeStoredRoutes,
  patchCommunityRoute,
  REPORTS_HIDE_NOTE,
  REVIEW_HIDE_NOTE,
  submitCommunityRoute,
} from '../src/community';
import { runCommunityChecks } from '../../../src/lib/community-checks';
import type { CommunityChecksMeta } from '../../../src/lib/community-checks';
import type { Env } from '../src/http';
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

/** Poll until `cond` holds (work scheduled with `ctx.waitUntil` runs after the response). */
async function eventually(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never held');
}

async function publicKeys(id: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix: `community/v1/${id}.` })).objects.map((o) => o.key);
}

async function privateKeys(id: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix: `community/private/${id}/` })).objects.map((o) => o.key);
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`).bind(id).first();
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

/** A request for calling a handler directly (with a hooked env). */
function directRequest(device: Device, path: string, method: string, body: unknown): Request {
  return new Request(url(path), { method, headers: authHeaders(device), body: JSON.stringify(body) });
}

async function rateEvents(bucket: string, key: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ?`)
    .bind(bucket, key)
    .first<{ n: number }>();
  return r?.n ?? 0;
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
    expect(route.trailUrl!).toMatch(
      new RegExp(`^https://photos\\.test/community/v1/${route.id}\\.${route.md5.slice(0, 12)}\\.json$`)
    );

    const object = await env.PHOTOS.get(keyOf(route.trailUrl!));
    expect(object).not.toBeNull();
    expect(object!.httpMetadata?.contentType).toBe('application/json');
    expect(object!.httpMetadata?.cacheControl).toBe('public, max-age=300');
    expect(object!.size).toBe(route.bytes);

    const stored = await storedTrail(route.trailUrl!);
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
    const object = await env.PHOTOS.get(keyOf(route.trailUrl!));
    const bytes = await object!.arrayBuffer();
    const digest = await crypto.subtle.digest('MD5', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(route.md5);
  });

  it('keeps an uploaded GPX, and the canonical JSON, under unguessable keys it never returns', async () => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody({ gpxBase64: base64(GPX_TEXT) }));
    expect(res.status).toBe(201);
    const text = await res.text();
    const route = JSON.parse(text) as CommunityRouteDetail;
    const r = await row(route.id);
    const gpxKey = r.gpx_key as string;
    const privateKey = r.private_key as string;
    expect(gpxKey).toMatch(new RegExp(`^community/private/${route.id}/[0-9a-f]{32}\\.gpx$`));
    expect(privateKey).toMatch(new RegExp(`^community/private/${route.id}/[0-9a-f]{32}\\.json$`));
    expect(gpxKey).not.toContain(route.md5.slice(0, 12));
    const gpx = await env.PHOTOS.get(gpxKey);
    expect(await gpx!.text()).toBe(GPX_TEXT);
    // The private copy is the public one's bytes.
    const priv = await env.PHOTOS.get(privateKey);
    expect(priv!.size).toBe(route.bytes);
    // Nothing that names a private object reaches a client.
    for (const body of [
      text,
      await (await getRoute(route.id, device)).text(),
      await (await SELF.fetch(url('/v1/me/community/routes'), { headers: authHeaders(device) })).text(),
      await (await SELF.fetch(url('/v1/community/routes'))).text(),
    ]) {
      expect(body).not.toContain('community/private');
      expect(body).not.toContain(gpxKey.split('/').pop()!.slice(0, 32));
    }
  });

  it('accepts a GPX with a byte-order mark and a leading comment, sniffing only its head', async () => {
    const device = await registerDevice();
    const withBom = `\uFEFF<!-- exported -->\n${GPX_TEXT}`;
    const bom = (await (await submitRoute(device, submitBody({ gpxBase64: base64(withBom) }))).json()) as CommunityRouteDetail;
    expect((await row(bom.id)).gpx_key).not.toBeNull();
    // `<gpx` past the sniffed head: the route is shared, the file is not kept.
    const late = `<?xml version="1.0"?><!--${' '.repeat(2000)}-->${GPX_TEXT.replace('<?xml version="1.0"?>', '')}`;
    const res = await submitRoute(device, submitBody({ gpxBase64: base64(late) }));
    expect(res.status).toBe(201);
    const route = (await res.json()) as CommunityRouteDetail;
    expect((await row(route.id)).gpx_key).toBeNull();
  });

  it.each([
    ['not xml', 'hello world, not a gpx'],
    ['xml but not gpx', '<kml></kml>'],
  ])('shares the route without a GPX that is %s', async (_label, text) => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody({ gpxBase64: base64(text) }));
    expect(res.status).toBe(201);
    const route = (await res.json()) as CommunityRouteDetail;
    expect((await row(route.id)).gpx_key).toBeNull();
    expect((await privateKeys(route.id)).filter((k) => k.endsWith('.gpx'))).toEqual([]);
  });

  it('hands the decoded GPX to the checks, and nothing when the file was dropped', async () => {
    const seen: CommunityChecksMeta[] = [];
    const runChecks: typeof runCommunityChecks = (trail, meta) => {
      seen.push(meta);
      return runCommunityChecks(trail, meta);
    };
    const device = await registerDevice();
    const withGpx = `<?xml version="1.0"?><gpx version="1.1" creator="Ŧest"><trk><name>Rīdge</name><trkseg><trkpt lat="-37" lon="145"/></trkseg></trk></gpx>`;
    for (const [gpx, expected] of [
      [withGpx, withGpx],
      ['<kml></kml>', undefined],
      [undefined, undefined],
    ] as const) {
      const ctx = createExecutionContext();
      const res = await submitCommunityRoute(
        directRequest(device, '/v1/community/routes', 'POST', submitBody(gpx ? { gpxBase64: base64(gpx) } : {})),
        env as unknown as Env,
        ctx,
        { runChecks }
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(201);
      expect(seen.pop()?.gpxText).toBe(expected);
    }
  });

  it('413s a GPX over 5 MB', async () => {
    const device = await registerDevice();
    const big = `${GPX_TEXT}${' '.repeat(5 * 1024 * 1024)}`;
    const res = await submitRoute(device, submitBody({ gpxBase64: base64(big) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('gpx_too_large');
  });

  it('never trusts client stats or extra fields', async () => {
    const device = await registerDevice();
    const trail = makeTrail() as unknown as Record<string, unknown>;
    (trail.config as Record<string, unknown>).lengthKm = 9999;
    (trail.config as Record<string, unknown>).id = 'heysen';
    trail.injected = 'x';
    const route = await submitOk(device, { trail, lengthKm: 1, ascentM: 1 });
    expect(route.lengthKm).toBeLessThan(30);
    const stored = await storedTrail(route.trailUrl!);
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

  it("409s on someone else's identical route without naming it", async () => {
    const trail = makeTrail();
    await submitOk(await registerDevice(), { trail });
    const res = await submitRoute(await registerDevice(), submitBody({ trail }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect('existingId' in body).toBe(false);
  });

  it('409s on an identical route, and accepts it again once the first is removed', async () => {
    const device = await registerDevice();
    const trail = makeTrail();
    const first = await submitOk(device, { trail });
    const again = await submitRoute(device, submitBody({ trail, name: 'Same route, new name' }));
    expect(again.status).toBe(409);
    const dup = (await again.json()) as { existingId: string; error: { message: string } };
    expect(dup.existingId).toBe(first.id);
    // Neutral: the first copy may be hidden.
    expect(dup.error.message).not.toMatch(/list/i);

    expect((await del(device, first.id)).status).toBe(204);
    const third = await submitRoute(device, submitBody({ trail }));
    expect(third.status).toBe(201);
  });

  it('warns about a near-duplicate of a live route', async () => {
    const device = await registerDevice();
    const start = { lat: -30.5, lon: 150.5 };
    const first = await submitOk(device, { trail: makeTrail({ start }), name: 'Buy cheap boots at example' });
    const route = await submitOk(device, { trail: makeTrail({ start, waypointName: 'Different camp' }) });
    const check = route.checks.find((c) => c.id === 'duplicate');
    expect(check?.level).toBe('warn');
    // The other route's id, never its (someone else's) name.
    expect(check?.message).toContain(first.id);
    expect(check?.message).not.toContain('boots');
  });

  it('413s an oversized body', async () => {
    const device = await registerDevice();
    const res = await submitRoute(device, submitBody({ gpxBase64: 'A'.repeat(28 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('413s a trail over its own cap without a GPX, before the checks and without spending a publish', async () => {
    const device = await registerDevice();
    const trail = makeTrail() as unknown as Record<string, unknown>;
    // Under the whole-body cap (which allows for a 5 MB GPX), over the trail's.
    trail.padding = 'x'.repeat(4 * 1024 * 1024 + 100 * 1024);
    const res = await submitRoute(device, submitBody({ trail }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('trail_too_large');
    expect(await rateEvents('community_submit', device.userId)).toBe(0);
    expect(await rateEvents('community_submit_attempt', device.userId)).toBe(1);
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

  it('limits every submit attempt, failed or not, to 30 a day', async () => {
    const device = await registerDevice();
    for (let i = 0; i < 30; i++) {
      const res = await submitRoute(device, i % 2 === 0 ? submitBody({ trail: makeTrail({ count: 5 }) }) : 'not json');
      expect(res.status === 422 || res.status === 400).toBe(true);
    }
    const res = await submitRoute(device);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/attempts/);
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

  it('never lets a shared cache keep a response to a request with a token', async () => {
    const device = await registerDevice();
    const route = await submitOk(device);
    const anon = await getRoute(route.id);
    expect(anon.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(anon.headers.get('Vary')).toBe('Authorization');
    const stranger = await getRoute(route.id, await registerDevice());
    expect(stranger.headers.get('Cache-Control')).toBe('private, no-store');
    const bogus = await SELF.fetch(url(`/v1/community/routes/${route.id}`), {
      headers: { Authorization: 'Bearer not-a-token' },
    });
    if (bogus.status === 200) expect(bogus.headers.get('Cache-Control')).toBe('private, no-store');
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
    const ownerRes = await getRoute(route.id, owner);
    expect(ownerRes.status).toBe(200);
    const asOwner = (await ownerRes.json()) as CommunityRouteDetail;
    expect(asOwner.hiddenReason).toBe('admin');
    expect(asOwner).not.toHaveProperty('statusNote');
    const asAdmin = (await (await getRoute(route.id, admin)).json()) as CommunityRouteDetail;
    expect(asAdmin.statusNote).toBe('checking');
    expect(asAdmin.hiddenReason).toBe('admin');
    expect(asAdmin.reportCount).toBe(0);
    expect((await list()).routes.map((r) => r.id)).not.toContain(route.id);
  });

  it('takes a hidden route off the public domain and republishes it from the private copy on restore', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    expect(await publicKeys(route.id)).toEqual([keyOf(route.trailUrl!)]);

    await setStatus(admin, route.id, { status: 'hidden' });
    expect(await publicKeys(route.id)).toEqual([]);
    expect((await row(route.id)).r2_key).toBeNull();
    const asOwner = (await (await getRoute(route.id, owner)).json()) as CommunityRouteDetail;
    expect(asOwner.trailUrl).toBeNull();
    expect(asOwner.name).toBe(route.name);
    expect(await privateKeys(route.id)).toHaveLength(1);

    // An owner edit while hidden re-stores the private copy only.
    const edited = (await (await patch(owner, route.id, { name: 'Hidden but renamed' })).json()) as CommunityRouteDetail;
    expect(edited.trailUrl).toBeNull();
    expect(await publicKeys(route.id)).toEqual([]);

    const restored = (await (await setStatus(admin, route.id, { status: 'unverified' })).json()) as CommunityRouteDetail;
    expect(restored.trailUrl).not.toBeNull();
    expect(await publicKeys(route.id)).toEqual([keyOf(restored.trailUrl!)]);
    const stored = await storedTrail(restored.trailUrl!);
    expect(stored.config.name).toBe('Hidden but renamed');
    const object = await env.PHOTOS.get(keyOf(restored.trailUrl!));
    expect(object!.size).toBe(restored.bytes);
    expect((await list()).routes.find((r) => r.id === route.id)?.trailUrl).toBe(restored.trailUrl);
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

    const stored = await storedTrail(body.trailUrl!);
    expect(stored.config.name).toBe('Renamed loop');
    expect(stored.config.states).toEqual(['NSW']);
    expect(stored.config.dataSource?.text).toBe('Shared by Editor under CC0. With thanks to the club');
    // The old object stays: lists cached at the edge and on phones still name it.
    expect(await env.PHOTOS.get(keyOf(route.trailUrl!))).not.toBeNull();
    expect((await publicKeys(route.id)).sort()).toEqual([keyOf(route.trailUrl!), keyOf(body.trailUrl!)].sort());
    // The superseded private copy goes; the new one is in the row.
    const privateKey = (await row(route.id)).private_key as string;
    await eventually(async () => (await privateKeys(route.id)).length === 1);
    expect(await privateKeys(route.id)).toEqual([privateKey]);
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

  it('limits a user to 20 edits a day, charging only edits that change something', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 20 }, () =>
        env.DB.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES ('community_edit', ?, ?)`).bind(
          owner.userId,
          now
        )
      )
    );
    const res = await patch(owner, route.id, { name: 'One edit too many' });
    expect(res.status).toBe(429);
    expect((await row(route.id)).name).toBe(route.name);
    // A PATCH that changes nothing is free.
    expect((await patch(owner, route.id, { name: route.name })).status).toBe(200);
    expect(await rateEvents('community_edit', owner.userId)).toBe(20);
  });

  it('spends one edit per changing PATCH', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    expect((await patch(owner, route.id, { name: 'First rename' })).status).toBe(200);
    expect((await patch(owner, route.id, { name: 'First rename' })).status).toBe(200);
    expect(await rateEvents('community_edit', owner.userId)).toBe(1);
  });

  it('409s, and keeps the hide, when an admin hides the route during the edit', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    const privateBefore = (await row(route.id)).private_key as string;
    // The admin's hide lands while the edit is writing its new objects.
    const hooked = envWithHook('put', async () => {
      expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    });
    const ctx = createExecutionContext();
    await expect(
      patchCommunityRoute(
        directRequest(owner, `/v1/community/routes/${route.id}`, 'PATCH', { name: 'Edited during the hide' }),
        hooked,
        ctx,
        route.id
      )
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await waitOnExecutionContext(ctx);

    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.name).toBe(route.name);
    expect(r.r2_key).toBeNull();
    // What the losing edit wrote is gone: no public copy, one private one.
    expect(await publicKeys(route.id)).toEqual([]);
    expect(await privateKeys(route.id)).toEqual([privateBefore]);
  });

  it('never resurrects a route deleted during the edit', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    const hooked = envWithHook('put', async () => {
      expect((await del(owner, route.id)).status).toBe(204);
    });
    const ctx = createExecutionContext();
    await expect(
      patchCommunityRoute(
        directRequest(owner, `/v1/community/routes/${route.id}`, 'PATCH', { name: 'Edited after delete' }),
        hooked,
        ctx,
        route.id
      )
    ).rejects.toMatchObject({ status: 409 });
    await waitOnExecutionContext(ctx);
    expect((await row(route.id)).status).toBe('removed');
    await eventually(async () => (await publicKeys(route.id)).length === 0 && (await privateKeys(route.id)).length === 0);
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
  it('lets the owner remove a route and purges its objects, old versions included', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner, { gpxBase64: base64(GPX_TEXT) });
    await patch(owner, route.id, { name: 'Second version' });
    expect(await publicKeys(route.id)).toHaveLength(2);
    expect((await del(await registerDevice(), route.id)).status).toBe(404);
    expect((await del(owner, route.id)).status).toBe(204);
    expect((await del(owner, route.id)).status).toBe(204);
    expect((await getRoute(route.id, owner)).status).toBe(404);
    expect((await list()).routes.map((r) => r.id)).not.toContain(route.id);
    const r = await row(route.id);
    expect(r.status).toBe('removed');
    expect(r.removed_at).not.toBeNull();
    await eventually(async () => (await publicKeys(route.id)).length === 0 && (await privateKeys(route.id)).length === 0);
    expect(await env.PHOTOS.get(keyOf(route.trailUrl!))).toBeNull();
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
    const a = await registerAgedDevice();
    expect((await report(a, route.id, { reason: 'spam', note: 'advert' })).status).toBe(201);
    expect((await report(a, route.id, { reason: 'spam' })).status).toBe(200);
    expect((await report(await registerAgedDevice(), route.id, { reason: 'unsafe' })).status).toBe(201);
    expect((await row(route.id)).status).toBe('unverified');
    expect((await report(await registerAgedDevice(), route.id, { reason: 'copyright' })).status).toBe(201);
    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.status_note).toBe('Hidden after 3 reports');
    expect(REPORTS_HIDE_NOTE).toBe('Hidden after 3 reports');
    const asOwner = (await (await getRoute(route.id, owner)).json()) as CommunityRouteDetail;
    expect(asOwner.hiddenReason).toBe('reports');
    expect(asOwner).not.toHaveProperty('statusNote');
    expect((await getRoute(route.id)).status).toBe(404);
    expect(await publicKeys(route.id)).toEqual([]);
  });

  it('counts only reports from accounts that were a day old when they filed', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    // Three brand-new accounts: stored, shown to admins, but no hide.
    for (let i = 0; i < 3; i++) {
      expect((await report(await registerDevice(), route.id)).status).toBe(201);
    }
    expect((await row(route.id)).status).toBe('unverified');
    const asAdmin = (await (await getRoute(route.id, admin)).json()) as CommunityRouteDetail;
    expect(asAdmin.reportCount).toBe(3);

    // An account just under a day old does not count either.
    const almost = await registerDevice();
    await env.DB.prepare(`UPDATE users SET created_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(), almost.userId)
      .run();
    await report(almost, route.id);
    await report(await registerAgedDevice(), route.id);
    await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status).toBe('unverified');
    // The third old enough account tips it.
    await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status).toBe('hidden');
  });

  it('counts only reports filed since an admin last restored the route', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    for (let i = 0; i < 3; i++) await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status).toBe('hidden');

    // Restored: the three reports the admin weighed no longer count.
    await setStatus(admin, route.id, { status: 'unverified' });
    // Reports must be strictly after the status change.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await report(await registerAgedDevice(), route.id)).status).toBe(201);
    expect((await row(route.id)).status).toBe('unverified');
    expect((await list()).routes.map((x) => x.id)).toContain(route.id);

    await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status).toBe('unverified');
    await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status).toBe('hidden');
    expect(await publicKeys(route.id)).toEqual([]);
  });

  it('leaves a verified route up, for the admin to weigh', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'verified' });
    for (let i = 0; i < 3; i++) await report(await registerAgedDevice(), route.id);
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
    expect(body.routes.find((r) => r.id === b.id)?.hiddenReason).toBe('admin');
    expect(body.routes.find((r) => r.id === a.id)).not.toHaveProperty('hiddenReason');
    expect(body.routes.every((r) => !('statusNote' in r))).toBe(true);
    expect((await SELF.fetch(url('/v1/me/community/routes'))).status).toBe(401);
  });

  it('carries why each hidden route was hidden', async () => {
    const owner = await registerDevice();
    const reported = await submitOk(owner);
    for (let i = 0; i < 3; i++) {
      expect((await report(await registerAgedDevice(), reported.id)).status).toBe(201);
    }
    const res = await SELF.fetch(url('/v1/me/community/routes'), { headers: authHeaders(owner) });
    const body = (await res.json()) as CommunityAdminListResponse;
    expect(body.routes.find((r) => r.id === reported.id)?.hiddenReason).toBe('reports');
  });
});

describe('hiddenReason', () => {
  it('is never on a live route, nor on the public or a stranger\'s view', async () => {
    const owner = await registerDevice();
    const route = await submitOk(owner);
    expect(route).not.toHaveProperty('hiddenReason');
    const asOwner = (await (await getRoute(route.id, owner)).json()) as CommunityRouteDetail;
    expect(asOwner).not.toHaveProperty('hiddenReason');
    const asPublic = (await (await getRoute(route.id)).json()) as CommunityRouteDetail;
    expect(asPublic).not.toHaveProperty('hiddenReason');
    const asStranger = (await (await getRoute(route.id, await registerDevice())).json()) as CommunityRouteDetail;
    expect(asStranger).not.toHaveProperty('hiddenReason');
    expect((await list()).routes.every((r) => !('hiddenReason' in r))).toBe(true);
  });

  it('is gone after a restore, and the restore overwrites the hide note', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    for (let i = 0; i < 3; i++) await report(await registerAgedDevice(), route.id);
    expect((await row(route.id)).status_note).toBe(REPORTS_HIDE_NOTE);
    expect((await setStatus(admin, route.id, { status: 'unverified' })).status).toBe(200);
    expect((await row(route.id)).status_note).toBeNull();
    const asOwner = (await (await getRoute(route.id, owner)).json()) as CommunityRouteDetail;
    expect(asOwner.status).toBe('unverified');
    expect(asOwner).not.toHaveProperty('hiddenReason');
  });

  it('refuses an admin note that would pass for an automatic hide', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    for (const note of [REVIEW_HIDE_NOTE, REPORTS_HIDE_NOTE]) {
      const res = await setStatus(admin, route.id, { status: 'hidden', note });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_note');
    }
    expect((await row(route.id)).status).toBe('unverified');
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

  it('restores from hidden by always republishing, even when the row still names a key', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'hidden' });
    // A row read before the hide's purge finished: hidden, but still naming
    // the key the purge deleted.
    await env.DB.prepare(`UPDATE community_routes SET r2_key = ? WHERE id = ?`)
      .bind(keyOf(route.trailUrl!), route.id)
      .run();
    const restored = (await (await setStatus(admin, route.id, { status: 'unverified' })).json()) as CommunityRouteDetail;
    expect(restored.trailUrl).not.toBeNull();
    expect(await env.PHOTOS.head(keyOf(restored.trailUrl!))).not.toBeNull();
  });

  it('500s a restore whose private copy is gone, leaving the route hidden', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'hidden' });
    await env.PHOTOS.delete((await row(route.id)).private_key as string);
    const res = await setStatus(admin, route.id, { status: 'unverified' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('trail_missing');
    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.r2_key).toBeNull();
  });

  it('puts a route back up when a restore lands while its hide is purging', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    // The hide's purge lists the public copy; before it deletes it, another
    // admin restores the route (re-putting that same content-addressed key).
    const hooked = envWithHook('delete', async () => {
      expect((await setStatus(admin, route.id, { status: 'unverified' })).status).toBe(200);
    });
    const ctx = createExecutionContext();
    const res = await adminSetCommunityStatus(
      directRequest(admin, `/v1/admin/community/routes/${route.id}/status`, 'POST', { status: 'hidden' }),
      hooked,
      ctx,
      route.id
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const r = await row(route.id);
    expect(r.status).toBe('unverified');
    expect(r.r2_key).not.toBeNull();
    expect(await env.PHOTOS.head(r.r2_key as string)).not.toBeNull();
  });

  it('409s a status change on a route deleted meanwhile, without republishing it', async () => {
    const owner = await registerDevice();
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await setStatus(admin, route.id, { status: 'hidden' });
    // The restore's publish lands; the owner deletes before its row update.
    const hooked = envWithHook('put', async () => {
      expect((await del(owner, route.id)).status).toBe(204);
    });
    const ctx = createExecutionContext();
    await expect(
      adminSetCommunityStatus(
        directRequest(admin, `/v1/admin/community/routes/${route.id}/status`, 'POST', { status: 'unverified' }),
        hooked,
        ctx,
        route.id
      )
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await waitOnExecutionContext(ctx);
    expect((await row(route.id)).status).toBe('removed');
    await eventually(async () => (await publicKeys(route.id)).length === 0);
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
    const stored = await storedTrail(detail!.trailUrl!);
    expect(stored.config.dataSource?.text).toBe('Shared by a Tracknotes user under CC0.');
    expect(JSON.stringify(stored)).not.toContain('Soon Gone');

    // The old public version named the account, so it is purged too.
    const oldKey = keyOf(route.trailUrl!);
    let old: R2Object | null = null;
    for (let i = 0; i < 50; i++) {
      old = await env.PHOTOS.head(oldKey);
      if (!old) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(old).toBeNull();
  });

  it('rewrites a route an admin hid mid-way from its new state, leaving it hidden', async () => {
    const owner = await registerDevice('Hidden Walker');
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const route = await submitOk(owner);
    await deattributeStatement(env as unknown as Env, owner.userId).run();
    const hooked = envWithHook('put', async () => {
      expect((await setStatus(admin, route.id, { status: 'hidden' })).status).toBe(200);
    });
    await deattributeStoredRoutes(hooked, owner.userId);

    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.r2_key).toBeNull();
    expect(await publicKeys(route.id)).toEqual([]);
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
    const stored = (await (await env.PHOTOS.get(r.private_key as string))!.json()) as ProcessedTrail;
    expect(JSON.stringify(stored)).not.toContain('Hidden Walker');
  });
});

