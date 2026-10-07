/**
 * Bottom padding for a screen's scroll content, so its last item can scroll
 * clear of the system navigation bar.
 *
 * Android is edge-to-edge (mandatory since Expo SDK 54): the window runs under
 * the navigation bar, and a ScrollView's content ends at the bottom of the
 * window, so without this the last card stops half under the bar (Settings'
 * About section did). iOS draws its home indicator over the content the same
 * way. The inset is added to whatever bottom padding the screen already asks
 * for, so the screen's own spacing is kept above the bar rather than eaten
 * by it.
 */

import {
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** `style` with `inset` added to its bottom padding; unchanged for no inset. */
export function padForBottomInset(
  style: StyleProp<ViewStyle>,
  inset: number,
): StyleProp<ViewStyle> {
  if (inset <= 0) return style;
  const flat = StyleSheet.flatten(style) ?? {};
  const base = flat.paddingBottom ?? flat.paddingVertical ?? flat.padding ?? 0;
  // A percentage cannot be added to; such a screen keeps its own padding.
  if (typeof base !== 'number') return style;
  return [style, { paddingBottom: base + inset }];
}

/** A scroll view's `contentContainerStyle` padded for the bottom system bar. */
export function useBottomInsetContentStyle(
  style?: StyleProp<ViewStyle>,
): StyleProp<ViewStyle> {
  const { bottom } = useSafeAreaInsets();
  return padForBottomInset(style, bottom);
}
