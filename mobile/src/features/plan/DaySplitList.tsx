/**
 * Day-split list — one card per computed day. Every number comes from the
 * shared day-calculator (`computeDays` → distance, ascent/descent, est. hours,
 * water-source count). The end indicator is the guide-added snapping, keyed off
 * the day's three-state `endKind`: a real campsite/shelter (`camp`), a wild camp
 * (`wild`), or the section finish (`finish` — a town/hut/trailhead at the end).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { ThemeColors } from '../../tokens/themes';
import type { Units } from '../../state/settings-store';
import { planFloorHours, planWindowHours, type PlanDay } from './plan-adapters';
import { formatHours } from './plan-format';

/** Footer end-of-day label, keyed off the day's three-state `endKind`. */
function endLabel(day: PlanDay): string {
  switch (day.endKind) {
    case 'finish':
      return `🏁 ${day.endName}`;
    case 'camp':
      return `⛺ ${day.endName}`;
    default:
      return 'No campsite nearby — wild camp';
  }
}

/** Footer end-of-day color: finish reads positive, camp branded, wild muted. */
function endColor(day: PlanDay, colors: ThemeColors): string {
  switch (day.endKind) {
    case 'finish':
      return colors.success;
    case 'camp':
      return colors.waypointCamp;
    default:
      return colors.textSecondary;
  }
}

export function DaySplitList({
  days,
  targetHours,
  units,
}: {
  days: PlanDay[];
  targetHours: number;
  units: Units;
}) {
  const { colors } = useTheme();

  // A snapped camp can (rarely, by construction) push a day past the window the
  // splitter allows around the target. Surface that overshoot subtly so the card
  // stays honest about the terrain the hiker asked for. Each day is judged
  // against the allowance the splitter actually grants IT (Decision 8): interior
  // days may snap up to the window; the final day absorbs the remainder up to
  // the floor, which exceeds the window once the target passes 10 h.
  const windowH = planWindowHours(targetHours);
  const finishAllowanceH = Math.max(windowH, planFloorHours(targetHours));
  const allowanceFor = (day: PlanDay) =>
    targetHours + (day.endKind === 'finish' ? finishAllowanceH : windowH);

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
            <Text style={[styles.camp, { color: endColor(day, colors) }]}>
              {endLabel(day)}
            </Text>
            <Text style={[styles.water, { color: colors.textSecondary }]}>
              {day.waterSources} water source{day.waterSources === 1 ? '' : 's'}
            </Text>
          </View>

          {day.estimatedHours > allowanceFor(day) && (
            <Text style={[styles.overHint, { color: colors.warning }]}>
              {`+${formatHours(day.estimatedHours - targetHours)} over target`}
            </Text>
          )}
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
  overHint: { ...typography.caption, fontVariant: ['tabular-nums'] },
});
