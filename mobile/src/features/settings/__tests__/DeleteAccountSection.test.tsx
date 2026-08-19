/**
 * Settings' delete-account section.
 *
 * Deletion is irreversible and hits the network, so the two things worth
 * pinning down are that it can't happen without an explicit confirmation, and
 * that a failed request leaves the account (and says so) rather than silently
 * looking like it worked.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DeleteAccountSection, DELETE_FAILED_MESSAGE } from '../DeleteAccountSection';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { NetworkError } from '../../../api/client';
import { useIdentityStore } from '../../../state/identity-store';
import { deleteAccount, getSession } from '../../../api/auth';
import { purgeLocalAccountData } from '../account-deletion';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  isApiConfigured: () => true,
}));

jest.mock('../../../api/auth', () => ({
  getSession: jest.fn(),
  registerDevice: jest.fn(),
  updateDisplayName: jest.fn(),
  deleteAccount: jest.fn(),
}));

jest.mock('../../../db/database', () => ({
  getDatabase: jest.fn(async () => ({})),
}));

jest.mock('../account-deletion', () => ({
  purgeLocalAccountData: jest.fn(async () => undefined),
}));

const mockGetSession = getSession as jest.Mock;
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockPurge = purgeLocalAccountData as jest.Mock;

const SESSION = { userId: 'u1', token: 't1', displayName: 'Trail Ghost' };

/** Mounted trees are unmounted between tests so store resets don't re-render them. */
let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useIdentityStore.setState({ status: 'unknown', session: null, authError: false });
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

/** Mount and let the keystore hydrate resolve. */
async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<DeleteAccountSection />);
    await new Promise((resolve) => setImmediate(resolve));
  });
  mounted = tree;
  return tree;
}

function renderedText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

function findPressable(r: ReactTestRenderer, accessibilityLabel: string) {
  return r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === accessibilityLabel &&
      typeof n.props?.onPress === 'function',
  );
}

function press(r: ReactTestRenderer, accessibilityLabel: string) {
  const target = findPressable(r, accessibilityLabel)[0];
  act(() => {
    (target.props.onPress as () => void)();
  });
}

async function pressAsync(r: ReactTestRenderer, accessibilityLabel: string) {
  press(r, accessibilityLabel);
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('DeleteAccountSection', () => {
  it('is hidden on a device with no identity — nothing to delete', async () => {
    mockGetSession.mockResolvedValue(null);
    const r = await mount();
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing while the keystore read is in flight', () => {
    mockGetSession.mockReturnValue(new Promise(() => {}));
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<DeleteAccountSection />);
    });
    mounted = tree;
    expect(tree.toJSON()).toBeNull();
  });

  it('explains the blast radius to a registered device', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    const r = await mount();

    const text = renderedText(r);
    expect(text).toContain('Delete account');
    expect(text).toContain('can’t be undone');
    expect(text).toContain('stay on this device');
  });

  it('does not delete anything until the confirmation is accepted', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    const r = await mount();

    // Opening the sheet is not consent.
    press(r, 'Delete account');
    expect(mockDeleteAccount).not.toHaveBeenCalled();

    press(r, 'Cancel account deletion');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(useIdentityStore.getState().session).toEqual(SESSION);
  });

  it('deletes the account on confirmation and disappears', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockDeleteAccount.mockResolvedValue(undefined);
    const r = await mount();

    press(r, 'Delete account');
    await pressAsync(r, 'Delete account permanently');

    expect(mockDeleteAccount).toHaveBeenCalled();
    expect(mockPurge).toHaveBeenCalledWith(expect.anything(), SESSION.userId);
    expect(useIdentityStore.getState()).toMatchObject({ status: 'anonymous', session: null });
    // Status flipped to anonymous, so the section renders nothing.
    expect(r.toJSON()).toBeNull();
  });

  it('shows a connection error and keeps the account when the request fails', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockDeleteAccount.mockRejectedValue(new NetworkError('DELETE /v1/me failed'));
    const r = await mount();

    press(r, 'Delete account');
    await pressAsync(r, 'Delete account permanently');

    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
    expect(mockPurge).not.toHaveBeenCalled();
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'registered',
      session: SESSION,
    });
    // Still offering the action, so the user can retry.
    expect(findPressable(r, 'Delete account permanently')).not.toHaveLength(0);
  });

  it('falls back to generic copy for an unrecognised failure', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockDeleteAccount.mockRejectedValue(new Error('boom'));
    const r = await mount();

    press(r, 'Delete account');
    await pressAsync(r, 'Delete account permanently');

    expect(renderedText(r)).toContain(DELETE_FAILED_MESSAGE);
  });
});
