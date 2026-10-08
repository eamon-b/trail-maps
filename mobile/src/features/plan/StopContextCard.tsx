/**
 * A place's part in the plan, on its waypoint screen: the day that ends here and
 * the one that leaves from here.
 *
 * Shown for a stop of the plan ("Stop on your plan") and, for a place you can
 * sleep, before it is one ("If you stop here", the days the plan would have
 * with it added — `plan-glance` `stopContextIfStopped`). Tapping ⛺ flips one
 * into the other, so the hiker sees what the stop did to their days without
 * leaving the screen. "View whole plan" opens the glance sheet.
 *
 * Presentational: the screen works out the context and owns the plan.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import type { StopContext } from './plan-glance';
import { PlanDayLine } from './PlanGlanceSheet';

export interface StopContextCardProps {
  isStop: boolean;
  /** The days either side; null when they cannot be worked out. */
  context: StopContext | null;
  units: Units;
  /** Make the place a stop. Omitted when it already is one, or cannot be. */
  onStopHere?: () => void;
  onViewPlan: () => void;
  /** The stop's own controls (nights, note, booked), under the days. */
  children?: React.ReactNode;
}

export function StopContextCard({
  isStop,
  context,
  units,
  onStopHere,
  onViewPlan,
  children,
}: StopContextCardProps) {
  const { colors } = useTheme();
  const arrive = context?.arrive ?? null;
  const depart = context?.depart ?? null;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: isStop ? colors.waypointCamp : colors.border },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {isStop ? 'Stop on your plan' : 'If you stop here'}
        </Text>
        <Pressable
          onPress={onViewPlan}
          accessibilityRole="button"
          accessibilityLabel="View whole plan"
          hitSlop={spacing.sm}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={[styles.link, { color: colors.accent }]}>View whole plan</Text>
        </Pressable>
      </View>

      {arrive && <PlanDayLine day={arrive} units={units} />}
      {depart && (
        <PlanDayLine
          day={depart}
          units={units}
          unplanned={context?.departUnplanned ?? false}
          label={context?.departUnplanned ? 'Then, not planned yet' : undefined}
        />
      )}

      {onStopHere && (
        <Pressable
          onPress={onStopHere}
          accessibilityRole="button"
          accessibilityLabel="Stop here"
          style={({ pressed }) => [
            styles.button,
            { borderColor: colors.waypointCamp },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.waypointCamp }]}>⛺ Stop here</Text>
        </Pressable>
      )}

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: { ...typography.titleSmall, flexShrink: 1 },
  link: { ...typography.bodySmall, fontWeight: '700' },
  button: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
