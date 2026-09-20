/**
 * The three controls that hang off a chosen stop: how many nights, a note, and
 * whether it is booked.
 *
 * One component, two homes — the expanded row in the Plan screen's Stops
 * section and the waypoint detail screen under its "Stop here" toggle. They
 * edit the same `PlanStop`, so sharing the controls is what keeps "2 nights"
 * meaning the same thing (one rest day, every later date pushed on) wherever
 * you set it.
 *
 * Presentational: the caller owns the plan and does the writing, through
 * `plans-store.apply` and the `@lib/plan-editor` setters that clamp and trim.
 * The note is the one stateful bit — it keeps a local draft and commits on
 * blur, because a SQLite write (and later a `PUT`) per keystroke is not worth
 * it for a field whose value only matters when you stop typing.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PLAN_LIMITS, type PlanStop } from '@lib/plan-types';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';

export interface StopEditorProps {
  stop: PlanStop;
  onNights: (nights: number) => void;
  /** Called on blur with the raw text; the editor trims and caps it. */
  onNote: (note: string) => void;
  onBooked: (booked: boolean) => void;
}

export function StopEditor({ stop, onNights, onNote, onBooked }: StopEditorProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.root}>
      <NightsStepper nights={stop.nights} onNights={onNights} />
      <NoteField note={stop.note} onNote={onNote} />
      <BookedToggle booked={stop.booked === true} onBooked={onBooked} />
      {stop.nights > 1 && (
        <Text style={[styles.helper, { color: colors.textSecondary }]}>
          {`${stop.nights} nights = ${stop.nights - 1} rest day${stop.nights === 2 ? '' : 's'} here`}
        </Text>
      )}
    </View>
  );
}

/** Nights at a stop: 1..`PLAN_LIMITS.nightsMax`. Two nights is one rest day. */
export function NightsStepper({
  nights,
  onNights,
}: {
  nights: number;
  onNights: (nights: number) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Nights</Text>
      <View style={styles.stepper}>
        <StepButton
          label="−"
          accessibilityLabel="Fewer nights"
          disabled={nights <= 1}
          onPress={() => onNights(nights - 1)}
        />
        <Text style={[styles.value, { color: colors.textPrimary }]}>{nights}</Text>
        <StepButton
          label="+"
          accessibilityLabel="More nights"
          disabled={nights >= PLAN_LIMITS.nightsMax}
          onPress={() => onNights(nights + 1)}
        />
      </View>
    </View>
  );
}

function NoteField({ note, onNote }: { note?: string; onNote: (note: string) => void }) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(note ?? '');
  // What the plan last told us the note was. A change to it that did NOT come
  // from this field (another screen, a sync) replaces the draft; our own commit
  // coming back does not, so the cursor is never yanked mid-edit.
  const known = useRef(note ?? '');
  useEffect(() => {
    const incoming = note ?? '';
    if (incoming !== known.current) {
      known.current = incoming;
      setDraft(incoming);
    }
  }, [note]);

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={() => {
        known.current = draft.trim().slice(0, PLAN_LIMITS.noteMax);
        onNote(draft);
      }}
      placeholder="Note (rang ahead, 2 beds…)"
      placeholderTextColor={colors.textSecondary}
      accessibilityLabel="Stop note"
      multiline
      maxLength={PLAN_LIMITS.noteMax}
      style={[
        styles.note,
        { color: colors.textPrimary, backgroundColor: colors.background, borderColor: colors.border },
      ]}
    />
  );
}

/** "Booked" — a hand tick, not a booking flow. */
export function BookedToggle({
  booked,
  onBooked,
}: {
  booked: boolean;
  onBooked: (booked: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => onBooked(!booked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: booked }}
      accessibilityLabel="Booked"
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.bookedRow, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.tick,
          {
            borderColor: booked ? colors.accent : colors.border,
            backgroundColor: booked ? colors.accent : 'transparent',
          },
        ]}
      >
        {booked && <Text style={[styles.tickGlyph, { color: colors.accentText }]}>✓</Text>}
      </View>
      <Text style={[styles.label, { color: colors.textPrimary }]}>Booked</Text>
    </Pressable>
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
  root: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { ...typography.bodySmall },
  helper: { ...typography.caption },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  value: {
    ...typography.titleSmall,
    minWidth: 32,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  note: {
    ...typography.bodySmall,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.sm,
    minHeight: touchTarget.min,
    textAlignVertical: 'top',
  },
  bookedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tick: {
    width: 22,
    height: 22,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickGlyph: { fontSize: glyphSizes.sm, fontWeight: '700' },
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
