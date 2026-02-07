import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { SkeletonPlaceholder } from './SkeletonPlaceholder';

export type CardState = 'normal' | 'loading' | 'empty' | 'degraded';

interface CardProps {
  /** Card visual state */
  state?: CardState;
  /** Section label (e.g., "NEXT CAMPSITE") */
  label: string;
  /** Main content for normal/degraded states */
  children?: React.ReactNode;
  /** Message shown in empty state */
  emptyMessage?: string;
  /** Staleness info shown in degraded state */
  degradedMessage?: string;
  /** Additional styles for the outer container */
  style?: ViewStyle;
  /** Accessibility label for the entire card */
  accessibilityLabel?: string;
}

/** A card container that handles normal, loading, empty, and degraded states */
export function Card({
  state = 'normal',
  label,
  children,
  emptyMessage = 'No data available',
  degradedMessage,
  style,
  accessibilityLabel,
}: CardProps) {
  const { colors, highContrast } = useTheme();

  const defaultBorderWidth = highContrast ? 1.5 : StyleSheet.hairlineWidth;
  const cardStyle = [
    styles.card,
    {
      backgroundColor: highContrast ? colors.background : colors.surface,
      borderColor: state === 'degraded' ? colors.alertAmber : colors.border,
      borderWidth: state === 'degraded' ? 2 : defaultBorderWidth,
    },
    style,
  ];

  return (
    <View
      style={cardStyle}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="summary"
    >
      <Text
        style={[styles.label, { color: colors.textSecondary }]}
        accessibilityRole="header"
      >
        {label}
      </Text>

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
    </View>
  );
}

/** Stat display component for distance/elevation pairs */
export function StatDisplay({
  primary,
  secondary,
  accessibilityLabel,
}: {
  primary: string;
  secondary?: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={styles.statContainer}
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
    padding: spacing.lg,
    marginBottom: spacing.md,
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
  primaryStat: {
    ...typography.displayLarge,
  },
  secondaryStat: {
    ...typography.displaySmall,
  },
});
