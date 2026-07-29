/**
 * Direction toggle for the guide screen.
 *
 * A small pill near the segmented bar that flips the guide's travel direction.
 * It writes through `toggleDirection(trailId)` on the settings store; the
 * GuideProvider re-resolves (and re-reverses) the trail whenever that value
 * changes, so nothing here touches the trail geometry directly.
 *
 * The label shows the CURRENT direction using the trail's own direction names
 * (e.g. "Northbound"), falling back to "Forward" / "Reversed".
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { useGuide } from './GuideContext';
import { directionLabel, type DirectionNames } from './direction-label';

export function DirectionToggle() {
  const { colors } = useTheme();
  const { trailId, trail, direction } = useGuide();
  const toggleDirection = useSettingsStore((s) => s.toggleDirection);

  const names = trail.config.direction as DirectionNames | undefined;
  const label = directionLabel(names, direction);

  return (
    <Pressable
      onPress={() => toggleDirection(trailId)}
      accessibilityRole="button"
      accessibilityLabel={`Direction: ${label}. Tap to reverse.`}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.icon, { color: colors.accent }]}>⇅</Text>
      <View style={styles.labels}>
        <Text style={[styles.caption, { color: colors.textSecondary }]} numberOfLines={1}>
          Direction
        </Text>
        <Text style={[styles.value, { color: colors.textPrimary }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    fontSize: glyphSizes.md,
  },
  labels: {
    alignItems: 'flex-start',
  },
  caption: {
    ...typography.caption,
  },
  value: {
    ...typography.dataSmall,
  },
  pressed: {
    opacity: 0.6,
  },
});
