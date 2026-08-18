/**
 * Settings' Account section — the promise the first-post prompt makes ("you can
 * change it later in Settings") has to actually be keepable, and a rename is a
 * blocking network call, so the failure path matters as much as the happy one.
 */

import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DisplayNameSection, RENAME_FAILED_MESSAGE } from '../DisplayNameSection';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { NetworkError } from '../../../api/client';
import { useIdentityStore } from '../../../state/identity-store';
import { getSession, updateDisplayName } from '../../../api/auth';

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
}));

const mockGetSession = getSession as jest.Mock;
const mockUpdateDisplayName = updateDisplayName as jest.Mock;

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
    tree = TestRenderer.create(<DisplayNameSection />);
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

function press(r: ReactTestRenderer, accessibilityLabel: string) {
  const target = r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === accessibilityLabel &&
      typeof n.props?.onPress === 'function',
  )[0];
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

function typeName(r: ReactTestRenderer, text: string) {
  const input = r.root.findAllByType(TextInput)[0];
  act(() => {
    (input.props.onChangeText as (t: string) => void)(text);
  });
}

describe('DisplayNameSection', () => {
  it('explains the flow when the device has no identity yet', async () => {
    mockGetSession.mockResolvedValue(null);
    const r = await mount();

    expect(renderedText(r)).toContain('post your first comment');
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('shows the current name and renames it', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockUpdateDisplayName.mockResolvedValue({ ...SESSION, displayName: 'Ridge Runner' });
    const r = await mount();

    expect(renderedText(r)).toContain('Trail Ghost');

    press(r, 'Edit display name');
    typeName(r, '  Ridge Runner  ');
    await pressAsync(r, 'Save display name');

    expect(mockUpdateDisplayName).toHaveBeenCalledWith('Ridge Runner');
    // Back to the read-only row, showing the new name.
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
    expect(renderedText(r)).toContain('Ridge Runner');
  });

  it('shows a connection error and keeps the previous name when the rename fails', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockUpdateDisplayName.mockRejectedValue(new NetworkError('PATCH /v1/me failed'));
    const r = await mount();

    press(r, 'Edit display name');
    typeName(r, 'Ridge Runner');
    await pressAsync(r, 'Save display name');

    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
    // Editor stays open with the typed name; the stored name is untouched.
    expect(r.root.findAllByType(TextInput)[0].props.value).toBe('Ridge Runner');
    expect(useIdentityStore.getState().session).toEqual(SESSION);
  });

  it('falls back to generic copy for an unrecognised rename failure', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockUpdateDisplayName.mockRejectedValue(new Error('boom'));
    const r = await mount();

    press(r, 'Edit display name');
    typeName(r, 'Ridge Runner');
    await pressAsync(r, 'Save display name');

    expect(renderedText(r)).toContain(RENAME_FAILED_MESSAGE);
  });

  it('rejects an empty name locally without a round trip', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    const r = await mount();

    press(r, 'Edit display name');
    typeName(r, '   ');
    await pressAsync(r, 'Save display name');

    expect(mockUpdateDisplayName).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain('Enter a display name.');
  });

  it('rejects an over-long name locally without a round trip', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    const r = await mount();

    press(r, 'Edit display name');
    typeName(r, 'x'.repeat(41));
    await pressAsync(r, 'Save display name');

    expect(mockUpdateDisplayName).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain('40 characters');
  });

  it('closes the editor without a request when the name is unchanged', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    const r = await mount();

    press(r, 'Edit display name');
    await pressAsync(r, 'Save display name');

    expect(mockUpdateDisplayName).not.toHaveBeenCalled();
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('renders nothing while the keystore read is in flight', () => {
    mockGetSession.mockReturnValue(new Promise(() => {}));
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<DisplayNameSection />);
    });
    mounted = tree;
    expect(tree.toJSON()).toBeNull();
  });
});
