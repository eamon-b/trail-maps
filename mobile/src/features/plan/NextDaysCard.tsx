/**
 * "Next days" — plan the next few nights from where you are.
 *
 * The planner is mostly used on the trail, a few days at a time, so this card
 * asks for a start (your GPS km, else your last stop), a number of days and
 * the hiker's idea of a good day, and offers ranked alternative plans. Each is
 * a complete few-day sequence you can read in one go. "Use this plan" puts its
 * stops into the document, replacing only the stops inside its window.
 *
 * Two ways of saying what a good day is (`plan-suggest.ts`):
 * - *Hours & pace*: the daily hours and pace from the card above.
 * - *Distance & climb*: km, ascent and hours ranges, each switchable.
 *
 * Presentational: the screen runs the search and owns the plan.
 */

import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { SuggestDaysResult, SuggestedPlan } from '@lib/day-suggest';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { SegmentedControl } from '../guide/SegmentedControl';
import { formatHours } from './plan-format';
import {
  MAX_ALTERNATIVES_SHOWN,
  MAX_SUGGEST_DAYS,
  type RangePref,
  type SearchCandidate,
  type SuggestMode,
  type SuggestPrefs,
  type SuggestStart,
} from './plan-suggest';

const MODE_OPTIONS: { value: SuggestMode; label: string }[] = [
  { value: 'hours', label: 'Hours & pace' },
  { value: 'ranges', label: 'Distance & climb' },
];

const KM_PER_MILE = 1.609344;
const METRES_PER_FOOT = 0.3048;

export interface NextDaysCardProps {
  prefs: SuggestPrefs;
  onPrefs: (prefs: SuggestPrefs) => void;
  start: SuggestStart;
  /** Whether a GPS fix could be used as the start (shows the Here/Last stop switch). */
  hasFix: boolean;
  /** GPS not started yet: offer to start it. */
  onUseLocation?: () => void;
  preferLastStop: boolean;
  onPreferLastStop: (preferLastStop: boolean) => void;
  dailyHours: number;
  units: Units;
  /** `undefined` before the hiker asks; the result of the last search after. */
  result: SuggestDaysResult<SearchCandidate> | undefined;
  /** Why no search can run, e.g. "Switch on at least one range with a maximum". */
  blocked: string | null;
  onSuggest: () => void;
  onApply: (plan: SuggestedPlan<SearchCandidate>) => void;
}

export function NextDaysCard(props: NextDaysCardProps) {
  const { colors } = useTheme();
  const { prefs, onPrefs, start, units, result } = props;
  const set = (patch: Partial<SuggestPrefs>) => onPrefs({ ...prefs, ...patch });

  const kmStep = units === 'mi' ? KM_PER_MILE : 1;
  const ascentStep = units === 'mi' ? 250 * METRES_PER_FOOT : 100;

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Plan the next few days</Text>

      <View style={styles.row}>
        <View style={styles.fromBody}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>From</Text>
          <Text style={[styles.value, { color: colors.textPrimary }]} numberOfLines={1}>
            {`${startLabel(start)} · ${formatDistance(start.km, units)}`}
          </Text>
        </View>
        {props.hasFix ? (
          <Pressable
            onPress={() => props.onPreferLastStop(!props.preferLastStop)}
            accessibilityRole="button"
            accessibilityLabel={
              props.preferLastStop ? 'Start from my location' : 'Start from my last stop'
            }
            hitSlop={spacing.sm}
          >
            <Text style={[styles.link, { color: colors.accent }]}>
              {props.preferLastStop ? 'From here' : 'From last stop'}
            </Text>
          </Pressable>
        ) : (
          props.onUseLocation && (
            <Pressable
              onPress={props.onUseLocation}
              accessibilityRole="button"
              accessibilityLabel="Use my location"
              hitSlop={spacing.sm}
            >
              <Text style={[styles.link, { color: colors.accent }]}>Use my location</Text>
            </Pressable>
          )
        )}
      </View>

      <Stepper
        label="Days"
        value={String(prefs.days)}
        canDown={prefs.days > 1}
        canUp={prefs.days < MAX_SUGGEST_DAYS}
        onDown={() => set({ days: prefs.days - 1 })}
        onUp={() => set({ days: prefs.days + 1 })}
      />
      <Stepper
        label="Options"
        value={String(prefs.alternatives)}
        canDown={prefs.alternatives > 1}
        canUp={prefs.alternatives < MAX_ALTERNATIVES_SHOWN}
        onDown={() => set({ alternatives: prefs.alternatives - 1 })}
        onUp={() => set({ alternatives: prefs.alternatives + 1 })}
      />

      <SegmentedControl
        options={MODE_OPTIONS}
        value={prefs.mode}
        onChange={(mode) => set({ mode })}
      />

      {prefs.mode === 'hours' ? (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {`Days of about ${formatHours(props.dailyHours)} at your pace, ending at a camp, hut or town.`}
        </Text>
      ) : (
        <View style={styles.ranges}>
          <RangeRow
            label="Distance"
            range={prefs.distance}
            step={kmStep}
            format={(km) => formatDistance(km, units, { decimals: 0 })}
            onChange={(distance) => set({ distance })}
          />
          <RangeRow
            label="Ascent"
            range={prefs.ascent}
            step={ascentStep}
            format={(m) => formatElevation(m, units)}
            onChange={(ascent) => set({ ascent })}
          />
          <RangeRow
            label="Hours"
            range={prefs.hours}
            step={0.5}
            format={formatHours}
            onChange={(hours) => set({ hours })}
          />
        </View>
      )}

      <Pressable
        onPress={props.onSuggest}
        disabled={props.blocked !== null}
        accessibilityRole="button"
        accessibilityLabel="Suggest plans"
        accessibilityState={{ disabled: props.blocked !== null }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.accent },
          pressed && styles.pressed,
          props.blocked !== null && styles.disabled,
        ]}
      >
        <Text style={[styles.buttonLabel, { color: colors.accentText }]}>Suggest plans</Text>
      </Pressable>
      {props.blocked !== null && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>{props.blocked}</Text>
      )}

      {result !== undefined && <Results result={result} units={units} onApply={props.onApply} />}
    </View>
  );
}

function startLabel(start: SuggestStart): string {
  return start.kind === 'here' ? 'Here' : start.name;
}

function Results({
  result,
  units,
  onApply,
}: {
  result: SuggestDaysResult<SearchCandidate>;
  units: Units;
  onApply: (plan: SuggestedPlan<SearchCandidate>) => void;
}) {
  const { colors } = useTheme();
  if (result.plans.length === 0) {
    return (
      <Text style={[styles.hint, { color: colors.warning }]} accessibilityRole="alert">
        No camp, hut or town fits a first day on those settings. Widen a range and try again.
      </Text>
    );
  }
  return (
    <View style={styles.results}>
      {result.shortOf !== undefined && (
        <Text style={[styles.hint, { color: colors.warning }]}>
          {`Only ${result.shortOf} day${result.shortOf === 1 ? '' : 's'} fit these settings from here. Nothing is in range after that.`}
        </Text>
      )}
      {result.plans.map((plan, i) => (
        <View
          key={plan.days.map((d) => d.endKm).join('|')}
          style={[styles.option, { borderColor: i === 0 ? colors.accent : colors.border }]}
          accessibilityLabel={`Option ${i + 1}`}
        >
          <Text style={[styles.optionHead, { color: colors.textPrimary }]}>
            {`Option ${i + 1}${i === 0 ? ' · closest to your targets' : ''}`}
          </Text>
          {plan.days.map((day, d) => (
            <View key={d} style={styles.dayRow}>
              <Text style={[styles.dayName, { color: colors.textPrimary }]} numberOfLines={1}>
                {`Day ${d + 1} → ${day.end ? day.end.candidate.name : 'End of section'}`}
              </Text>
              <Text style={[styles.dayStats, { color: colors.textSecondary }]}>
                {`${formatDistance(day.distanceKm, units)} · ↑ ${formatElevation(day.ascentM, units)} · ${formatHours(
                  Math.round(day.hours * 10) / 10,
                )}`}
              </Text>
            </View>
          ))}
          <Pressable
            onPress={() => onApply(plan)}
            accessibilityRole="button"
            accessibilityLabel={`Use option ${i + 1}`}
            hitSlop={spacing.xs}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={[styles.link, { color: colors.accent }]}>Use this plan</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function RangeRow({
  label,
  range,
  step,
  format,
  onChange,
}: {
  label: string;
  range: RangePref;
  step: number;
  format: (value: number) => string;
  onChange: (range: RangePref) => void;
}) {
  const { colors } = useTheme();
  // Snap to the step so imperial steps land on whole miles / 250 ft marks.
  const snap = (value: number) => Math.max(0, Math.round(value / step) * step);
  return (
    <View style={styles.rangeBlock}>
      <View style={styles.row}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
        <Switch
          value={range.on}
          onValueChange={(on) => onChange({ ...range, on })}
          accessibilityLabel={`Use ${label.toLowerCase()} range`}
          accessibilityRole="switch"
        />
      </View>
      {range.on && (
        <View style={styles.rangeSteppers}>
          <MiniStepper
            label={`Minimum ${label.toLowerCase()}`}
            value={format(range.min)}
            canDown={range.min > 0}
            canUp={range.min + step <= range.max + 1e-9}
            onDown={() => onChange({ ...range, min: snap(range.min - step) })}
            onUp={() => onChange({ ...range, min: snap(range.min + step) })}
          />
          <Text style={[styles.label, { color: colors.textSecondary }]}>to</Text>
          <MiniStepper
            label={`Maximum ${label.toLowerCase()}`}
            value={format(range.max)}
            canDown={range.max - step >= range.min - 1e-9}
            canUp
            onDown={() => onChange({ ...range, max: snap(range.max - step) })}
            onUp={() => onChange({ ...range, max: snap(range.max + step) })}
          />
        </View>
      )}
    </View>
  );
}

function Stepper({
  label,
  value,
  canDown,
  canUp,
  onDown,
  onUp,
}: {
  label: string;
  value: string;
  canDown: boolean;
  canUp: boolean;
  onDown: () => void;
  onUp: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <MiniStepper
        label={label}
        value={value}
        canDown={canDown}
        canUp={canUp}
        onDown={onDown}
        onUp={onUp}
      />
    </View>
  );
}

function MiniStepper({
  label,
  value,
  canDown,
  canUp,
  onDown,
  onUp,
}: {
  label: string;
  value: string;
  canDown: boolean;
  canUp: boolean;
  onDown: () => void;
  onUp: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.stepper}>
      <StepButton
        glyph="−"
        accessibilityLabel={`Less ${label.toLowerCase()}`}
        disabled={!canDown}
        onPress={onDown}
      />
      <Text style={[styles.stepValue, { color: colors.textPrimary }]}>{value}</Text>
      <StepButton
        glyph="+"
        accessibilityLabel={`More ${label.toLowerCase()}`}
        disabled={!canUp}
        onPress={onUp}
      />
    </View>
  );
}

function StepButton({
  glyph,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  glyph: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.stepButton,
        { backgroundColor: colors.background, borderColor: colors.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.stepGlyph, { color: disabled ? colors.textSecondary : colors.accent }]}>
        {glyph}
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
  heading: { ...typography.titleSmall },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  fromBody: { flex: 1, gap: 2 },
  label: { ...typography.bodySmall },
  value: { ...typography.bodySmall, fontWeight: '600' },
  link: { ...typography.bodySmall, fontWeight: '700' },
  hint: { ...typography.caption },
  ranges: { gap: spacing.md },
  rangeBlock: { gap: spacing.sm },
  rangeSteppers: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepValue: {
    ...typography.bodySmall,
    fontWeight: '600',
    minWidth: 56,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  stepButton: {
    width: touchTarget.min,
    height: touchTarget.min,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontSize: glyphSizes.md, fontWeight: '700' },
  button: {
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonLabel: { ...typography.bodySmall, fontWeight: '700' },
  results: { gap: spacing.md },
  option: { borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  optionHead: { ...typography.bodySmall, fontWeight: '700' },
  dayRow: { gap: 2 },
  dayName: { ...typography.bodySmall },
  dayStats: { ...typography.caption, fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
});
