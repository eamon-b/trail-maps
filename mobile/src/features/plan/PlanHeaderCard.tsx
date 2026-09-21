/**
 * The plan's own details: what it is called, when it starts, and which way it
 * is walked.
 *
 * Direction is shown, not set. It belongs to the guide (the map, the list and
 * the elevation profile are all already flipped by it), and a plan that could
 * disagree with the guide it is displayed in would put two km scales on one
 * screen. The screen keeps the document in step by writing the guide's
 * direction into it; stop km never move, because they are stored NOBO
 * (`@lib/plan-direction`).
 *
 * The start date is a plain `YYYY-MM-DD` field rather than a native picker:
 * `@react-native-community/datetimepicker` is native code, so it needs a new
 * dev build, and the planner must work in the Jest suite and in a build without
 * it. `@lib/plan-editor`'s `isIsoDate` is the same validator the editor throws
 * on, so nothing the field accepts can reach the date cascade and render
 * "Invalid Date" in every day card.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { isIsoDate } from '@lib/plan-editor';
import { PLAN_LIMITS } from '@lib/plan-types';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';

/** `YYYY-MM-DD` — the field's `maxLength`, and where "half-typed" ends. */
const ISO_DATE_LENGTH = 10;

export interface PlanHeaderCardProps {
  name: string;
  /** Shown when the plan is unnamed — normally the trail's name. */
  namePlaceholder: string;
  startDate: string | null;
  /** How the guide describes the direction being walked, e.g. "Northbound". */
  directionLabel: string;
  onName: (name: string) => void;
  /** Called only with a real `YYYY-MM-DD` date, or null to clear it. */
  onStartDate: (iso: string | null) => void;
}

export function PlanHeaderCard(props: PlanHeaderCardProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <NameField
        name={props.name}
        placeholder={props.namePlaceholder}
        onName={props.onName}
      />
      <StartDateField startDate={props.startDate} onStartDate={props.onStartDate} />
      <Text style={[styles.direction, { color: colors.textSecondary }]}>
        {`Direction: ${props.directionLabel} — set in the guide`}
      </Text>
    </View>
  );
}

function NameField({
  name,
  placeholder,
  onName,
}: {
  name: string;
  placeholder: string;
  onName: (name: string) => void;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(name);
  const known = useRef(name);
  useEffect(() => {
    if (name !== known.current) {
      known.current = name;
      setDraft(name);
    }
  }, [name]);

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={() => {
        known.current = draft.trim().slice(0, PLAN_LIMITS.nameMax);
        onName(draft);
      }}
      placeholder={placeholder}
      placeholderTextColor={colors.textSecondary}
      accessibilityLabel="Plan name"
      maxLength={PLAN_LIMITS.nameMax}
      style={[styles.nameInput, { color: colors.textPrimary, borderBottomColor: colors.border }]}
    />
  );
}

function StartDateField({
  startDate,
  onStartDate,
}: {
  startDate: string | null;
  onStartDate: (iso: string | null) => void;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(startDate ?? '');
  const [error, setError] = useState(false);
  const known = useRef(startDate ?? '');
  useEffect(() => {
    const incoming = startDate ?? '';
    if (incoming !== known.current) {
      known.current = incoming;
      setDraft(incoming);
      setError(false);
    }
  }, [startDate]);

  // Committed as you type once it is a real date: a ten-character field is
  // finished the moment it is valid, and waiting for a blur that may never come
  // (the hiker scrolls straight to the day cards) would leave the dates blank
  // with the date apparently entered.
  const commit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') {
      known.current = '';
      setError(false);
      onStartDate(null);
      return;
    }
    if (isIsoDate(trimmed)) {
      known.current = trimmed;
      setError(false);
      onStartDate(trimmed);
      return;
    }
    setError(true);
  };

  // Leaving the field ends the edit, so a value the plan never took cannot stay
  // in it: half a date sitting under a red border reads as entered, and the day
  // cards would be counting from the old one. Putting the plan's own date back
  // is the only outcome that leaves field and document saying the same thing.
  const finish = () => {
    const trimmed = draft.trim();
    if (trimmed === '' || isIsoDate(trimmed)) {
      commit(draft);
      return;
    }
    const current = startDate ?? '';
    known.current = current;
    setDraft(current);
    setError(false);
  };

  return (
    <View style={styles.dateRow}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Start date</Text>
      <View style={styles.dateField}>
        <TextInput
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            const trimmed = text.trim();
            // Measured before the narrowing: `isIsoDate` asserts `string`, so
            // TypeScript has nothing left of `trimmed` in the else branch.
            const fullLength = trimmed.length >= ISO_DATE_LENGTH;
            // Commit the moment it becomes a real date (or is cleared); a
            // half-typed one only clears any error, so the field never nags
            // while you are still typing it. A full ten characters that still
            // is not a date (2026-02-31) is finished and wrong, and saying so
            // there is the only chance to — leaving the field puts the plan's
            // own date back.
            if (trimmed === '' || isIsoDate(trimmed)) commit(text);
            else if (fullLength) setError(true);
            else if (error) setError(false);
          }}
          onBlur={finish}
          onSubmitEditing={finish}
          onEndEditing={finish}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Start date"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          maxLength={ISO_DATE_LENGTH}
          style={[
            styles.dateInput,
            {
              color: colors.textPrimary,
              backgroundColor: colors.background,
              borderColor: error ? colors.danger : colors.border,
            },
          ]}
        />
        {error && (
          <Text style={[styles.error, { color: colors.danger }]}>
            Use YYYY-MM-DD, e.g. 2026-10-01.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  nameInput: {
    ...typography.titleLarge,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
  },
  dateRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  label: { ...typography.bodySmall, paddingTop: spacing.md },
  dateField: { flex: 1, gap: spacing.xs },
  dateInput: {
    ...typography.bodySmall,
    fontVariant: ['tabular-nums'],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    minHeight: touchTarget.min,
  },
  error: { ...typography.caption },
  direction: { ...typography.caption },
});
