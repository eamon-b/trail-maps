/**
 * Plan inputs — section start/end (waypoint steppers), daily hours (± stepper),
 * and pace (segmented control). Presentational: the screen owns the state.
 *
 * Waypoint steppers (not sliders) are deliberate: section hikers pick real
 * named endpoints ("Prevelly → Gracetown"), the boundaries snap to actual
 * waypoints for free, and discrete ◀/▶ taps drive cleanly over adb with no
 * fiddly drag.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { SegmentedControl } from '../guide/SegmentedControl';
import type { Pace, WaypointOption } from './plan-adapters';
import { MAX_DAILY_HOURS, MIN_DAILY_HOURS } from './plan-inputs-store';

const PACE_OPTIONS: { value: Pace; label: string }[] = [
  { value: 'slow', label: 'Slow' },
  { value: 'average', label: 'Average' },
  { value: 'fast', label: 'Fast' },
];

export interface PlanInputsCardProps {
  options: WaypointOption[];
  startIdx: number;
  endIdx: number;
  dailyHours: number;
  pace: Pace;
  units: Units;
  onStartIdx: (idx: number) => void;
  onEndIdx: (idx: number) => void;
  onDailyHours: (hours: number) => void;
  onPace: (pace: Pace) => void;
  onResetSection: () => void;
}

export function PlanInputsCard(props: PlanInputsCardProps) {
  const { colors } = useTheme();
  const { options, startIdx, endIdx, dailyHours, pace, units } = props;
  const start = options[startIdx];
  const end = options[endIdx];
  // With fewer than two options there is no section to narrow, so the reset chip
  // is meaningless — and endIdx (0) !== options.length - 1 (-1 for an empty set)
  // would otherwise render it spuriously. Treat any degenerate set as full trail.
  const isFullTrail = options.length < 2 || (startIdx === 0 && endIdx === options.length - 1);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.headRow}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Section</Text>
        {!isFullTrail && (
          <Pressable
            onPress={props.onResetSection}
            accessibilityRole="button"
            accessibilityLabel="Reset to full trail"
            hitSlop={spacing.sm}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={[styles.reset, { color: colors.accent }]}>Full trail</Text>
          </Pressable>
        )}
      </View>

      <BoundaryRow
        label="Start"
        name={start?.name ?? '—'}
        km={start?.km ?? 0}
        units={units}
        canPrev={startIdx > 0}
        canNext={startIdx < endIdx - 1}
        onPrev={() => props.onStartIdx(startIdx - 1)}
        onNext={() => props.onStartIdx(startIdx + 1)}
      />
      <BoundaryRow
        label="End"
        name={end?.name ?? '—'}
        km={end?.km ?? 0}
        units={units}
        canPrev={endIdx > startIdx + 1}
        canNext={endIdx < options.length - 1}
        onPrev={() => props.onEndIdx(endIdx - 1)}
        onNext={() => props.onEndIdx(endIdx + 1)}
      />

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.hoursRow}>
        <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Daily hours</Text>
        <View style={styles.stepper}>
          <StepButton
            label="−"
            accessibilityLabel="Fewer daily hours"
            disabled={dailyHours <= MIN_DAILY_HOURS}
            onPress={() => props.onDailyHours(dailyHours - 1)}
          />
          <Text style={[styles.hoursValue, { color: colors.textPrimary }]}>{dailyHours} h</Text>
          <StepButton
            label="+"
            accessibilityLabel="More daily hours"
            disabled={dailyHours >= MAX_DAILY_HOURS}
            onPress={() => props.onDailyHours(dailyHours + 1)}
          />
        </View>
      </View>

      <View style={styles.paceRow}>
        <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Pace</Text>
        <SegmentedControl options={PACE_OPTIONS} value={pace} onChange={props.onPace} />
      </View>
    </View>
  );
}

function BoundaryRow({
  label,
  name,
  km,
  units,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  label: string;
  name: string;
  km: number;
  units: Units;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.boundaryRow}>
      <StepButton label="◀" accessibilityLabel={`Previous ${label}`} disabled={!canPrev} onPress={onPrev} />
      <View style={styles.boundaryLabel}>
        <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>{label}</Text>
        <Text style={[styles.boundaryName, { color: colors.textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.boundaryKm, { color: colors.textSecondary }]}>
          {formatDistance(km, units)}
        </Text>
      </View>
      <StepButton label="▶" accessibilityLabel={`Next ${label}`} disabled={!canNext} onPress={onNext} />
    </View>
  );
}

function StepButton({
  label,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.stepButton,
        { backgroundColor: colors.background, borderColor: colors.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.stepGlyph, { color: disabled ? colors.textSecondary : colors.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { ...typography.titleSmall },
  reset: { ...typography.bodySmall, fontWeight: '700' },

  boundaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  boundaryLabel: { flex: 1, alignItems: 'center', gap: spacing.xs },
  boundaryName: { ...typography.titleSmall, textAlign: 'center' },
  boundaryKm: { ...typography.caption, fontVariant: ['tabular-nums'] },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.xs },

  hoursRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  paceRow: { gap: spacing.sm },
  rowLabel: { ...typography.bodySmall },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  hoursValue: { ...typography.titleSmall, minWidth: 48, textAlign: 'center', fontVariant: ['tabular-nums'] },

  stepButton: {
    width: touchTarget.min,
    height: touchTarget.min,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontSize: glyphSizes.md, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
});
