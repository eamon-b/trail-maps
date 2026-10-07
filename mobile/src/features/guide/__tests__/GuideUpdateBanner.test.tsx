/**
 * The "Updated guide data" banner: shown only while a newer copy is waiting,
 * Reload hands off to the provider, and "Not now" hides it for that copy only.
 */

import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestRenderer,
  type TestInstance,
} from 'react-test-renderer';
import { GuideUpdateBanner } from '../GuideUpdateBanner';
import { useGuide, type GuideDataUpdate } from '../GuideContext';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../GuideContext', () => ({ useGuide: jest.fn() }));

const mockUseGuide = useGuide as jest.Mock;

function setUpdate(update: Partial<GuideDataUpdate>) {
  mockUseGuide.mockReturnValue({
    dataUpdate: { available: false, version: null, reloading: false, reload: jest.fn(), ...update },
  });
}

function mount(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<GuideUpdateBanner />);
  });
  return tree;
}

function press(r: ReactTestRenderer, label: string) {
  const [node] = r.root.findAll(
    (n: TestInstance) => n.props.accessibilityLabel === label && !!n.props.onPress,
  );
  act(() => (node.props.onPress as () => void)());
}

function text(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => ([] as unknown[]).concat(t.props.children).join(''))
    .join(' ');
}

describe('GuideUpdateBanner', () => {
  it('renders nothing while the open copy is current', () => {
    setUpdate({ available: false });
    expect(mount().toJSON()).toBeNull();
  });

  it('offers Reload once a newer copy is waiting', () => {
    const reload = jest.fn();
    setUpdate({ available: true, version: 'v2', reload });
    const r = mount();

    expect(text(r)).toContain('Updated guide data has downloaded.');
    press(r, 'Reload guide');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner in place of Reload while reloading', () => {
    setUpdate({ available: true, version: 'v2', reloading: true });
    const r = mount();
    expect(r.root.findAllByType(ActivityIndicator)).toHaveLength(1);
  });

  it('"Not now" hides it for this copy, and a later update brings it back', () => {
    setUpdate({ available: true, version: 'v2' });
    const r = mount();
    press(r, 'Not now');
    expect(r.toJSON()).toBeNull();

    setUpdate({ available: true, version: 'v3' });
    act(() => r.update(<GuideUpdateBanner />));
    expect(text(r)).toContain('Updated guide data has downloaded.');
  });
});
