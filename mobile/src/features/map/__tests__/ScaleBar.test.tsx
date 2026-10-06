/**
 * The scale bar stays hidden until the camera reports, then follows it and the
 * user's distance unit.
 */

import React, { createRef } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { ScaleBar, type ScaleBarHandle } from '../ScaleBar';
import { metresPerPoint } from '../map-scale';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), isDark: false }),
}));

const zoomFor = (mpp: number) => Math.log2(metresPerPoint(0, 0) / mpp);

const label = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => t.props.children)[0];

describe('ScaleBar', () => {
  it('renders nothing before the camera has reported', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<ScaleBar unit="km" />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('follows camera updates and the unit', () => {
    const ref = createRef<ScaleBarHandle>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<ScaleBar ref={ref} unit="km" />);
    });
    act(() => ref.current!.update(zoomFor(25), 0));
    expect(label(tree)).toBe('2 km');

    act(() => ref.current!.update(zoomFor(3), 0));
    expect(label(tree)).toBe('200 m');

    act(() => tree.update(<ScaleBar ref={ref} unit="mi" />));
    expect(label(tree)).toBe('500 ft');
  });
});
