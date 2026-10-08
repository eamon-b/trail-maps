/**
 * The plan's settings — name, start date, section, daily hours and pace — kept
 * out of the way of the plan itself.
 *
 * They are set once and then rarely touched, but they used to sit at the top
 * of the Plan screen, so every visit started with a scroll past them to reach
 * the days and stops. Now the screen shows one summary row
 * (`PlanSettingsSummary`); tapping it, or the ⚙ in the header, opens this
 * sheet with the same two cards as before (`PlanHeaderCard`,
 * `PlanInputsCard`). The screen still owns every value, so nothing about how
 * the plan is computed changed.
 *
 * A bottom-anchored `Modal`, like the app's other sheets, lifted over the
 * keyboard because the name and start date are text fields.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { KeyboardAvoidingModalContent } from '../../navigation/KeyboardAwareScrollView';
import type { Pace } from './plan-adapters';

const PACE_LABELS: Record<Pace, string> = {
  slow: 'Slow',
  average: 'Average',
  fast: 'Fast',
};

export interface PlanSettingsSummaryProps {
  /** The plan's name, else the trail's. */
  name: string;
  startDate: string | null;
  pace: Pace;
  dailyHours: number;
  /** "Whole trail" or "Start → End". */
  sectionLabel: string;
  directionLabel: string;
  onPress: () => void;
}

/** One tappable row standing in for the settings at the top of the Plan screen. */
export function PlanSettingsSummary(props: PlanSettingsSummaryProps) {
  const { colors } = useTheme();
  const when = props.startDate ? `Starts ${props.startDate}` : 'No start date';
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel="Plan settings"
      accessibilityHint="Name, start date, section, daily hours and pace"
      style={({ pressed }) => [
        styles.summary,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.summaryBody}>
        <Text style={[styles.summaryName, { color: colors.textPrimary }]} numberOfLines={1}>
          {props.name}
        </Text>
        <Text style={[styles.summaryLine, { color: colors.textSecondary }]} numberOfLines={1}>
          {`${when} · ${PACE_LABELS[props.pace]} pace · ${props.dailyHours} h/day`}
        </Text>
        <Text style={[styles.summaryLine, { color: colors.textSecondary }]} numberOfLines={1}>
          {`${props.sectionLabel} · ${props.directionLabel}`}
        </Text>
      </View>
      <Text style={[styles.edit, { color: colors.accent }]}>Edit</Text>
    </Pressable>
  );
}

export interface PlanSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function PlanSettingsSheet({ visible, onClose, children }: PlanSettingsSheetProps) {
  const { colors } = useTheme();
  const { bottom } = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingModalContent>
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
          accessibilityRole="button"
          accessibilityLabel="Close plan settings"
          onPress={onClose}
        >
          {/* Swallows taps on the sheet so a field or stepper never dismisses it. */}
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.background, paddingBottom: spacing.xl + bottom },
            ]}
            accessibilityViewIsModal
          >
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>Plan settings</Text>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close plan settings"
                style={({ pressed }) => [styles.done, pressed && styles.pressed]}
              >
                <Text style={[styles.doneText, { color: colors.accent }]}>Done</Text>
              </Pressable>
            </View>
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingModalContent>
    </Modal>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  summaryBody: { flex: 1, gap: 2 },
  summaryName: { ...typography.titleSmall },
  summaryLine: { ...typography.caption, fontVariant: ['tabular-nums'] },
  edit: { ...typography.bodySmall, fontWeight: '700' },

  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.lg,
    maxHeight: '90%',
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  title: { ...typography.titleLarge },
  done: { minHeight: touchTarget.min, justifyContent: 'center', paddingHorizontal: spacing.sm },
  doneText: { ...typography.titleSmall },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  pressed: { opacity: 0.6 },
});
