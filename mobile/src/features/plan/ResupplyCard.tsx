/**
 * Resupply summary — legs between resupply points from the shared
 * `analyzeResupplyForSection`, each paired with the calculator's food-carry
 * weight estimate (`foodCarryForGap`). Outputs surfaced faithfully; the "long
 * carry" flag is the calculator's own `isLong`.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import type { ResupplyGap } from '@lib/plan-types';
import type { FoodCarryEstimate } from '@lib/resupply-calculator';
import { formatDays, formatFoodWeight } from './plan-format';

export function ResupplyCard({
  legs,
  hasData,
  units,
}: {
  legs: { gap: ResupplyGap; food: FoodCarryEstimate }[];
  hasData: boolean;
  units: Units;
}) {
  const { colors } = useTheme();

  if (!hasData || legs.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        No towns or resupply points in this section.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {legs.map((leg, i) => (
        <View
          key={`${leg.gap.fromKm}-${leg.gap.toKm}-${i}`}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: leg.gap.isLong ? colors.warning : colors.border,
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {leg.gap.fromName} → {leg.gap.toName}
            </Text>
            {leg.gap.isLong && (
              <View style={[styles.badge, { backgroundColor: colors.warning }]}>
                <Text style={[styles.badgeText, { color: colors.warningText }]}>Long carry</Text>
              </View>
            )}
          </View>
          <Text style={[styles.stats, { color: colors.textSecondary }]}>
            {formatDistance(leg.gap.distanceKm, units)} · {formatDays(leg.gap.estimatedDays)} ·{' '}
            {formatFoodWeight(leg.food.weightKg)} food
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
