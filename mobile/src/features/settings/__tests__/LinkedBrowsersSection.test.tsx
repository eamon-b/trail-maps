/**
 * Settings' linking section.
 *
 * What matters here is what the hiker can act on: a device with no account is
 * told why there is no button, a minted code is on screen with its countdown,
 * the list says which row is the phone, a browser can be removed, and every
 * failure shows a sentence instead of disappearing.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  DEVICES_FAILED_MESSAGE,
  LINK_CODE_FAILED_MESSAGE,
  LINK_INSTRUCTION,
  LinkedBrowsersSection,
} from '../LinkedBrowsersSection';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { NetworkError } from '../../../api/client';
import { useIdentityStore } from '../../../state/identity-store';
import { fetchDevices, requestLinkCode, revokeLinkedDevice } from '../../../api/link';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  isApiConfigured: () => true,
}));

jest.mock('../../../api/link', () => ({
  requestLinkCode: jest.fn(),
  fetchDevices: jest.fn(),
  revokeLinkedDevice: jest.fn(),
}));

const mockRequestLinkCode = requestLinkCode as jest.Mock;
const mockFetchDevices = fetchDevices as jest.Mock;
const mockRevoke = revokeLinkedDevice as jest.Mock;

const PHONE = {
  id: 'phone12345678',
  kind: 'primary' as const,
  label: null,
  createdAt: '2026-09-01T00:00:00Z',
  lastSeenAt: '2026-09-19T00:00:00Z',
  expiresAt: null,
  current: true,
};
const BROWSER = {
  id: 'browser12345',
  kind: 'linked' as const,
  label: 'Chrome on macOS',
  createdAt: '2026-09-10T00:00:00Z',
  lastSeenAt: '2026-09-19T00:00:00Z',
  expiresAt: '2027-03-09T00:00:00Z',
  current: false,
};

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchDevices.mockResolvedValue([PHONE, BROWSER]);
  useIdentityStore.setState({ status: 'registered', session: null, authError: false });
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<LinkedBrowsersSection />);
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

function findByLabel(r: ReactTestRenderer, accessibilityLabel: string) {
  return r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === accessibilityLabel &&
      typeof n.props?.onPress === 'function',
  );
}

async function press(r: ReactTestRenderer, accessibilityLabel: string) {
  const target = findByLabel(r, accessibilityLabel)[0];
  await act(async () => {
    (target.props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('LinkedBrowsersSection', () => {
  it('renders nothing until the keystore has been read', async () => {
    useIdentityStore.setState({ status: 'unknown', session: null, authError: false });
    const r = await mount();
    expect(r.toJSON()).toBeNull();
    expect(mockFetchDevices).not.toHaveBeenCalled();
  });

  it('explains the flow — and asks for nothing — on a device with no account', async () => {
    useIdentityStore.setState({ status: 'anonymous', session: null, authError: false });
    const r = await mount();

    expect(renderedText(r)).toContain('post your first comment');
    expect(findByLabel(r, 'Link a browser')).toHaveLength(0);
    expect(mockFetchDevices).not.toHaveBeenCalled();
  });

  it('lists what is signed in, marking the phone as unremovable', async () => {
    const r = await mount();

    const text = renderedText(r);
    expect(text).toContain('This phone');
    expect(text).toContain('Chrome on macOS');
    expect(findByLabel(r, 'Remove This phone')).toHaveLength(0);
    expect(findByLabel(r, 'Remove Chrome on macOS')).toHaveLength(1);
  });

  it('mints a code and shows it grouped, with the instruction and a countdown', async () => {
    mockRequestLinkCode.mockResolvedValue({
      code: 'ABCD2345',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const r = await mount();

    await press(r, 'Link a browser');

    const text = renderedText(r);
    expect(text).toContain('ABCD 2345');
    expect(text).toContain(LINK_INSTRUCTION);
    expect(text).toMatch(/Expires in/);
    expect(text).toMatch(/(9:5\d|10:00)/);
  });

  it('shows a connection error instead of a code when minting fails', async () => {
    mockRequestLinkCode.mockRejectedValue(new NetworkError('offline'));
    const r = await mount();

    await press(r, 'Link a browser');

    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
    // The button is still there to try again.
    expect(findByLabel(r, 'Link a browser')).toHaveLength(1);
  });

  it('falls back to the generic message for a failure it cannot name', async () => {
    mockRequestLinkCode.mockRejectedValue(new Error('boom'));
    const r = await mount();
    await press(r, 'Link a browser');
    expect(renderedText(r)).toContain(LINK_CODE_FAILED_MESSAGE);
  });

  it('removes a browser from the list once the revoke lands', async () => {
    mockRevoke.mockResolvedValue(undefined);
    const r = await mount();

    await press(r, 'Remove Chrome on macOS');

    expect(mockRevoke).toHaveBeenCalledWith('browser12345');
    expect(renderedText(r)).not.toContain('Chrome on macOS');
    expect(renderedText(r)).toContain('This phone');
  });

  it('keeps the row and says why when a revoke fails', async () => {
    mockRevoke.mockRejectedValue(new NetworkError('offline'));
    const r = await mount();

    await press(r, 'Remove Chrome on macOS');

    expect(renderedText(r)).toContain('Chrome on macOS');
    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
  });

  it('says so when the device list cannot be loaded', async () => {
    mockFetchDevices.mockRejectedValue(new Error('nope'));
    const r = await mount();
    expect(renderedText(r)).toContain(DEVICES_FAILED_MESSAGE);
  });

  it('says when nothing is signed in yet', async () => {
    mockFetchDevices.mockResolvedValue([]);
    const r = await mount();
    expect(renderedText(r)).toContain('Nothing is signed in');
  });
});
