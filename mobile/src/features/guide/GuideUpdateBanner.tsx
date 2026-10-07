/**
 * "Updated guide data" — a one-line banner above the guide panes, shown once a
 * newer copy of this trail has downloaded while the guide was open
 * (`GuideContext`'s `dataUpdate`).
 *
 * Reload swaps the new copy in where the hiker is; nothing else happens until
 * they tap it. "Not now" hides it for this copy only: a later update brings
 * it back, and so does reopening the guide (which shows the new copy anyway).
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { useGuide } from './GuideContext';

export function GuideUpdateBanner() {
  const { colors } = useTheme();
  const { dataUpdate } = useGuide();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (!dataUpdate.available) return null;
  if (dataUpdate.version !== null && dataUpdate.version === dismissedVersion) return null;

  return (
    <View
      accessibilityRole="summary"
      style={[styles.banner, { backgroundColor: colors.accentSubtle, borderColor: colors.border }]}
    >
      <Text style={[styles.text, { color: colors.textPrimary }]} numberOfLines={2}>
        Updated guide data has downloaded.
      </Text>
      <Pressable
        onPress={() => setDismissedVersion(dataUpdate.version)}
        disabled={dataUpdate.reloading}
        accessibilityRole="button"
        accessibilityLabel="Not now"
        accessibilityHint="Keeps the guide on the data it opened with"
        hitSlop={spacing.xs}
        style={styles.action}
      >
        <Text style={[styles.actionLabel, { color: colors.textSecondary }]}>Not now</Text>
      </Pressable>
      <Pressable
        onPress={dataUpdate.reload}
        disabled={dataUpdate.reloading}
        accessibilityRole="button"
        accessibilityLabel="Reload guide"
        accessibilityState={{ busy: dataUpdate.reloading }}
        hitSlop={spacing.xs}
        style={[styles.action, styles.primary, { backgroundColor: colors.accent }]}
      >
        {dataUpdate.reloading ? (
          <ActivityIndicator accessibilityLabel="Reloading guide" color={colors.accentText} size="small" />
        ) : (
          <Text style={[styles.actionLabel, { color: colors.accentText }]}>Reload</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { ...typography.caption, flex: 1 },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  primary: { paddingHorizontal: spacing.lg },
  actionLabel: { ...typography.titleSmall },
});
