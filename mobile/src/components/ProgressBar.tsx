import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface ProgressBarProps {
  /** Progress fraction (0 to 1) */
  progress: number;
  /** Optional label shown above the bar (e.g., "BIBBULMUN TRACK  SOBO") */
  label?: string;
  /** Optional detail text shown right of label (e.g., "km 245 / 982") */
  detail?: string;
  /** Bar height in points */
  height?: number;
  /** Additional styles */
  style?: ViewStyle;
}

/** Trail/day progress bar with optional label */
export function ProgressBar({
  progress,
  label,
  detail,
  height = 6,
  style,
}: ProgressBarProps) {
  const { colors, highContrast } = useTheme();
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const percentText = `${Math.round(clampedProgress * 100)}%`;

  return (
    <View
      style={style}
      accessibilityLabel={`Progress: ${percentText}${label ? `. ${label}` : ''}${detail ? `. ${detail}` : ''}`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clampedProgress * 100) }}
    >
      {(label || detail) && (
        <View style={styles.headerRow}>
          {label && (
            <Text style={[styles.label, { color: colors.textPrimary }]} numberOfLines={1}>
              {label}
            </Text>
          )}
          {detail && (
            <Text style={[styles.detail, { color: colors.textSecondary }]}>
              {detail}
            </Text>
          )}
        </View>
      )}
      <View
        style={[
          styles.track,
          {
            height,
            backgroundColor: colors.border,
            // High contrast: outline the track so the empty portion is
            // delineated even when track and surface are close in tone.
            borderWidth: highContrast ? 1 : 0,
            borderColor: colors.textSecondary,
          },
        ]}
      >
        <View
          style={[
            styles.fill,
            {
              height,
              backgroundColor: colors.accent,
              width: `${clampedProgress * 100}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.xs,
  },
  label: {
    ...typography.titleSmall,
    flex: 1,
  },
  detail: {
    ...typography.caption,
    marginLeft: spacing.sm,
  },
  track: {
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  fill: {
    borderRadius: radii.full,
  },
});
