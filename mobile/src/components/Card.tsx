import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { SkeletonPlaceholder } from './SkeletonPlaceholder';

export type CardState = 'normal' | 'loading' | 'empty' | 'degraded';

interface CardProps {
  /** Card visual state */
  state?: CardState;
  /** Section label (e.g., "NEXT CAMPSITE"). Omit for label-less surfaces. */
  label?: string;
  /** Main content for normal/degraded states */
  children?: React.ReactNode;
  /** Message shown in empty state */
  emptyMessage?: string;
  /** Staleness info shown in degraded state */
  degradedMessage?: string;
  /**
   * Removes the inner padding and clips children to the rounded corners —
   * for grouped list rows (settings) that manage their own insets.
   */
  flush?: boolean;
  /** Additional styles for the outer container */
  style?: ViewStyle;
  /** Accessibility label for the entire card */
  accessibilityLabel?: string;
  /** Makes the whole card a ≥44pt button when provided */
  onPress?: () => void;
}

/** A card container that handles normal, loading, empty, and degraded states */
export function Card({
  state = 'normal',
  label,
  children,
  emptyMessage = 'No data available',
  degradedMessage,
  flush = false,
  style,
  accessibilityLabel,
  onPress,
}: CardProps) {
  const { colors, highContrast } = useTheme();

  const defaultBorderWidth = highContrast ? 1.5 : StyleSheet.hairlineWidth;
  const cardStyle = [
    styles.card,
    flush ? styles.cardFlush : styles.cardPadded,
    onPress ? styles.cardPressable : null,
    {
      backgroundColor: highContrast ? colors.background : colors.surface,
      borderColor: state === 'degraded' ? colors.alertAmber : colors.border,
      borderWidth: state === 'degraded' ? 2 : defaultBorderWidth,
    },
    style,
  ];

  const content = (
    <>
      {label != null && (
        <Text
          style={[styles.label, { color: colors.textSecondary }]}
          accessibilityRole="header"
        >
          {label}
        </Text>
      )}

      {state === 'loading' && (
        <View style={styles.skeletonContainer}>
          <SkeletonPlaceholder width="70%" height={24} />
          <SkeletonPlaceholder width="40%" height={16} style={{ marginTop: spacing.xs }} />
        </View>
      )}

      {state === 'empty' && (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {emptyMessage}
        </Text>
      )}

      {(state === 'normal' || state === 'degraded') && children}

      {state === 'degraded' && degradedMessage && (
        <Text style={[styles.degradedText, { color: colors.alertAmber }]}>
          {degradedMessage}
        </Text>
      )}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={cardStyle}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      style={cardStyle}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="summary"
    >
      {content}
    </View>
  );
}

/** Stat display component for distance/elevation pairs */
export function StatDisplay({
  primary,
  secondary,
  compact = false,
  accessibilityLabel,
}: {
  primary: string;
  secondary?: string;
  /** Stack secondary below primary instead of beside it */
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={compact ? styles.statContainerCompact : styles.statContainer}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={[styles.primaryStat, { color: colors.textPrimary }]}>
        {primary}
      </Text>
      {secondary && (
        <Text style={[styles.secondaryStat, { color: colors.textSecondary }]}>
          {secondary}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    marginBottom: spacing.md,
  },
  cardPadded: {
    padding: spacing.lg,
  },
  cardFlush: {
    overflow: 'hidden',
  },
  cardPressable: {
    minHeight: touchTarget.min,
  },
  label: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  skeletonContainer: {
    paddingVertical: spacing.xs,
  },
  emptyText: {
    ...typography.body,
    fontStyle: 'italic',
  },
  degradedText: {
    ...typography.caption,
    marginTop: spacing.sm,
  },
  statContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  statContainerCompact: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  primaryStat: {
    ...typography.displayLarge,
  },
  secondaryStat: {
    ...typography.displaySmall,
  },
});
