/**
 * A description's URL is a nested `Text` that opens in the phone's browser;
 * the prose around it stays inert.
 */

import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { LinkifiedText } from '../LinkifiedText';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function links(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(Text).filter((t) => t.props.accessibilityRole === 'link');
}

describe('LinkifiedText', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens a URL in the description in the browser', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <LinkifiedText
          text={'Hut - sleepable\nhttps://www.henro.org/place/pilgrim-hut-no-44\nFeatures: Toilet'}
        />,
      );
    });
    const [link] = links(renderer);
    expect(link.props.children).toBe('https://www.henro.org/place/pilgrim-hut-no-44');
    act(() => (link.props.onPress as () => void)());
    expect(Linking.openURL).toHaveBeenCalledWith('https://www.henro.org/place/pilgrim-hut-no-44');
  });

  it('renders text without a URL with no link', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LinkifiedText text="Water tank, reliable" />);
    });
    expect(links(renderer)).toHaveLength(0);
    expect(renderer.root.findAllByType(Text)[0].props.children).toEqual(['Water tank, reliable']);
  });

  it('lets the description be selected and copied', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LinkifiedText text="Tel 0888-12-3456, inn@example.jp" />);
    });
    expect(renderer.root.findAllByType(Text)[0].props.selectable).toBe(true);
  });
});
