/**
 * The resupply legs: one card per carry between the stops the hiker ticked,
 * straight from `@lib/resupply-plan`'s `computeResupplyLegs`. Distance, climb,
 * days and food weight are the calculator's, including the "long carry" flag
 * (`isLong`) — nothing here decides what is far.
 *
 * Three ways to have no legs, and they mean different things to a hiker: a
 * trail with no towns at all, a trail whose towns are all unticked, and a
 * section that happens to contain none of the ticked ones. `hasOptions` and
 * `stopCount` tell them apart.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { ResupplyLeg } from '@lib/resupply-plan';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { formatDays, formatFoodWeight } from './plan-format';

export interface ResupplyCardProps {
  legs: ResupplyLeg[];
  /** Whether the trail offers any resupply option at all. */
  hasOptions: boolean;
  /** How many stops the selection resolved to (before section scoping). */
  stopCount: number;
  units: Units;
}

export function ResupplyCard({ legs, hasOptions, stopCount, units }: ResupplyCardProps) {
  const { colors } = useTheme();

  if (legs.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        {!hasOptions
          ? 'No towns or resupply points on this trail.'
          : stopCount === 0
            ? 'No resupply stops ticked. Tick the ones you plan to use.'
            : 'No ticked resupply stops in this section.'}
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {legs.map((leg, i) => (
        <View
          key={`${leg.fromKm}-${leg.toKm}-${i}`}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: leg.isLong ? colors.warning : colors.border,
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {leg.fromName} → {leg.toName}
            </Text>
            {leg.isLong && (
              <View style={[styles.badge, { backgroundColor: colors.warning }]}>
                <Text style={[styles.badgeText, { color: colors.warningText }]}>Long carry</Text>
              </View>
            )}
          </View>
          <Text style={[styles.stats, { color: colors.textSecondary }]}>
            {statsLine(leg, units)}
          </Text>
          {leg.arrival && (
            <Text style={[styles.arrival, { color: colors.textSecondary }]}>
              Arrive Day {leg.arrival.day}
              {leg.arrival.date ? ` · ${leg.arrival.date}` : ''}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

/** "148.2 km · +5,120 m / −4,870 m · ≈ 6 days · 4.1 kg food" — built as one
 *  string so the separators cannot be eaten by JSX whitespace collapsing. */
function statsLine(leg: ResupplyLeg, units: Units): string {
  return [
    formatDistance(leg.distanceKm, units),
    `+${formatElevation(leg.ascentM, units)} / −${formatElevation(leg.descentM, units)}`,
    formatDays(leg.estimatedDays),
    `${formatFoodWeight(leg.food.weightKg, units)} food`,
  ].join(' · ');
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
  arrival: { ...typography.caption, fontVariant: ['tabular-nums'] },
});
