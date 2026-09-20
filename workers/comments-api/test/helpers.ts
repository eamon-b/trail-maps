import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';
import type {
  LinkCodeResponse,
  RegisterDeviceResponse,
} from '../../../src/lib/comments-api-types';
import type { PlanDocument, PlanStop } from '../../../src/lib/plan-types';

const BASE = 'https://comments.test';

export interface Device {
  userId: string;
  token: string;
  displayName: string;
}

/** Register a fresh anonymous device and return its identity + token. */
export async function registerDevice(displayName = 'Trail Angel'): Promise<Device> {
  const res = await SELF.fetch(`${BASE}/v1/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as RegisterDeviceResponse;
  return { userId: body.userId, token: body.token, displayName: body.displayName };
}

export function authHeaders(device: Device): Record<string, string> {
  return {
    Authorization: `Bearer ${device.token}`,
    'Content-Type': 'application/json',
  };
}

/** Flip a user's admin flag directly in D1. */
export async function makeAdmin(userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).bind(userId).run();
}

/** Flip a user's banned flag directly in D1. */
export async function banUser(userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET is_banned = 1 WHERE id = ?`).bind(userId).run();
}

export interface PutCommentBody {
  trailId?: string;
  waypointId?: string;
  text?: string | null;
  waterStatus?: string | null;
  observedAt?: string | null;
}

/** PUT a comment under a given (client-minted) id. */
export async function putComment(
  device: Device,
  id: string,
  body: PutCommentBody
): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/comments/${id}`, {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

/** Convenience: create a valid comment, returning the id + response. */
export async function createComment(
  device: Device,
  overrides: PutCommentBody = {}
): Promise<{ id: string; res: Response }> {
  const id = crypto.randomUUID();
  const res = await putComment(device, id, {
    trailId: 'heysen',
    waypointId: 'spring-01',
    text: 'Water is running well here.',
    ...overrides,
  });
  return { id, res };
}

export function url(path: string): string {
  return `${BASE}${path}`;
}

/** POST a moderation report against a comment. */
export async function reportComment(
  device: Device,
  commentId: string,
  body: { reason?: unknown; detail?: unknown } = { reason: 'spam' }
): Promise<Response> {
  return SELF.fetch(url(`/v1/comments/${commentId}/report`), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

/** DELETE the authenticated device's own account. */
export async function deleteMe(device: Device): Promise<Response> {
  return SELF.fetch(url('/v1/me'), {
    method: 'DELETE',
    headers: authHeaders(device),
  });
}

/** PUT a curated waypoint description as an admin. */
export async function putDescription(
  device: Device,
  trailId: string,
  waypointId: string,
  body: { description?: unknown }
): Promise<Response> {
  return SELF.fetch(url(`/v1/admin/trails/${trailId}/descriptions/${waypointId}`), {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

/** POST raw image bytes to a comment's photo endpoint. */
export async function uploadPhoto(
  device: Device,
  commentId: string,
  body: BodyInit,
  contentType = 'image/jpeg'
): Promise<Response> {
  return SELF.fetch(url(`/v1/comments/${commentId}/photos`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${device.token}`,
      'Content-Type': contentType,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** A valid `PUT /v1/plans/:id` body (a PlanDocument minus `updatedAt`). */
export function planBody(
  id: string,
  overrides: Partial<Omit<PlanDocument, 'updatedAt'>> = {}
): Omit<PlanDocument, 'updatedAt'> {
  return {
    id,
    trailId: 'heysen',
    name: 'Heysen SOBO',
    direction: 'NOBO',
    startDate: '2026-04-01',
    stops: [
      { km: 12.4, name: 'Mount Lofty', nights: 1, waypointId: 'heysen-camp-01' },
      { km: 31.9, name: 'Norton Summit', nights: 2, note: 'rang ahead', booked: true },
    ] as PlanStop[],
    version: 1,
    ...overrides,
  };
}

/** PUT a plan document under a client-minted id. */
export async function putPlan(
  device: Device,
  id: string,
  body: unknown
): Promise<Response> {
  return SELF.fetch(url(`/v1/plans/${id}`), {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

/** Convenience: create a valid plan, returning its id + response. */
export async function createPlan(
  device: Device,
  overrides: Partial<Omit<PlanDocument, 'updatedAt'>> = {}
): Promise<{ id: string; res: Response }> {
  const id = crypto.randomUUID();
  const res = await putPlan(device, id, planBody(id, overrides));
  return { id, res };
}

/** GET this device's plans (delta when `query` carries `since`). */
export async function listPlans(device: Device, query = ''): Promise<Response> {
  return SELF.fetch(url(`/v1/plans${query}`), { headers: authHeaders(device) });
}

// ---------------------------------------------------------------------------
// Device linking
// ---------------------------------------------------------------------------

/** POST /v1/link-codes as the phone. */
export async function createLinkCode(device: Device): Promise<Response> {
  return SELF.fetch(url('/v1/link-codes'), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify({}),
  });
}

/** Mint a link code and return it (asserting the 201). */
export async function linkCode(device: Device): Promise<LinkCodeResponse> {
  const res = await createLinkCode(device);
  expect(res.status).toBe(201);
  return (await res.json()) as LinkCodeResponse;
}

/**
 * A fresh IP per call: the exchange endpoint is capped per IP per hour, and
 * tests in a file share one database, so a fixed address would make unrelated
 * tests race each other into a 429.
 */
export function freshIp(): string {
  const n = Math.floor(Math.random() * 0xffff);
  return `203.0.113.${n % 250}:${n}`;
}

/** POST /v1/devices/link as an unauthenticated browser. */
export async function linkDevice(
  body: { code?: unknown; label?: unknown },
  ip = freshIp()
): Promise<Response> {
  return SELF.fetch(url('/v1/devices/link'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}
