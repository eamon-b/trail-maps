/**
 * Device identity for the comments API.
 *
 * A Tracknotes install is an anonymous "device": the first time the user posts
 * we POST /v1/devices with a chosen display name and get back a bearer token,
 * which we persist in the OS keystore via expo-secure-store. The raw token is
 * returned exactly once by the server, so losing it means minting a new
 * identity — hence secure, durable storage rather than AsyncStorage.
 *
 * This module is the storage + network seam only; the reactive mirror lives in
 * `state/identity-store`.
 */

import * as SecureStore from 'expo-secure-store';
import type {
  MeResponse,
  RegisterDeviceResponse,
  UpdateMeRequest,
} from '@lib/comments-api-types';
import { apiRequest, getBaseUrl, type FetchLike } from './client';

const SESSION_KEY = 'tracknotes.commentSession';

/** The persisted device identity. */
export interface Session {
  userId: string;
  token: string;
  displayName: string;
}

export interface AuthDeps {
  /** Override the resolved base URL (tests / explicit config). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function resolveBaseUrl(deps?: AuthDeps): string | undefined {
  return deps?.baseUrl ?? getBaseUrl();
}

/** Read the stored session, or `null` if this device has no identity yet. */
export async function getSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (parsed.userId && parsed.token && parsed.displayName) {
      return { userId: parsed.userId, token: parsed.token, displayName: parsed.displayName };
    }
  } catch {
    // Corrupt entry — treat as no identity.
  }
  return null;
}

/** Persist the session in the keystore. */
export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

/** Forget the stored identity (e.g. after a 401 that can't be recovered). */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

/**
 * Register this device under `displayName`, store and return the new session.
 * Throws `ApiError`/`NetworkError` from the client on failure (nothing is
 * persisted unless registration succeeds).
 */
export async function registerDevice(displayName: string, deps?: AuthDeps): Promise<Session> {
  const baseUrl = resolveBaseUrl(deps);
  if (!baseUrl) {
    throw new Error('Cannot register a device: API base URL is not configured');
  }
  const res = await apiRequest<RegisterDeviceResponse>('/v1/devices', {
    baseUrl,
    fetchImpl: deps?.fetchImpl,
    method: 'POST',
    body: { displayName },
  });
  const session: Session = {
    userId: res.userId,
    token: res.token,
    displayName: res.displayName,
  };
  await saveSession(session);
  return session;
}

/**
 * Update the current device's display name on the server and in storage.
 * Requires an existing session.
 */
export async function updateDisplayName(displayName: string, deps?: AuthDeps): Promise<Session> {
  const baseUrl = resolveBaseUrl(deps);
  if (!baseUrl) {
    throw new Error('Cannot update display name: API base URL is not configured');
  }
  const session = await getSession();
  if (!session) {
    throw new Error('Cannot update display name: no device identity');
  }
  const body: UpdateMeRequest = { displayName };
  const res = await apiRequest<MeResponse>('/v1/me', {
    baseUrl,
    token: session.token,
    fetchImpl: deps?.fetchImpl,
    method: 'PATCH',
    body,
  });
  const next: Session = { ...session, displayName: res.displayName };
  await saveSession(next);
  return next;
}
