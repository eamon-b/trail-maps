import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { timingConfigs, durations } from '../tokens/motion';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface UndoToastProps {
  /** Whether the toast is visible */
  visible: boolean;
  /** Message to display */
  message: string;
  /** Called when undo is tapped */
  onUndo: () => void;
  /** Called when the toast is dismissed (timeout or manual) */
  onDismiss: () => void;
  /** Auto-dismiss delay in ms (defaults to durations.undoToast) */
  durationMs?: number;
}

/** Undo toast with auto-dismiss (3 s by default) */
export function UndoToast({ visible, message, onUndo, onDismiss, durationMs }: UndoToastProps) {
  const { colors, highContrast } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(100);

  useEffect(() => {
    if (visible) {
      translateY.value = reduceMotion
        ? 0
        : withTiming(0, timingConfigs.slideIn);
      const timer = setTimeout(onDismiss, durationMs ?? durations.undoToast);
      return () => clearTimeout(timer);
    } else {
      translateY.value = reduceMotion
        ? 100
        : withTiming(100, timingConfigs.slideIn);
    }
  }, [visible, translateY, reduceMotion, onDismiss, durationMs]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          bottom: insets.bottom + spacing.lg,
          backgroundColor: colors.surfaceElevated,
          borderColor: colors.border,
          // High contrast: a stronger border than the default hairline so the
          // floating toast is clearly bounded against whatever is behind it.
          borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth,
        },
        animatedStyle,
      ]}
      accessibilityRole="alert"
      accessibilityLabel={`${message}. Tap undo to restore.`}
    >
      <Text style={[styles.message, { color: colors.textPrimary }]} numberOfLines={1}>
        {message}
      </Text>
      <Pressable
        onPress={onUndo}
        style={[styles.undoButton, { backgroundColor: colors.accent }]}
        accessibilityLabel="Undo"
        accessibilityRole="button"
      >
        <Text style={[styles.undoText, { color: colors.textInverse }]}>Undo</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  message: {
    ...typography.body,
    flex: 1,
    marginRight: spacing.sm,
  },
  undoButton: {
    minWidth: touchTarget.min,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  undoText: {
    ...typography.titleSmall,
    fontWeight: '700',
  },
});
