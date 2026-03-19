import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../src/theme';
import type { ThemeVariant } from '../src/tokens/themes';
import { spacing, radii, touchTarget } from '../src/tokens/spacing';
import { typography } from '../src/tokens/typography';
import { closeDatabase } from '../src/db/database';
import { Paths, File } from 'expo-file-system';

const ALERT_THRESHOLD_KEY = 'trail-companion:alertThreshold';

type AlertPreset = 'tight' | 'normal' | 'loose';

const THEME_OPTIONS: { label: string; value: ThemeVariant | 'system' }[] = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'OLED', value: 'oled' },
];

const ALERT_OPTIONS: { label: string; value: AlertPreset; description: string }[] = [
  { label: 'Tight', value: 'tight', description: '30m on-trail, 100m drift' },
  { label: 'Normal', value: 'normal', description: '50m on-trail, 200m drift' },
  { label: 'Loose', value: 'loose', description: '100m on-trail, 300m drift' },
];

export default function SettingsScreen() {
  const {
    colors,
    themeVariant,
    setThemeVariant,
    autoDarkMode,
    setAutoDarkMode,
    nightRedEnabled,
    setNightRedEnabled,
    highContrast,
    setHighContrast,
  } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [alertPreset, setAlertPreset] = useState<AlertPreset>('normal');

  // Load persisted alert threshold preference
  useEffect(() => {
    AsyncStorage.getItem(ALERT_THRESHOLD_KEY).then((val) => {
      if (val === 'tight' || val === 'normal' || val === 'loose') {
        setAlertPreset(val);
      }
    });
  }, []);

  const handleAlertSelect = useCallback(async (value: AlertPreset) => {
    setAlertPreset(value);
    await AsyncStorage.setItem(ALERT_THRESHOLD_KEY, value);
  }, []);

  const currentThemeValue: ThemeVariant | 'system' = autoDarkMode ? 'system' : themeVariant;

  const handleThemeSelect = useCallback(
    (value: ThemeVariant | 'system') => {
      if (value === 'system') {
        setAutoDarkMode(true);
      } else {
        setThemeVariant(value);
      }
    },
    [setAutoDarkMode, setThemeVariant],
  );

  const handleResetData = useCallback(() => {
    Alert.alert(
      'Reset App Data',
      'This will delete all trail data, plans, and settings. The app will restart. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await closeDatabase();
              for (const name of ['trail-companion.db', 'trail-companion.db-wal', 'trail-companion.db-shm']) {
                try {
                  const f = new File(Paths.document, 'SQLite', name);
                  if (f.exists) f.delete();
                } catch { /* ignore missing files */ }
              }
              await AsyncStorage.clear();
              Alert.alert('Reset Complete', 'Please restart the app to reload trail data.');
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : 'Failed to reset data');
            }
          },
        },
      ],
    );
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={[styles.backText, { color: colors.accent }]}>Done</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Settings</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Theme Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>THEME</Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {THEME_OPTIONS.map((opt, i) => (
            <Pressable
              key={opt.value}
              onPress={() => handleThemeSelect(opt.value)}
              style={[
                styles.optionRow,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: currentThemeValue === opt.value }}
            >
              <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
              {currentThemeValue === opt.value && (
                <Text style={[styles.checkmark, { color: colors.accent }]}>✓</Text>
              )}
            </Pressable>
          ))}
        </View>

        {/* Night Red Toggle */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: spacing.md }]}>
          <Pressable
            onPress={() => setNightRedEnabled(!nightRedEnabled)}
            style={styles.optionRow}
            accessibilityRole="switch"
            accessibilityState={{ checked: nightRedEnabled }}
          >
            <View style={styles.optionInfo}>
              <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>Night Red Mode</Text>
              <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>
                Red-shifted display for dark-adapted eyes
              </Text>
            </View>
            <Text style={[styles.checkmark, { color: nightRedEnabled ? colors.accent : colors.textSecondary }]}>
              {nightRedEnabled ? '✓' : ''}
            </Text>
          </Pressable>
        </View>

        {/* High Contrast Toggle */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: spacing.md }]}>
          <Pressable
            onPress={() => setHighContrast(!highContrast)}
            style={styles.optionRow}
            accessibilityRole="switch"
            accessibilityState={{ checked: highContrast }}
          >
            <View style={styles.optionInfo}>
              <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>High Contrast</Text>
              <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>
                Thicker borders and solid backgrounds
              </Text>
            </View>
            <Text style={[styles.checkmark, { color: highContrast ? colors.accent : colors.textSecondary }]}>
              {highContrast ? '✓' : ''}
            </Text>
          </Pressable>
        </View>

        {/* Alert Threshold Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          OFF-TRAIL ALERT SENSITIVITY
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {ALERT_OPTIONS.map((opt, i) => (
            <Pressable
              key={opt.value}
              onPress={() => handleAlertSelect(opt.value)}
              style={[
                styles.optionRow,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: alertPreset === opt.value }}
            >
              <View style={styles.optionInfo}>
                <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
                <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>{opt.description}</Text>
              </View>
              {alertPreset === opt.value && <Text style={[styles.checkmark, { color: colors.accent }]}>&#x2713;</Text>}
            </Pressable>
          ))}
        </View>

        {/* Data Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          DATA
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable
            onPress={handleResetData}
            style={styles.optionRow}
            accessibilityRole="button"
          >
            <Text style={[styles.optionLabel, { color: '#c00' }]}>Reset App Data</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: {
    ...typography.titleLarge,
    textAlign: 'center',
  },
  backButton: {
    minWidth: 60,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  backText: {
    ...typography.body,
    fontWeight: '600',
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  sectionTitle: {
    ...typography.caption,
    fontWeight: '600',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
  },
  optionInfo: {
    flex: 1,
  },
  optionLabel: {
    ...typography.body,
  },
  optionDescription: {
    ...typography.caption,
    marginTop: 2,
  },
  checkmark: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: spacing.md,
  },
});
