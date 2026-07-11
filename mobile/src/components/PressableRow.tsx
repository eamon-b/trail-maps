import React, { useCallback } from 'react';
import {
  AccessibilityRole,
  AccessibilityState,
  Insets,
  Pressable,
  StyleProp,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { touchTarget } from '../tokens/spacing';
import { triggerHaptic, type HapticType } from './haptics';

export interface PressableRowProps {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /**
   * Touch-target tier: 'default' = 44pt accessibility floor,
   * 'field' = 56pt for hike-mode primary actions (gloved/one-handed use).
   */
  size?: 'default' | 'field';
  /**
   * Haptic fired on press. Defaults to a selection tick; pass 'none' for
   * rows where feedback would be noise (e.g. inside scrolling pickers).
   */
  haptic?: HapticType | 'none';
  /** Haptic fired on long-press activation (default 'warning' when onLongPress set) */
  longPressHaptic?: HapticType | 'none';
  /** Draw the themed border (thickened automatically in high-contrast mode) */
  bordered?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Defaults to 'button' */
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  hitSlop?: number | Insets;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * The shared pressable primitive: every tappable row/button goes through
 * this so the ≥44pt floor, haptic feedback, high-contrast borders, and
 * accessibility props are enforced in one place instead of per-component.
 */
export function PressableRow({
  onPress,
  onLongPress,
  disabled = false,
  size = 'default',
  haptic = 'selection',
  longPressHaptic = 'warning',
  bordered = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  hitSlop,
  testID,
  style,
  children,
}: PressableRowProps) {
  const { colors, highContrast } = useTheme();

  const handlePress = useCallback(() => {
    if (haptic !== 'none') triggerHaptic(haptic);
    onPress?.();
  }, [haptic, onPress]);

  const handleLongPress = useCallback(() => {
    if (longPressHaptic !== 'none') triggerHaptic(longPressHaptic);
    onLongPress?.();
  }, [longPressHaptic, onLongPress]);

  return (
    <Pressable
      onPress={onPress ? handlePress : undefined}
      onLongPress={onLongPress ? handleLongPress : undefined}
      disabled={disabled}
      hitSlop={hitSlop}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole={accessibilityRole}
      accessibilityState={disabled ? { disabled: true, ...accessibilityState } : accessibilityState}
      style={[
        styles.row,
        size === 'field' ? styles.field : styles.default,
        bordered && {
          borderColor: colors.border,
          borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth,
        },
        disabled && styles.disabled,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    justifyContent: 'center',
  },
  default: {
    minHeight: touchTarget.min,
  },
  field: {
    minHeight: touchTarget.field,
  },
  disabled: {
    opacity: 0.5,
  },
});
