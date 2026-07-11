import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { ScreenHeader } from '../../src/components';
import { PlanService } from '../../src/services/plan-service';
import { generateId } from '../../src/services/plan-utils';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export default function CreatePlanScreen() {
  const { trailId, trailName } = useLocalSearchParams<{ trailId: string; trailName?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('My Plan');
  const [direction, setDirection] = useState<'NOBO' | 'SOBO'>('NOBO');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);

  const dateError = (() => {
    if (!startDate) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return 'Use YYYY-MM-DD format';
    const d = new Date(startDate + 'T12:00:00Z');
    if (isNaN(d.getTime())) return 'Invalid date';
    return null;
  })();
  const canCreate = !saving && !dateError;

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
        startDate: startDate || null,
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
          <Pressable
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
          </Pressable>
          <Pressable
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
          </Pressable>
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>
          Start Date (optional)
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.textPrimary,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
          value={startDate}
          onChangeText={setStartDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textSecondary}
          keyboardType="numbers-and-punctuation"
        />
        {dateError && (
          <Text style={[styles.dateError, { color: colors.danger }]}>
            {dateError}
          </Text>
        )}
      </View>

      {/* Create button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Pressable
          onPress={handleCreate}
          disabled={!canCreate}
          style={[styles.createButton, { backgroundColor: colors.accent, opacity: canCreate ? 1 : 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Create plan"
        >
          <Text style={[styles.createText, { color: colors.textInverse }]}>
            {saving ? 'Creating...' : 'Create Plan'}
          </Text>
        </Pressable>
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
  dateError: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
});
