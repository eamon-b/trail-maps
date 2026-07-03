import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

export type LocationState = 'onTrail' | 'noGps' | 'drifting' | 'warning' | 'offTrail';

interface LocationStatusBarProps {
  state: LocationState;
  /** Optional detail text (e.g., "150m from trail") */
  detail?: string;
  style?: ViewStyle;
}

const stateConfig: Record<LocationState, { icon: string; label: string }> = {
  onTrail: { icon: '✓', label: 'On trail' },
  noGps: { icon: '⊘', label: 'No GPS' },
  drifting: { icon: '~', label: 'Drifting' },
  warning: { icon: '⚠', label: 'Warning' },
  offTrail: { icon: '✕', label: 'Off trail' },
};

function useStateColor(state: LocationState): string {
  const { colors } = useTheme();
  switch (state) {
    case 'onTrail':
      return colors.alertGreen;
    case 'noGps':
    case 'drifting':
      return colors.textSecondary;
    case 'warning':
      return colors.alertAmber;
    case 'offTrail':
      return colors.alertRed;
  }
}

/**
 * Location status bar showing GPS/trail status.
 * Uses color + icon + text label so it never relies on color alone.
 * Accepts state as props — detection logic is in Part 5.
 */
export function LocationStatusBar({ state, detail, style }: LocationStatusBarProps) {
  const { colors } = useTheme();
  const stateColor = useStateColor(state);
  const { icon, label } = stateConfig[state];

  return (
    <View
      style={[styles.container, { backgroundColor: stateColor }, style]}
      accessibilityLabel={`Location status: ${label}${detail ? `. ${detail}` : ''}`}
      accessibilityRole="alert"
    >
      <Text style={styles.icon}>{icon}</Text>
      <Text style={[styles.label, { color: colors.textInverse }]}>{label}</Text>
      {detail && (
        <Text style={[styles.detail, { color: colors.textInverse }]}>{detail}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    minHeight: touchTarget.min,
    gap: spacing.sm,
  },
  icon: {
    fontSize: 16,
    color: '#FFFFFF',
  },
  label: {
    ...typography.titleSmall,
    fontWeight: '700',
  },
  detail: {
    ...typography.caption,
    marginLeft: 'auto',
  },
});
