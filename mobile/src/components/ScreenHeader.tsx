import React from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { spacing, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { AppText } from './AppText';
import { PressableRow } from './PressableRow';

export interface ScreenHeaderAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

interface ScreenHeaderProps {
  title: string;
  /** Back/dismiss handler. Omit to hide the leading button. */
  onBack?: () => void;
  /** Leading button label (default "Back"; use "Cancel"/"Done" for modals) */
  backLabel?: string;
  /** Trailing action button (e.g. "Apply"). Mutually exclusive with rightSlot. */
  rightAction?: ScreenHeaderAction;
  /** Arbitrary trailing content; wins over rightAction when both provided. */
  rightSlot?: React.ReactNode;
  /**
   * 'plain'   — transparent, sits inside the screen background (default)
   * 'surface' — surface-colored bar with elevation, for map overlays/modals
   */
  variant?: 'plain' | 'surface';
  /** Apply the top safe-area inset (default true). Disable when the parent already pads. */
  safeArea?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The shared screen header: leading back/cancel button, centered
 * single-line title, and a trailing slot — replacing the copy-pasted
 * Back/title/spacer trio across Plan screens, settings, measure, and import.
 * Safe-area aware; text is font-scale clamped via AppText.
 */
export function ScreenHeader({
  title,
  onBack,
  backLabel = 'Back',
  rightAction,
  rightSlot,
  variant = 'plain',
  safeArea = true,
  style,
}: ScreenHeaderProps) {
  const { colors, highContrast } = useTheme();
  const insets = useSafeAreaInsets();

  const trailing = rightSlot ?? (rightAction ? (
    <PressableRow
      onPress={rightAction.onPress}
      disabled={rightAction.disabled}
      accessibilityLabel={rightAction.accessibilityLabel ?? rightAction.label}
      style={styles.sideButton}
    >
      <AppText
        style={[
          styles.sideText,
          styles.rightText,
          { color: rightAction.disabled ? colors.textSecondary : colors.accent },
        ]}
      >
        {rightAction.label}
      </AppText>
    </PressableRow>
  ) : null);

  return (
    <View
      style={[
        styles.header,
        safeArea && { paddingTop: insets.top },
        variant === 'surface' && [
          styles.surface,
          {
            backgroundColor: colors.surface,
            borderBottomColor: colors.border,
            borderBottomWidth: highContrast ? 1.5 : 0,
          },
        ],
        style,
      ]}
    >
      <View style={styles.side}>
        {onBack && (
          <PressableRow
            onPress={onBack}
            accessibilityLabel={backLabel === 'Back' ? 'Go back' : backLabel}
            style={styles.sideButton}
          >
            <AppText style={[styles.sideText, { color: colors.accent }]}>{backLabel}</AppText>
          </PressableRow>
        )}
      </View>
      <AppText
        style={[styles.title, { color: colors.textPrimary }]}
        numberOfLines={1}
        accessibilityRole="header"
      >
        {title}
      </AppText>
      <View style={styles.side}>{trailing}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  surface: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  side: {
    minWidth: 60,
    justifyContent: 'center',
  },
  sideButton: {
    minHeight: touchTarget.min,
    paddingVertical: spacing.sm,
  },
  sideText: {
    ...typography.body,
    fontWeight: '600',
  },
  rightText: {
    textAlign: 'right',
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
