import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import {
  resolveTheme,
  themeVariants,
  appModes,
  themeLabels,
  modeLabels,
  type ThemeVariant,
  type AppMode,
  type ThemeColors,
} from '../../src/tokens/themes';
import { spacing, touchTarget, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/** Token names to display */
const COLOR_TOKENS: (keyof ThemeColors)[] = [
  'background',
  'surface',
  'surfaceElevated',
  'textPrimary',
  'textSecondary',
  'textInverse',
  'border',
  'borderSubtle',
  'accent',
  'accentSubtle',
  'accentMuted',
  'accentOnDark',
  'accentOnLight',
  'alertGreen',
  'alertAmber',
  'alertRed',
];

export default function ColorsScreen() {
  const { colors: currentColors } = useTheme();
  const [selectedTheme, setSelectedTheme] = useState<ThemeVariant>('light');
  const [selectedMode, setSelectedMode] = useState<AppMode>('plan');

  const resolvedColors = resolveTheme(selectedTheme, selectedMode);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: currentColors.background }]}
      contentContainerStyle={styles.content}
    >
      {/* Theme selector */}
      <Text style={[styles.sectionHeader, { color: currentColors.textSecondary }]}>Theme</Text>
      <View style={styles.chipRow}>
        {themeVariants.map((t) => (
          <Pressable
            key={t}
            onPress={() => setSelectedTheme(t)}
            style={[
              styles.chip,
              {
                backgroundColor: selectedTheme === t ? currentColors.accent : currentColors.surface,
                borderColor: currentColors.border,
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ checked: selectedTheme === t }}
          >
            <Text style={{
              ...typography.caption,
              color: selectedTheme === t ? currentColors.textInverse : currentColors.textPrimary,
              fontWeight: '600',
            }}>
              {themeLabels[t]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Mode selector */}
      <Text style={[styles.sectionHeader, { color: currentColors.textSecondary }]}>Mode</Text>
      <View style={styles.chipRow}>
        {appModes.map((m) => (
          <Pressable
            key={m}
            onPress={() => setSelectedMode(m)}
            style={[
              styles.chip,
              {
                backgroundColor: selectedMode === m ? currentColors.accent : currentColors.surface,
                borderColor: currentColors.border,
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ checked: selectedMode === m }}
          >
            <Text style={{
              ...typography.caption,
              color: selectedMode === m ? currentColors.textInverse : currentColors.textPrimary,
              fontWeight: '600',
            }}>
              {modeLabels[m]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Color swatches */}
      <Text style={[styles.sectionHeader, { color: currentColors.textSecondary }]}>
        {themeLabels[selectedTheme]} × {modeLabels[selectedMode]}
      </Text>
      {COLOR_TOKENS.map((token) => {
        const colorValue = resolvedColors[token];
        if (typeof colorValue !== 'string') return null;
        return (
          <View key={token} style={styles.swatchRow}>
            <View style={[styles.swatch, { backgroundColor: colorValue, borderColor: currentColors.border }]} />
            <View style={styles.swatchInfo}>
              <Text style={[styles.tokenName, { color: currentColors.textPrimary }]}>{token}</Text>
              <Text style={[styles.tokenValue, { color: currentColors.textSecondary }]}>{colorValue}</Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    ...typography.titleLarge,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  chip: {
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  swatchInfo: {
    flex: 1,
  },
  tokenName: {
    ...typography.body,
    fontWeight: '600',
  },
  tokenValue: {
    ...typography.caption,
    fontFamily: 'monospace',
  },
});
