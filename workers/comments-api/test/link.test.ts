import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  createLinkCode,
  createPlan,
  deleteMe,
  linkCode,
  linkDevice,
  listPlans,
  planBody,
  putPlan,
  registerDevice,
  url,
} from './helpers';
import type { Device } from './helpers';
import type {
  DevicesResponse,
  LinkDeviceResponse,
  MeResponse,
  PlansSyncResponse,
} from '../../../src/lib/comments-api-types';

function asDevice(body: LinkDeviceResponse): Device {
  return { userId: body.userId, token: body.token, displayName: body.displayName };
}

async function link(device: Device, label = 'Chrome on macOS', ip?: string): Promise<Device> {
  const { code } = await linkCode(device);
  const res = await linkDevice({ code, label }, ip);
  expect(res.status).toBe(201);
  return asDevice((await res.json()) as LinkDeviceResponse);
}

async function tokenRow(userId: string, kind: 'primary' | 'linked') {
  return env.DB.prepare(
    `SELECT token_hash, kind, label, expires_at, revoked_at, last_seen_at
       FROM device_tokens WHERE user_id = ? AND kind = ?`
  )
    .bind(userId, kind)
    .first<{
      token_hash: string;
      kind: string;
      label: string | null;
      expires_at: string | null;
      revoked_at: string | null;
      last_seen_at: string | null;
    }>();
}

describe('migrated primary tokens', () => {
  it('registers a device_tokens row and still authenticates', async () => {
    const device = await registerDevice('Phone');
    const row = await tokenRow(device.userId, 'primary');
    expect(row?.kind).toBe('primary');
    expect(row?.expires_at).toBeNull();
    expect(row?.revoked_at).toBeNull();

    const me = await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) });
    expect(me.status).toBe(200);
  });

  it('authenticates a pre-0004 account once the backfill has run', async () => {
    // A row shaped like an account created before device_tokens existed: users
    // only, no token row. The same INSERT…SELECT the migration runs gives it one.
    const token = 'legacy-token-for-the-backfill-test';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, token_hash, is_admin, is_banned, created_at, last_seen_at)
       VALUES (?, 'Legacy', ?, 0, 0, ?, ?)`
    )
      .bind(userId, tokenHash, now, now)
      .run();

    // Unmigrated: the token authenticates nothing.
    expect(
      (await SELF.fetch(url('/v1/me'), { headers: { Authorization: `Bearer ${token}` } })).status
    ).toBe(401);

    await env.DB.prepare(
      `INSERT INTO device_tokens (token_hash, user_id, kind, label, created_at, last_seen_at, expires_at, revoked_at)
       SELECT token_hash, id, 'primary', NULL, created_at, last_seen_at, NULL, NULL FROM users WHERE id = ?`
    )
      .bind(userId)
      .run();

    const me = await SELF.fetch(url('/v1/me'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as MeResponse).userId).toBe(userId);
  });

  it('rejects a token whose row has been revoked', async () => {
    const device = await registerDevice('Revoked phone');
    await env.DB.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE user_id = ?`)
      .bind(new Date().toISOString(), device.userId)
      .run();
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) })).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const device = await registerDevice('Expired');
    await env.DB.prepare(`UPDATE device_tokens SET expires_at = ? WHERE user_id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), device.userId)
      .run();
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) })).status).toBe(401);
  });
});

describe('POST /v1/link-codes', () => {
  it('mints an 8-char code from the unambiguous alphabet with a 10-minute TTL', async () => {
    const device = await registerDevice('Coder');
    const res = await createLinkCode(device);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('401s without a token', async () => {
    expect((await SELF.fetch(url('/v1/link-codes'), { method: 'POST' })).status).toBe(401);
  });

  it('429s once five codes are live, and allows more after they expire', async () => {
    const device = await registerDevice('Code spammer');
    for (let i = 0; i < 5; i++) {
      expect((await createLinkCode(device)).status).toBe(201);
    }
    const blocked = await createLinkCode(device);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'too_many_codes'
    );

    await env.DB.prepare(`UPDATE link_codes SET expires_at = ? WHERE user_id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), device.userId)
      .run();
    expect((await createLinkCode(device)).status).toBe(201);
  });
});

describe('POST /v1/devices/link', () => {
  it('exchanges a code for a linked token on the same account', async () => {
    const phone = await registerDevice('Shared Identity');
    const { code } = await linkCode(phone);

    const res = await linkDevice({ code: code.toLowerCase(), label: '  Chrome on macOS  ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as LinkDeviceResponse;
    expect(body.userId).toBe(phone.userId);
    expect(body.displayName).toBe('Shared Identity');
    expect(body.token).not.toBe(phone.token);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(179 * 24 * 60 * 60 * 1000);

    const browser = asDevice(body);
    const me = (await (
      await SELF.fetch(url('/v1/me'), { headers: authHeaders(browser) })
    ).json()) as MeResponse;
    expect(me.userId).toBe(phone.userId);

    const row = await tokenRow(phone.userId, 'linked');
    expect(row?.label).toBe('Chrome on macOS');
    expect(row?.expires_at).not.toBeNull();
  });

  it('is single use: the second exchange 404s', async () => {
    const phone = await registerDevice('Once');
    const { code } = await linkCode(phone);
    expect((await linkDevice({ code })).status).toBe(201);

    const again = await linkDevice({ code });
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('code_invalid');
  });

  it('404s for an unknown or expired code', async () => {
    const phone = await registerDevice('Expiring');
    expect((await linkDevice({ code: 'ZZZZZZZZ' })).status).toBe(404);

    const { code } = await linkCode(phone);
    await env.DB.prepare(`UPDATE link_codes SET expires_at = ? WHERE code = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), code)
      .run();
    const res = await linkDevice({ code });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('code_invalid');
  });

  it('400s when the code is missing', async () => {
    const res = await linkDevice({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_code');
  });

  it('refuses codes belonging to a deleted account', async () => {
    const phone = await registerDevice('Departing');
    const { code } = await linkCode(phone);
    expect((await deleteMe(phone)).status).toBe(204);

    const res = await linkDevice({ code });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('code_invalid');
  });

  it('caps attempts at 10 per IP per hour, counting failures', async () => {
    const ip = '198.51.100.42';
    for (let i = 0; i < 10; i++) {
      expect((await linkDevice({ code: 'ZZZZZZZZ' }, ip)).status).toBe(404);
    }

    const phone = await registerDevice('Rate limited');
    const { code } = await linkCode(phone);
    const blocked = await linkDevice({ code }, ip);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    // A different IP is unaffected, and the code is still unused.
    expect((await linkDevice({ code }, '198.51.100.43')).status).toBe(201);
  });
});

describe('linked token behaviour', () => {
  it('reads and writes the same account’s plans', async () => {
    const phone = await registerDevice('Two devices');
    const browser = await link(phone);

    const { id } = await createPlan(phone);
    const list = (await (await listPlans(browser)).json()) as PlansSyncResponse;
    expect(list.plans.map((p) => p.id)).toEqual([id]);

    const res = await putPlan(browser, id, planBody(id, { name: 'Edited in the browser' }));
    expect(res.status).toBe(200);

    const back = (await (await listPlans(phone)).json()) as PlansSyncResponse;
    const entry = back.plans[0];
    expect('document' in entry && entry.document.name).toBe('Edited in the browser');
  });

  it('rolls its expiry forward on each authenticated request', async () => {
    const phone = await registerDevice('Rolling');
    const browser = await link(phone);
    const before = await tokenRow(phone.userId, 'linked');

    // Wind the stored expiry back, then use the token: the touch rewrites it.
    await env.DB.prepare(`UPDATE device_tokens SET expires_at = ? WHERE token_hash = ?`)
      .bind(new Date(Date.now() + 60 * 1000).toISOString(), before!.token_hash)
      .run();
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(browser) })).status).toBe(200);

    // The touch runs in ctx.waitUntil — poll briefly for it to land.
    let rolled = false;
    for (let i = 0; i < 20 && !rolled; i++) {
      const row = await tokenRow(phone.userId, 'linked');
      rolled = Date.parse(row!.expires_at!) - Date.now() > 179 * 24 * 60 * 60 * 1000;
      if (!rolled) await new Promise((r) => setTimeout(r, 25));
    }
    expect(rolled).toBe(true);
  });
});

describe('GET /v1/me/devices', () => {
  it('lists the primary and linked tokens with opaque ids only', async () => {
    const phone = await registerDevice('Device list');
    await link(phone, 'Firefox on Linux');

    const res = await SELF.fetch(url('/v1/me/devices'), { headers: authHeaders(phone) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DevicesResponse;
    expect(body.devices).toHaveLength(2);

    const primary = body.devices.find((d) => d.kind === 'primary')!;
    const linked = body.devices.find((d) => d.kind === 'linked')!;
    expect(primary.current).toBe(true);
    expect(primary.expiresAt).toBeNull();
    expect(linked.current).toBe(false);
    expect(linked.label).toBe('Firefox on Linux');
    expect(linked.expiresAt).not.toBeNull();

    for (const device of body.devices) {
      expect(device.id).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(device)).not.toContain(phone.token);
    }

    const row = await tokenRow(phone.userId, 'linked');
    expect(row!.token_hash.startsWith(linked.id)).toBe(true);
    expect(row!.token_hash).not.toBe(linked.id);
  });

  it('401s without a token', async () => {
    expect((await SELF.fetch(url('/v1/me/devices'))).status).toBe(401);
  });
});

describe('DELETE /v1/me/devices/:id', () => {
  it('revokes a linked token, which then authenticates nothing', async () => {
    const phone = await registerDevice('Revoking');
    const browser = await link(phone);

    const before = (await (
      await SELF.fetch(url('/v1/me/devices'), { headers: authHeaders(phone) })
    ).json()) as DevicesResponse;
    const linked = before.devices.find((d) => d.kind === 'linked')!;

    const res = await SELF.fetch(url(`/v1/me/devices/${linked.id}`), {
      method: 'DELETE',
      headers: authHeaders(phone),
    });
    expect(res.status).toBe(204);

    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(browser) })).status).toBe(401);
    expect((await listPlans(browser)).status).toBe(401);

    const after = (await (
      await SELF.fetch(url('/v1/me/devices'), { headers: authHeaders(phone) })
    ).json()) as DevicesResponse;
    expect(after.devices.map((d) => d.kind)).toEqual(['primary']);

    // Revoking the same id again is a 404 — the row is gone from the list.
    expect(
      (
        await SELF.fetch(url(`/v1/me/devices/${linked.id}`), {
          method: 'DELETE',
          headers: authHeaders(phone),
        })
      ).status
    ).toBe(404);
  });

  it('refuses to revoke the primary token', async () => {
    const phone = await registerDevice('Primary');
    const body = (await (
      await SELF.fetch(url('/v1/me/devices'), { headers: authHeaders(phone) })
    ).json()) as DevicesResponse;
    const primary = body.devices.find((d) => d.kind === 'primary')!;

    const res = await SELF.fetch(url(`/v1/me/devices/${primary.id}`), {
      method: 'DELETE',
      headers: authHeaders(phone),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('primary_token');
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(phone) })).status).toBe(200);
  });

  it('404s for another account’s device id and for a short id', async () => {
    const phone = await registerDevice('Mine only');
    const stranger = await registerDevice('Stranger');
    const browser = await link(phone);

    const body = (await (
      await SELF.fetch(url('/v1/me/devices'), { headers: authHeaders(phone) })
    ).json()) as DevicesResponse;
    const linked = body.devices.find((d) => d.kind === 'linked')!;

    expect(
      (
        await SELF.fetch(url(`/v1/me/devices/${linked.id}`), {
          method: 'DELETE',
          headers: authHeaders(stranger),
        })
      ).status
    ).toBe(404);
    expect(
      (
        await SELF.fetch(url(`/v1/me/devices/${linked.id.slice(0, 4)}`), {
          method: 'DELETE',
          headers: authHeaders(phone),
        })
      ).status
    ).toBe(404);

    // Still working.
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(browser) })).status).toBe(200);
  });
});

describe('DELETE /v1/me — token cascade', () => {
  it('revokes every token, including linked browsers', async () => {
    const phone = await registerDevice('All gone');
    const browser = await link(phone);

    expect((await deleteMe(phone)).status).toBe(204);

    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(browser) })).status).toBe(401);
    expect((await SELF.fetch(url('/v1/me'), { headers: authHeaders(phone) })).status).toBe(401);

    const { results } = await env.DB.prepare(
      `SELECT revoked_at FROM device_tokens WHERE user_id = ?`
    )
      .bind(phone.userId)
      .all<{ revoked_at: string | null }>();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.revoked_at !== null)).toBe(true);
  });
});
