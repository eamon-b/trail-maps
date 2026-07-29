/**
 * Day-split list — one card per computed day. Every number comes from the
 * shared day-calculator (`computeDays` → distance, ascent/descent, est. hours,
 * water-source count). The camp indicator is the guide-added snapping: the day
 * end is a real campsite/shelter when `snappedToCamp`, otherwise a wild camp.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import type { PlanDay } from './plan-adapters';
import { formatHours } from './plan-format';

export function DaySplitList({ days, units }: { days: PlanDay[]; units: Units }) {
  const { colors } = useTheme();

  if (days.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        Choose a section with some distance to see day splits.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {days.map((day) => (
        <View
          key={day.dayNumber}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <View style={styles.head}>
            <Text style={[styles.dayNum, { color: colors.accentText, backgroundColor: colors.accent }]}>
              Day {day.dayNumber}
            </Text>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {day.startName} → {day.endName}
            </Text>
          </View>

          <View style={styles.stats}>
            <Stat label="Distance" value={formatDistance(day.distanceKm, units)} />
            <Stat label="Ascent" value={`↑ ${formatElevation(day.ascentM, units)}`} />
            <Stat label="Descent" value={`↓ ${formatElevation(day.descentM, units)}`} />
            <Stat label="Est. time" value={formatHours(day.estimatedHours)} />
          </View>

          <View style={styles.footer}>
            <Text
              style={[
                styles.camp,
                { color: day.snappedToCamp ? colors.waypointCamp : colors.textSecondary },
              ]}
            >
              {day.snappedToCamp
                ? `⛺ ${day.endName}`
                : 'No campsite nearby — wild camp'}
            </Text>
            <Text style={[styles.water, { color: colors.textSecondary }]}>
              {day.waterSources} water{day.waterSources === 1 ? '' : ''} source
              {day.waterSources === 1 ? '' : 's'}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
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
    gap: spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayNum: {
    ...typography.caption,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  route: { ...typography.titleSmall, flexShrink: 1 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  stat: { gap: 2 },
  statLabel: { ...typography.caption },
  statValue: { ...typography.bodySmall, fontVariant: ['tabular-nums'], fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  camp: { ...typography.caption, flexShrink: 1 },
  water: { ...typography.caption, fontVariant: ['tabular-nums'] },
});
