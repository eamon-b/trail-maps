import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, banUser, registerDevice, url } from './helpers';
import { getUser } from '../src/auth';
import type { Env } from '../src/http';
import { RATE_BUCKETS, ipRateKey } from '../src/rate-limit';
import type { MeResponse } from '../../../src/lib/comments-api-types';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** POST /v1/devices from a given address. */
function register(ip: string, displayName = 'Walker'): Promise<Response> {
  return SELF.fetch(url('/v1/devices'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ displayName }),
  });
}

describe('device registration + me', () => {
  it('GET /health returns ok', async () => {
    const res = await SELF.fetch(url('/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('registers a device and returns a one-time token', async () => {
    const res = await SELF.fetch(url('/v1/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '  Ridge Runner  ' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: string; token: string; displayName: string };
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.displayName).toBe('Ridge Runner'); // trimmed
  });

  it('rejects an empty display name', async () => {
    const res = await SELF.fetch(url('/v1/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '   ' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_display_name');
  });

  it('rejects a display name over 40 chars', async () => {
    const res = await SELF.fetch(url('/v1/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x'.repeat(41) }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /v1/me returns identity for a valid token', async () => {
    const device = await registerDevice('Cartographer');
    const res = await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;
    expect(body).toEqual({
      userId: device.userId,
      displayName: 'Cartographer',
      isAdmin: false,
    });
  });

  it('GET /v1/me is 401 without a token', async () => {
    const res = await SELF.fetch(url('/v1/me'));
    expect(res.status).toBe(401);
  });

  it('GET /v1/me is 401 with a bogus token', async () => {
    const res = await SELF.fetch(url('/v1/me'), {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /v1/me updates the display name', async () => {
    const device = await registerDevice('Old Name');
    const res = await SELF.fetch(url('/v1/me'), {
      method: 'PATCH',
      headers: authHeaders(device),
      body: JSON.stringify({ displayName: 'New Name' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;
    expect(body.displayName).toBe('New Name');

    const check = await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) });
    expect(((await check.json()) as MeResponse).displayName).toBe('New Name');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await SELF.fetch(url('/v1/nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('POST /v1/devices rate limit', () => {
  it(`caps registrations at ${RATE_BUCKETS.deviceRegister.limit} per IP per hour`, async () => {
    const ip = '198.51.100.77';
    const { limit } = RATE_BUCKETS.deviceRegister;
    for (let i = 0; i < limit; i++) {
      expect((await register(ip)).status).toBe(201);
    }
    const blocked = await register(ip);
    expect(blocked.status).toBe(429);
    expect(errorCode(await blocked.json())).toBe('rate_limited');

    // Another address is unaffected.
    expect((await register('198.51.100.78')).status).toBe(201);

    // Outside the window the allowance comes back.
    await env.DB.prepare(`UPDATE rate_events SET created_at = ? WHERE bucket = ? AND key = ?`)
      .bind(new Date(Date.now() - 61 * 60 * 1000).toISOString(), 'device_register', ip)
      .run();
    expect((await register(ip)).status).toBe(201);
  });

  it('counts a whole IPv6 /64 as one address', async () => {
    const { limit } = RATE_BUCKETS.deviceRegister;
    // Rotating the interface id — what one host on a /64 can do freely —
    // must not buy a fresh allowance.
    for (let i = 0; i < limit; i++) {
      expect((await register(`2001:db8:77:1::${(i + 1).toString(16)}`)).status).toBe(201);
    }
    expect((await register('2001:db8:77:1:ffff:ffff:ffff:ffff')).status).toBe(429);
    expect((await register('2001:db8:77:2::1')).status).toBe(201);
  });

  it('cannot be raced past with parallel requests', async () => {
    const ip = '198.51.100.79';
    const { limit } = RATE_BUCKETS.deviceRegister;
    const results = await Promise.all(Array.from({ length: limit + 5 }, () => register(ip)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(limit);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('does not spend the allowance on a malformed body', async () => {
    const ip = '198.51.100.80';
    for (let i = 0; i < 25; i++) {
      const res = await SELF.fetch(url('/v1/devices'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ displayName: '' }),
      });
      expect(res.status).toBe(400);
    }
    expect((await register(ip)).status).toBe(201);
  });
});

describe('ipRateKey', () => {
  it('keys IPv4 by the address and IPv6 by its /64', () => {
    expect(ipRateKey('198.51.100.7')).toBe('198.51.100.7');
    expect(ipRateKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipRateKey('2001:0DB8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(ipRateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipRateKey('::1')).toBe('0:0:0:0::/64');
    expect(ipRateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('keys an IPv4-mapped address as its IPv4', () => {
    expect(ipRateKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('falls back to the raw value, or unknown', () => {
    expect(ipRateKey(null)).toBe('unknown');
    expect(ipRateKey('  ')).toBe('unknown');
    expect(ipRateKey('not:an:ip')).toBe('not:an:ip');
    expect(ipRateKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
  });
});

describe('PATCH /v1/me for a banned account', () => {
  it('403 banned, and the name is unchanged', async () => {
    const device = await registerDevice('Before the ban');
    await banUser(device.userId);
    const res = await SELF.fetch(url('/v1/me'), {
      method: 'PATCH',
      headers: authHeaders(device),
      body: JSON.stringify({ displayName: 'Rebranded' }),
    });
    expect(res.status).toBe(403);
    expect(errorCode(await res.json())).toBe('banned');

    const me = await SELF.fetch(url('/v1/me'), { headers: authHeaders(device) });
    expect(((await me.json()) as MeResponse).displayName).toBe('Before the ban');
  });
});

describe('router', () => {
  it('400s (not 500s) on malformed percent-encoding in the path', async () => {
    const res = await SELF.fetch(url('/v1/trails/heysen/waypoints/%E0%A4%A/comments'));
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_path');
  });
});

describe('unknown bearer tokens', () => {
  it('cost reads only — the legacy-account heal never writes on a miss', async () => {
    const statements: string[] = [];
    const db = env.DB;
    const recording = {
      ...env,
      DB: {
        prepare(sql: string) {
          statements.push(sql);
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      } as unknown as D1Database,
    } as unknown as Env;

    const request = new Request(url('/v1/me'), {
      headers: { Authorization: `Bearer bogus-${crypto.randomUUID()}` },
    });
    expect(await getUser(request, recording)).toBeNull();
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
  });
});
