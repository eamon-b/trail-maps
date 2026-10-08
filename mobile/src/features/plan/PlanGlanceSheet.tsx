/**
 * "Your plan" — the planned days in a sheet over whatever the hiker is looking
 * at, so ticking a campsite on the map and checking how long the days around it
 * came out is one tap, not a trip to the planner and a scroll past its inputs.
 *
 * One compact line per day (`PlanDayLine`, shared with the waypoint detail
 * screen's stop card), the "not planned yet" rest, and a way into the full
 * planner. Read-only: stops are made and changed on the map, the waypoint
 * screen and the Plan screen.
 *
 * A bottom-anchored `Modal`, the app's one sheet pattern (`PoiLayersSheet`).
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { ComputedDay } from '@lib/plan-types';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { formatHours } from './plan-format';
import type { PlanGlance } from './plan-glance';

export interface PlanGlanceSheetProps {
  visible: boolean;
  onClose: () => void;
  glance: PlanGlance;
  units: Units;
  /** Opens the full Plan screen; the sheet closes first. */
  onOpenPlanner: () => void;
}

export function PlanGlanceSheet({
  visible,
  onClose,
  glance,
  units,
  onOpenPlanner,
}: PlanGlanceSheetProps) {
  const { colors } = useTheme();
  const { bottom } = useSafeAreaInsets();
  const { days, unplanned } = glance;
  const plannedKm = days.reduce((sum, d) => sum + d.distanceKm, 0);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        accessibilityRole="button"
        accessibilityLabel="Close plan"
        onPress={onClose}
      >
        {/* Swallows taps on the sheet itself so they never dismiss it. */}
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.surfaceElevated, paddingBottom: spacing.xl + bottom },
          ]}
          accessibilityViewIsModal
        >
          <View style={styles.header}>
            <View style={styles.headings}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>Your plan</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                {days.length === 0
                  ? 'No stops yet'
                  : `${days.length} ${days.length === 1 ? 'day' : 'days'} · ${formatDistance(plannedKm, units)} planned`}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close plan"
              style={({ pressed }) => [styles.done, pressed && styles.pressed]}
            >
              <Text style={[styles.doneText, { color: colors.accent }]}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {days.length === 0 && (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                Tap the ⛺ on a campsite, hut or town to make it a stop. Each stop ends a day.
              </Text>
            )}
            {days.map((day) => (
              <PlanDayLine key={day.dayNumber} day={day} units={units} />
            ))}
            {unplanned !== null && <PlanDayLine day={unplanned} units={units} unplanned />}
          </ScrollView>

          <Pressable
            onPress={() => {
              onClose();
              onOpenPlanner();
            }}
            accessibilityRole="button"
            accessibilityLabel="Open planner"
            style={({ pressed }) => [
              styles.open,
              { backgroundColor: colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.openText, { color: colors.accentText }]}>Open planner</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * One day on a single compact row: "Day 3 · Hut A → Camp B", then distance,
 * climb and hours. `unplanned` draws the "not planned yet" stretch instead.
 * `label` replaces the "Day N" lead where the caller says something else
 * ("Walk in", "Walk on").
 */
export function PlanDayLine({
  day,
  units,
  unplanned = false,
  label,
}: {
  day: ComputedDay;
  units: Units;
  unplanned?: boolean;
  label?: string;
}) {
  const { colors } = useTheme();
  const lead = label ?? (unplanned ? 'Not planned yet' : `Day ${day.dayNumber}`);
  const date = !unplanned && day.date !== undefined ? ` · ${day.date}` : '';
  const rest =
    !unplanned && day.restDays !== undefined && day.restDays > 0
      ? ` · +${day.restDays} rest day${day.restDays === 1 ? '' : 's'}`
      : '';
  return (
    <View
      style={[
        styles.day,
        { borderColor: colors.border },
        unplanned && styles.dayUnplanned,
      ]}
      accessible
      accessibilityLabel={`${lead}: ${day.startName} to ${day.endName}, ${formatDistance(day.distanceKm, units)}`}
    >
      <Text
        style={[styles.dayRoute, { color: unplanned ? colors.textSecondary : colors.textPrimary }]}
        numberOfLines={1}
      >
        <Text style={styles.dayLead}>{lead}</Text>
        {` · ${day.startName} → ${day.endName}`}
      </Text>
      <Text style={[styles.dayStats, { color: colors.textSecondary }]}>
        {`${formatDistance(day.distanceKm, units)} · ↑ ${formatElevation(day.ascentM, units)} · ↓ ${formatElevation(day.descentM, units)} · ${formatHours(day.estimatedHours)}${date}${rest}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.lg,
    maxHeight: '85%',
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  headings: { flex: 1, gap: spacing.xs },
  title: { ...typography.titleLarge },
  subtitle: { ...typography.caption, fontVariant: ['tabular-nums'] },
  done: { minHeight: touchTarget.min, justifyContent: 'center', paddingHorizontal: spacing.sm },
  doneText: { ...typography.titleSmall },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  empty: { ...typography.bodySmall },
  day: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  dayUnplanned: { borderStyle: 'dashed', borderWidth: 1 },
  dayRoute: { ...typography.bodySmall },
  dayLead: { fontWeight: '700' },
  dayStats: { ...typography.caption, fontVariant: ['tabular-nums'] },
  open: {
    marginHorizontal: spacing.lg,
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
