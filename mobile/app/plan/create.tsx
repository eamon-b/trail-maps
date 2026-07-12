import { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { PressableRow, ScreenHeader } from '../../src/components';
import { PlanService } from '../../src/services/plan-service';
import { generateId } from '../../src/services/plan-utils';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/** Format as the plan-service YYYY-MM-DD contract (local date, not UTC) */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export default function CreatePlanScreen() {
  const { trailId, trailName } = useLocalSearchParams<{ trailId: string; trailName?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('My Plan');
  const [direction, setDirection] = useState<'NOBO' | 'SOBO'>('NOBO');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const canCreate = !saving;

  // Native picker: on Android the component IS the dialog — hide it on any
  // change event; on iOS the inline spinner stays until the row is tapped again.
  const handleDateChange = useCallback((event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (event.type !== 'dismissed' && date) {
      setStartDate(date);
    }
  }, []);

  async function handleCreate() {
    if (!trailId) {
      Alert.alert('Error', 'No trail selected');
      return;
    }
    const trimmedName = name.trim() || 'My Plan';

    setSaving(true);
    try {
      const service = await PlanService.create();
      const id = generateId();
      await service.createPlan({
        id,
        trailId,
        name: trimmedName,
        direction,
        startDate: startDate ? toIsoDate(startDate) : null,
        sectionJson: null,
        stopsJson: JSON.stringify([]),
      });
      router.replace({ pathname: '/plan/[planId]', params: { planId: id, trailId } });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to create plan');
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader title="New Plan" onBack={() => router.back()} backLabel="Cancel" />

      {trailName && (
        <Text style={[styles.trailLabel, { color: colors.textSecondary }]}>
          {trailName}
        </Text>
      )}

      {/* Form */}
      <View style={styles.form}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Plan Name</Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.textPrimary,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
          value={name}
          onChangeText={setName}
          placeholder="My Plan"
          placeholderTextColor={colors.textSecondary}
          selectTextOnFocus
          autoFocus
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Direction</Text>
        <View style={styles.directionRow}>
          <PressableRow
            onPress={() => setDirection('NOBO')}
            style={[
              styles.directionButton,
              {
                backgroundColor: direction === 'NOBO' ? colors.accent : colors.surface,
                borderColor: colors.border,
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: direction === 'NOBO' }}
          >
            <Text
              style={[
                styles.directionText,
                { color: direction === 'NOBO' ? colors.textInverse : colors.textPrimary },
              ]}
            >
              NOBO
            </Text>
          </PressableRow>
          <PressableRow
            onPress={() => setDirection('SOBO')}
            style={[
              styles.directionButton,
              {
                backgroundColor: direction === 'SOBO' ? colors.accent : colors.surface,
                borderColor: colors.border,
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: direction === 'SOBO' }}
          >
            <Text
              style={[
                styles.directionText,
                { color: direction === 'SOBO' ? colors.textInverse : colors.textPrimary },
              ]}
            >
              SOBO
            </Text>
          </PressableRow>
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>
          Start Date (optional)
        </Text>
        <View style={styles.dateRow}>
          <PressableRow
            onPress={() => setShowDatePicker((v) => !v)}
            accessibilityLabel={
              startDate
                ? `Start date ${formatDisplayDate(startDate)}. Tap to change.`
                : 'Set start date'
            }
            style={StyleSheet.flatten([
              styles.dateButton,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ])}
          >
            <Text
              style={[
                styles.dateButtonText,
                { color: startDate ? colors.textPrimary : colors.textSecondary },
              ]}
            >
              {startDate ? formatDisplayDate(startDate) : 'Set date…'}
            </Text>
          </PressableRow>
          {startDate && (
            <PressableRow
              onPress={() => setStartDate(null)}
              accessibilityLabel="Clear start date"
              style={styles.clearDateButton}
            >
              <Text style={[styles.clearDateText, { color: colors.accent }]}>Clear</Text>
            </PressableRow>
          )}
        </View>
        {showDatePicker && (
          <DateTimePicker
            value={startDate ?? new Date()}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleDateChange}
          />
        )}
      </View>

      {/* Create button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <PressableRow
          onPress={handleCreate}
          disabled={!canCreate}
          haptic="success"
          style={[styles.createButton, { backgroundColor: colors.accent, opacity: canCreate ? 1 : 0.6 }]}
          accessibilityLabel="Create plan"
        >
          <Text style={[styles.createText, { color: colors.textInverse }]}>
            {saving ? 'Creating...' : 'Create Plan'}
          </Text>
        </PressableRow>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  trailLabel: {
    ...typography.caption,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  form: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  label: {
    ...typography.caption,
    fontWeight: '600',
    marginBottom: spacing.xs,
    marginTop: spacing.lg,
  },
  input: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
  },
  directionRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  directionButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
  },
  directionText: {
    ...typography.body,
    fontWeight: '600',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  createButton: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
  },
  createText: {
    ...typography.body,
    fontWeight: '700',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  dateButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  dateButtonText: {
    ...typography.body,
  },
  clearDateButton: {
    paddingHorizontal: spacing.sm,
  },
  clearDateText: {
    ...typography.body,
    fontWeight: '600',
  },
});
