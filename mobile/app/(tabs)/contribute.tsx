import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme';
import { typography } from '../../src/tokens/typography';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';

export default function ContributeScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.accent }]}>Contribute</Text>

      <Pressable
        onPress={() => router.push('/import')}
        style={[styles.importButton, { backgroundColor: colors.accent }]}
        accessibilityRole="button"
        accessibilityLabel="Import a GPX trail"
      >
        <Text style={styles.importButtonText}>Import GPX Trail</Text>
      </Pressable>

      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Import your own GPX files to plan and navigate custom trails.
      </Text>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <Text style={[styles.comingSoon, { color: colors.textSecondary }]}>
        Community features — trail condition reports, water source updates, and waypoint
        contributions — are coming in v2.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    ...typography.displayLarge,
    marginBottom: spacing.lg,
  },
  importButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    minHeight: touchTarget.min,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  importButtonText: {
    ...typography.body,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  subtitle: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '60%',
    marginBottom: spacing.lg,
  },
  comingSoon: {
    ...typography.caption,
    textAlign: 'center',
    lineHeight: 20,
  },
});
