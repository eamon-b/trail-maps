import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, registerDevice, url } from './helpers';
import type { MeResponse } from '../../../src/lib/comments-api-types';

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
