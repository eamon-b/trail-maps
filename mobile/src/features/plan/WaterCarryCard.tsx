/**
 * Water carries — the longest dry stretches in the section, from the shared
 * `analyzeWaterCarryForSection` (top ~5 gaps, biggest first). Carries at/over
 * the calculator's 15 km dry-stretch threshold (`isDryStretch`) are flagged.
 * Safety-critical for Australian trails, so the flag is loud.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import type { WaterGap } from '@lib/plan-types';

export function WaterCarryCard({
  carries,
  hasData,
  units,
}: {
  carries: WaterGap[];
  hasData: boolean;
  units: Units;
}) {
  const { colors } = useTheme();

  if (!hasData || carries.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        No mapped water sources in this section.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {carries.map((gap, i) => (
        <View
          key={`${gap.fromKm}-${gap.toKm}-${i}`}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: gap.isDryStretch ? colors.danger : colors.border,
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {gap.fromName} → {gap.toName}
            </Text>
            {gap.isDryStretch && (
              <View style={[styles.badge, { backgroundColor: colors.danger }]}>
                <Text style={[styles.badgeText, { color: colors.dangerText }]}>Dry ≥ 15 km</Text>
              </View>
            )}
          </View>
          <Text style={[styles.stats, { color: colors.textSecondary }]}>
            {formatDistance(gap.distanceKm, units)} carry
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  empty: { ...typography.bodySmall, paddingVertical: spacing.md },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  route: { ...typography.titleSmall, flexShrink: 1 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  badgeText: { ...typography.caption, fontWeight: '700' },
  stats: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
});
