import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';
import type {
  RegisterDeviceResponse,
} from '../../../src/lib/comments-api-types';

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
