/**
 * Reactive mirror of the device's comment identity.
 *
 * The durable copy of the session (incl. the bearer token) lives in the OS
 * keystore via `api/auth`; this store is the in-memory, render-reactive view of
 * it so the composer knows whether to prompt for a display name and the sync
 * banner can surface a paused (401) queue. Not persisted — it is rehydrated
 * from secure storage on guide open.
 */

import { create } from 'zustand';
import {
  deleteAccount as deleteAccountRequest,
  getSession,
  registerDevice,
  updateDisplayName,
  type Session,
} from '../api/auth';
import { getDatabase } from '../db/database';
import { purgeLocalAccountData } from '../features/settings/account-deletion';

export type IdentityStatus = 'unknown' | 'anonymous' | 'registered';

export interface IdentityState {
  status: IdentityStatus;
  session: Session | null;
  /** Set when a 401 pauses the outbox — the user needs to re-establish identity. */
  authError: boolean;

  /** Load the persisted session (idempotent; safe to call on every guide open). */
  hydrate: () => Promise<void>;
  /** Register this device under a display name and become `registered`. */
  register: (displayName: string) => Promise<Session>;
  /** Change the display name (requires an existing identity). */
  rename: (displayName: string) => Promise<void>;
  /**
   * Delete the account server-side, purge this device's copy of its data, and
   * fall back to `anonymous`. Rejects (store untouched) if the request fails.
   */
  deleteAccount: () => Promise<void>;
  setAuthError: (value: boolean) => void;
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  status: 'unknown',
  session: null,
  authError: false,

  hydrate: async () => {
    const session = await getSession();
    set({ session, status: session ? 'registered' : 'anonymous' });
  },

  register: async (displayName: string) => {
    const session = await registerDevice(displayName);
    set({ session, status: 'registered', authError: false });
    return session;
  },

  rename: async (displayName: string) => {
    const session = await updateDisplayName(displayName);
    set({ session });
  },

  deleteAccount: async () => {
    // Capture the id BEFORE the request: a successful delete clears the
    // keystore, and the local purge is keyed on that id.
    const userId = get().session?.userId ?? (await getSession())?.userId;
    await deleteAccountRequest();
    if (userId) {
      const db = await getDatabase();
      await purgeLocalAccountData(db, userId);
    }
    set({ session: null, status: 'anonymous', authError: false });
  },

  setAuthError: (value: boolean) => set({ authError: value }),
}));
