/**
 * Header actions are icon-only, so their accessibility label is the ONLY name a
 * screen reader — and every Maestro flow, which selects by label — can match.
 * These assertions guard that contract and the theme-token icon color.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { HeaderActions, HeaderIconButton } from '../HeaderIconButton';
import { glyphSizes } from '../../tokens';

jest.mock('../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

describe('HeaderIconButton', () => {
  it('exposes the action by accessibility label and button role', () => {
    const tree = render(
      <HeaderIconButton name="cog" accessibilityLabel="Settings" onPress={jest.fn()} />,
    );

    // Pressable copies its props onto an inner host View, so match on the
    // pairing across the tree rather than on one node.
    const labelled = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Settings' && n.props.accessibilityRole === 'button',
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('renders the named icon at the header glyph size in the accent text color', () => {
    const tree = render(
      <HeaderIconButton name="routes" accessibilityLabel="Routes" onPress={jest.fn()} />,
    );

    const [icon] = tree.root.findAllByType(MaterialCommunityIcons);
    expect(icon.props.name).toBe('routes');
    expect(icon.props.size).toBe(glyphSizes.lg);
    expect(icon.props.color).toBe('#123456');
  });

  it('calls onPress when pressed', () => {
    const onPress = jest.fn();
    const tree = render(
      <HeaderIconButton name="plus" accessibilityLabel="Import GPX" onPress={onPress} />,
    );

    const [pressable] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Import GPX' && typeof n.props.onPress === 'function',
    );
    act(() => {
      (pressable.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders every action inside the row wrapper', () => {
    const tree = render(
      <HeaderActions>
        <HeaderIconButton name="routes" accessibilityLabel="Routes" onPress={jest.fn()} />
        <HeaderIconButton name="cog" accessibilityLabel="Settings" onPress={jest.fn()} />
      </HeaderActions>,
    );

    expect(tree.root.findAllByType(MaterialCommunityIcons)).toHaveLength(2);
  });
});
