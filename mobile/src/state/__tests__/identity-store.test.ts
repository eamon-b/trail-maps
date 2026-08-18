/**
 * Identity store semantics that the UI depends on.
 *
 * The important guarantee is failure behaviour: `register`/`rename` hit the
 * network, and when the request never lands they must reject WITHOUT mutating
 * the store — the composer and the Settings display-name editor both rely on
 * "previous state still stands" when they catch and surface the error.
 */

import { useIdentityStore } from '../identity-store';
import {
  deleteAccount,
  getSession,
  registerDevice,
  updateDisplayName,
} from '../../api/auth';
import { getDatabase } from '../../db/database';
import { purgeLocalAccountData } from '../../features/settings/account-deletion';

jest.mock('../../api/auth', () => ({
  getSession: jest.fn(),
  registerDevice: jest.fn(),
  updateDisplayName: jest.fn(),
  deleteAccount: jest.fn(),
}));

jest.mock('../../db/database', () => ({
  getDatabase: jest.fn(async () => ({ __db: true })),
}));

jest.mock('../../features/settings/account-deletion', () => ({
  purgeLocalAccountData: jest.fn(async () => undefined),
}));

const mockGetSession = getSession as jest.Mock;
const mockRegisterDevice = registerDevice as jest.Mock;
const mockUpdateDisplayName = updateDisplayName as jest.Mock;
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockPurge = purgeLocalAccountData as jest.Mock;

const SESSION = { userId: 'u1', token: 't1', displayName: 'Trail Ghost' };

beforeEach(() => {
  jest.clearAllMocks();
  useIdentityStore.setState({ status: 'unknown', session: null, authError: false });
});

describe('hydrate', () => {
  it('becomes registered when the keystore holds a session', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await useIdentityStore.getState().hydrate();
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'registered',
      session: SESSION,
    });
  });

  it('becomes anonymous when there is no stored identity', async () => {
    mockGetSession.mockResolvedValue(null);
    await useIdentityStore.getState().hydrate();
    expect(useIdentityStore.getState()).toMatchObject({ status: 'anonymous', session: null });
  });
});

describe('register', () => {
  it('stores the new session and clears any auth error', async () => {
    useIdentityStore.setState({ status: 'anonymous', authError: true });
    mockRegisterDevice.mockResolvedValue(SESSION);

    const session = await useIdentityStore.getState().register('Trail Ghost');

    expect(session).toEqual(SESSION);
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'registered',
      session: SESSION,
      authError: false,
    });
  });

  it('rejects and leaves the store untouched when the request fails', async () => {
    useIdentityStore.setState({ status: 'anonymous', session: null });
    mockRegisterDevice.mockRejectedValue(new Error('NetworkError'));

    await expect(useIdentityStore.getState().register('Trail Ghost')).rejects.toThrow(
      'NetworkError',
    );
    expect(useIdentityStore.getState()).toMatchObject({ status: 'anonymous', session: null });
  });
});

describe('rename', () => {
  it('swaps in the renamed session', async () => {
    useIdentityStore.setState({ status: 'registered', session: SESSION });
    mockUpdateDisplayName.mockResolvedValue({ ...SESSION, displayName: 'Ridge Runner' });

    await useIdentityStore.getState().rename('Ridge Runner');

    expect(useIdentityStore.getState().session).toEqual({
      ...SESSION,
      displayName: 'Ridge Runner',
    });
  });

  it('rejects and keeps the previous name when the request fails', async () => {
    useIdentityStore.setState({ status: 'registered', session: SESSION });
    mockUpdateDisplayName.mockRejectedValue(new Error('NetworkError'));

    await expect(useIdentityStore.getState().rename('Ridge Runner')).rejects.toThrow(
      'NetworkError',
    );
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'registered',
      session: SESSION,
    });
  });
});

describe('deleteAccount', () => {
  it('deletes server-side, purges the local copy, and goes anonymous', async () => {
    useIdentityStore.setState({ status: 'registered', session: SESSION, authError: true });
    mockDeleteAccount.mockResolvedValue(undefined);

    await useIdentityStore.getState().deleteAccount();

    expect(mockDeleteAccount).toHaveBeenCalled();
    // Purge runs against the opened DB, keyed on the pre-deletion user id.
    expect(mockPurge).toHaveBeenCalledWith({ __db: true }, SESSION.userId);
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'anonymous',
      session: null,
      authError: false,
    });
  });

  it('falls back to the keystore for the user id when the store is not hydrated', async () => {
    useIdentityStore.setState({ status: 'unknown', session: null });
    mockGetSession.mockResolvedValue(SESSION);
    mockDeleteAccount.mockResolvedValue(undefined);

    await useIdentityStore.getState().deleteAccount();

    expect(mockPurge).toHaveBeenCalledWith({ __db: true }, SESSION.userId);
    expect(useIdentityStore.getState()).toMatchObject({ status: 'anonymous', session: null });
  });

  it('rejects and keeps the session when the request never lands', async () => {
    useIdentityStore.setState({ status: 'registered', session: SESSION });
    mockDeleteAccount.mockRejectedValue(new Error('NetworkError'));

    await expect(useIdentityStore.getState().deleteAccount()).rejects.toThrow('NetworkError');

    // Nothing purged locally either — the account still exists on the server.
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'registered',
      session: SESSION,
    });
  });
});
