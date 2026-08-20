/**
 * App settings — units, the account section where the comment display name can
 * be renamed (the promise the first-post prompt makes), and About, which
 * carries the privacy-policy link the app stores require in-app.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../src/theme';
import { spacing, typography } from '../src/tokens';
import { SegmentedControl } from '../src/features/guide/SegmentedControl';
import { DisplayNameSection } from '../src/features/settings/DisplayNameSection';
import { DeleteAccountSection } from '../src/features/settings/DeleteAccountSection';
import { AboutSection } from '../src/features/settings/AboutSection';
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
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.section}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Units</Text>
        <SegmentedControl<Units>
          options={UNIT_OPTIONS}
          value={units}
          onChange={setUnits}
        />
      </View>

      <DisplayNameSection />
      <DeleteAccountSection />
      {/* Last: About is always visible, while the two account sections above
          hide themselves on a device with no identity. */}
      <AboutSection />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
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
