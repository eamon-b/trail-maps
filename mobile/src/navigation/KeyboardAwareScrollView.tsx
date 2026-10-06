/**
 * A screen's ScrollView that keeps the focused text field above the keyboard.
 *
 * Any stack screen with a TextInput in a ScrollView should use this rather than
 * a bare ScrollView, because neither platform does it unaided:
 *
 * - **Android** is edge-to-edge (mandatory since Expo SDK 54), so the window no
 *   longer resizes for the keyboard (`adjustResize` is a no-op) and the keyboard
 *   simply draws over the bottom of the screen. A `padding` KeyboardAvoidingView
 *   shrinks the ScrollView instead, and Android's ScrollView then scrolls the
 *   focused field back into view on the size change by itself. The view
 *   measures its overlap with the keyboard from its own layout, which is
 *   relative to the screen below the header, so the header height is passed as
 *   `keyboardVerticalOffset` — without it the padding falls short by exactly
 *   the header and the field stays hidden.
 * - **iOS** gets `automaticallyAdjustKeyboardInsets`: the ScrollView insets its
 *   content by the keyboard and scrolls the focused field into view natively,
 *   in window coordinates, so it is right in a sheet-presented modal too.
 *
 * Lives in `src/navigation/` beside the other screen chrome because screens in
 * both stacks, and screens of several features, use it.
 */

import { HeaderHeightContext } from 'expo-router/react-navigation';
import { forwardRef, useContext, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type ScrollViewProps,
} from 'react-native';

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function KeyboardAwareScrollView(props, ref) {
    // The context rather than `useHeaderHeight()`, which throws outside a
    // navigator (tests render screens without one); no header is 0.
    const headerHeight = useContext(HeaderHeightContext) ?? 0;
    const scroll = (
      <ScrollView
        ref={ref}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        {...props}
      />
    );
    if (Platform.OS === 'ios') return scroll;
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
        {scroll}
      </KeyboardAvoidingView>
    );
  },
);

/**
 * The same avoidance for a centred dialog in a `<Modal>`: wrap the backdrop in
 * this so the card rises above the keyboard instead of being half covered. A
 * Modal fills the window, so there is no header to offset by.
 */
export function KeyboardAvoidingModalContent({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
