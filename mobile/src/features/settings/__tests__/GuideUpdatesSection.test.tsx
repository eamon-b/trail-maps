/**
 * Settings' "Guide updates" row: a forced catalog check (community list
 * alongside, as pull-to-refresh does), a spinner while any check runs, and a
 * plain-English line for what the check found.
 */

import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestRenderer,
  type TestInstance,
} from 'react-test-renderer';
import { GuideUpdatesSection, guideUpdateResultText } from '../GuideUpdatesSection';
import {
  checkForTrailDataUpdates,
  trailDataBaseUrl,
} from '../../../services/trail-data-updates';
import { refreshCommunityRoutes } from '../../../services/community-routes';
import { useTrailDataStore } from '../../../state/trail-data-store';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../services/trail-data-updates', () => ({
  checkForTrailDataUpdates: jest.fn(),
  trailDataBaseUrl: jest.fn(() => 'https://data.example/trails/v1'),
}));

jest.mock('../../../services/community-routes', () => ({
  refreshCommunityRoutes: jest.fn(async () => ({ checked: true })),
}));

const mockCheck = checkForTrailDataUpdates as jest.Mock;
const mockBaseUrl = trailDataBaseUrl as jest.Mock;
const mockRefreshCommunity = refreshCommunityRoutes as jest.Mock;

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  mockBaseUrl.mockReturnValue('https://data.example/trails/v1');
  act(() => useTrailDataStore.setState({ checking: false }));
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

function mount(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<GuideUpdatesSection />);
  });
  mounted = tree;
  return tree;
}

function renderedText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => ([] as unknown[]).concat(t.props.children).filter((c) => typeof c === 'string').join(''))
    .join(' ');
}

function button(r: ReactTestRenderer) {
  const [node] = r.root.findAll(
    (n: TestInstance) =>
      n.props.accessibilityLabel === 'Check for guide updates' && !!n.props.onPress,
  );
  return node;
}

describe('GuideUpdatesSection', () => {
  it('is hidden in a build without over-the-air trail data', () => {
    mockBaseUrl.mockReturnValue('');
    expect(mount().toJSON()).toBeNull();
  });

  it('forces a check of the catalog and the community list, then says what it found', async () => {
    mockCheck.mockResolvedValue({ checked: true, updated: ['shikoku'], failed: [] });
    const r = mount();

    await act(async () => {
      (button(r).props.onPress as () => void)();
    });

    expect(mockCheck).toHaveBeenCalledWith({ force: true });
    expect(mockRefreshCommunity).toHaveBeenCalledWith({ force: true });
    expect(renderedText(r)).toContain('1 guide was updated. An open guide offers to reload.');
  });

  it('shows a spinner and refuses a second press while any check runs', () => {
    const r = mount();
    act(() => useTrailDataStore.setState({ checking: true }));

    expect(r.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(button(r).props.disabled).toBe(true);
  });
});

describe('guideUpdateResultText', () => {
  it.each([
    [{ checked: true, updated: [], failed: [] }, 'Every guide is up to date.'],
    [
      { checked: true, updated: ['a', 'b'], failed: [] },
      '2 guides were updated. An open guide offers to reload.',
    ],
    [
      { checked: true, updated: [], failed: ['a'] },
      'Some updates failed and will be tried again next time.',
    ],
    [
      { checked: true, updated: ['a'], failed: ['b'] },
      '1 guide was updated. An open guide offers to reload. Some updates failed and will be tried again next time.',
    ],
    [
      { checked: false, updated: [], failed: [], error: 'Network request failed' },
      'Couldn’t check for updates. Network request failed',
    ],
    [{ checked: false, updated: [], failed: [] }, 'Couldn’t check for updates.'],
  ])('%j → %s', (result, text) => {
    expect(guideUpdateResultText(result)).toBe(text);
  });
});
