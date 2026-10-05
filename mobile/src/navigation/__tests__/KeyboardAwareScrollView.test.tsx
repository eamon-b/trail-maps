/**
 * The keyboard must never cover the field being typed in. On Android
 * (edge-to-edge, so the window does not resize) that takes a padding
 * KeyboardAvoidingView offset by the header; on iOS the ScrollView's own
 * keyboard insets. Either missing put the comment composer under the keyboard.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { KeyboardAvoidingView, Platform, ScrollView, Text } from 'react-native';
import { HeaderHeightContext } from '@react-navigation/elements';
import {
  KeyboardAvoidingModalContent,
  KeyboardAwareScrollView,
} from '../KeyboardAwareScrollView';

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

function withHeader(height: number, child: React.ReactElement) {
  return <HeaderHeightContext.Provider value={height}>{child}</HeaderHeightContext.Provider>;
}

const originalOS = Platform.OS;
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
});
function setOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('KeyboardAwareScrollView', () => {
  it('pads by the keyboard on Android, offset by the header height', () => {
    setOS('android');
    const tree = render(
      withHeader(
        96,
        <KeyboardAwareScrollView>
          <Text>field</Text>
        </KeyboardAwareScrollView>,
      ),
    );
    const avoiding = tree.root.findAllByType(KeyboardAvoidingView)[0];
    expect(avoiding.props.behavior).toBe('padding');
    expect(avoiding.props.keyboardVerticalOffset).toBe(96);
    expect(avoiding.findAllByType(ScrollView)[0].props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('treats a screen without a header as offset 0', () => {
    setOS('android');
    const tree = render(<KeyboardAwareScrollView />);
    expect(tree.root.findAllByType(KeyboardAvoidingView)[0].props.keyboardVerticalOffset).toBe(0);
  });

  it('uses the ScrollView keyboard insets on iOS', () => {
    setOS('ios');
    const tree = render(withHeader(96, <KeyboardAwareScrollView />));
    expect(tree.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0);
    expect(tree.root.findAllByType(ScrollView)[0].props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it('forwards the ref to the ScrollView', () => {
    setOS('android');
    const ref = React.createRef<ScrollView>();
    render(<KeyboardAwareScrollView ref={ref} />);
    expect(ref.current).not.toBeNull();
  });
});

describe('KeyboardAvoidingModalContent', () => {
  it.each(['ios', 'android'] as const)('pads a dialog by the keyboard on %s', (os) => {
    setOS(os);
    const tree = render(
      <KeyboardAvoidingModalContent>
        <Text>card</Text>
      </KeyboardAvoidingModalContent>,
    );
    const avoiding = tree.root.findAllByType(KeyboardAvoidingView)[0];
    expect(avoiding.props.behavior).toBe('padding');
    expect(avoiding.props.keyboardVerticalOffset ?? 0).toBe(0);
  });
});
