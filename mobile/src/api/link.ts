/**
 * Linking a browser to this phone's account.
 *
 * There is no email and no password anywhere in Tracknotes: identity is the
 * device token minted by `POST /v1/devices` and kept in the OS keystore. A
 * browser therefore cannot "log in" — it borrows this account by exchanging a
 * short code the phone mints here. The phone's own token is never the thing
 * that travels; the browser gets a separate `linked` token with an expiry the
 * phone can see and revoke.
 *
 * Two layers, as in `api/auth.ts`:
 *
 *  - the ctx-taking primitives ({@link createLinkCode}, {@link listDevices},
 *    {@link revokeDevice}) — pure request functions, injectable `fetchImpl`,
 *    used by tests and by anything that already holds a context;
 *  - the session wrappers ({@link requestLinkCode}, {@link fetchDevices},
 *    {@link revokeLinkedDevice}) — they read the keystore themselves, so the
 *    bearer token never leaves `src/api`. The Settings screen calls these.
 */

import type {
  DeviceTokenSummary,
  DevicesResponse,
  LinkCodeResponse,
} from '@lib/comments-api-types';
import { apiRequest, getBaseUrl, type FetchLike } from './client';
import { getSession } from './auth';

export interface ApiContext {
  baseUrl: string;
  fetchImpl?: FetchLike;
  token?: string;
}

/** Mint a short-lived, single-use code for a browser to exchange. 201. */
export async function createLinkCode(ctx: ApiContext): Promise<LinkCodeResponse> {
  return apiRequest<LinkCodeResponse>('/v1/link-codes', {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'POST',
  });
}

/** Everything currently signed in to this account (never any token material). */
export async function listDevices(ctx: ApiContext): Promise<DeviceTokenSummary[]> {
  const res = await apiRequest<DevicesResponse>('/v1/me/devices', {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
  });
  return res?.devices ?? [];
}

/**
 * Revoke one LINKED token by its published id. 204.
 *
 * The primary token — this phone — is refused by the server (400
 * `primary_token`): dropping it would leave the account with no way to delete
 * itself, so that is `DELETE /v1/me` instead.
 */
export async function revokeDevice(ctx: ApiContext, id: string): Promise<void> {
  await apiRequest<void>(`/v1/me/devices/${encodeURIComponent(id)}`, {
    baseUrl: ctx.baseUrl,
    fetchImpl: ctx.fetchImpl,
    token: ctx.token,
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Session wrappers — the token is read here and nowhere else
// ---------------------------------------------------------------------------

export interface LinkDeps {
  /** Override the resolved base URL (tests / explicit config). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** Message thrown when the device linking UI is reachable without an identity. */
export const NO_IDENTITY_MESSAGE = 'This device has no account yet.';

async function sessionContext(deps?: LinkDeps): Promise<ApiContext> {
  const baseUrl = deps?.baseUrl ?? getBaseUrl();
  if (!baseUrl) throw new Error('The comments server is not configured in this build.');
  const session = await getSession();
  if (!session) throw new Error(NO_IDENTITY_MESSAGE);
  return { baseUrl, fetchImpl: deps?.fetchImpl, token: session.token };
}

/** {@link createLinkCode} against the stored session. */
export async function requestLinkCode(deps?: LinkDeps): Promise<LinkCodeResponse> {
  return createLinkCode(await sessionContext(deps));
}

/** {@link listDevices} against the stored session. */
export async function fetchDevices(deps?: LinkDeps): Promise<DeviceTokenSummary[]> {
  return listDevices(await sessionContext(deps));
}

/** {@link revokeDevice} against the stored session. */
export async function revokeLinkedDevice(id: string, deps?: LinkDeps): Promise<void> {
  return revokeDevice(await sessionContext(deps), id);
}
