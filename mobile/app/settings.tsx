import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../src/theme';
import { spacing, typography } from '../src/tokens';
import { SegmentedControl } from '../src/features/guide/SegmentedControl';
import { useSettingsStore, type Units } from '../src/state/settings-store';

const UNIT_OPTIONS = [
  { value: 'km' as const, label: 'Kilometres' },
  { value: 'mi' as const, label: 'Miles' },
];

export default function SettingsScreen() {
  const { colors } = useTheme();
  const units = useSettingsStore((s) => s.units);
  const setUnits = useSettingsStore((s) => s.setUnits);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.section}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Units</Text>
        <SegmentedControl<Units>
          options={UNIT_OPTIONS}
          value={units}
          onChange={setUnits}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.xl,
  },
  section: {
    gap: spacing.sm,
  },
  label: {
    ...typography.titleLarge,
  },
});
