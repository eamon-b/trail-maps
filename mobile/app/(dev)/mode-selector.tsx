import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { ModeSelector } from '../../src/components';
import { spacing } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';
import { modeLabels } from '../../src/tokens/themes';

export default function ModeSelectorScreen() {
  const { colors, mode, themeVariant } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ModeSelector />
      <View style={styles.info}>
        <Text style={[styles.infoText, { color: colors.textPrimary }]}>
          Current mode: {modeLabels[mode]}
        </Text>
        <Text style={[styles.infoText, { color: colors.textSecondary }]}>
          Theme variant: {themeVariant}
        </Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Tap the colored stripe at the top to expand the mode selector.
          Then tap a mode to switch. The stripe collapses after selection.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  info: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  infoText: {
    ...typography.body,
    fontWeight: '600',
  },
  hint: {
    ...typography.caption,
    marginTop: spacing.md,
  },
});
