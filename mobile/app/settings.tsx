import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Switch, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../src/theme';
import type { ThemeVariant } from '../src/tokens/themes';
import { spacing, touchTarget } from '../src/tokens/spacing';
import { typography } from '../src/tokens/typography';
import { Card, PressableRow, ScreenHeader } from '../src/components';
import type { TrackingProfilePreference } from '../src/services/location-service';
import { closeDatabase } from '../src/db/database';
import { Paths, File } from 'expo-file-system';

export const ALERT_THRESHOLD_KEY = 'trail-companion:alertThreshold';
export const BACKGROUND_TRACKING_KEY = 'trail-companion:backgroundTracking';
export const TRACKING_PROFILE_KEY = 'trail-companion:trackingProfile';

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

const TRACKING_PROFILE_OPTIONS: { label: string; value: TrackingProfilePreference; description: string }[] = [
  { label: 'Auto', value: 'auto', description: 'Battery saver kicks in below 30% charge' },
  { label: 'Standard', value: 'standard', description: 'High accuracy — GPS fix every 30 s / 10 m' },
  { label: 'Battery Saver', value: 'saver', description: 'Balanced accuracy — fix every 2 min / 25 m' },
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

  const [alertPreset, setAlertPreset] = useState<AlertPreset>('normal');
  const [backgroundTracking, setBackgroundTracking] = useState(false);
  const [trackingProfile, setTrackingProfile] = useState<TrackingProfilePreference>('auto');

  // Load persisted preferences
  useEffect(() => {
    AsyncStorage.getItem(ALERT_THRESHOLD_KEY).then((val) => {
      if (val === 'tight' || val === 'normal' || val === 'loose') {
        setAlertPreset(val);
      }
    });
    AsyncStorage.getItem(BACKGROUND_TRACKING_KEY).then((val) => {
      setBackgroundTracking(val === 'true');
    });
    AsyncStorage.getItem(TRACKING_PROFILE_KEY).then((val) => {
      if (val === 'auto' || val === 'standard' || val === 'saver') {
        setTrackingProfile(val);
      }
    });
  }, []);

  const handleAlertSelect = useCallback(async (value: AlertPreset) => {
    setAlertPreset(value);
    await AsyncStorage.setItem(ALERT_THRESHOLD_KEY, value);
  }, []);

  const handleTrackingProfileSelect = useCallback(async (value: TrackingProfilePreference) => {
    setTrackingProfile(value);
    await AsyncStorage.setItem(TRACKING_PROFILE_KEY, value);
  }, []);

  const handleBackgroundTrackingToggle = useCallback(async () => {
    const next = !backgroundTracking;
    setBackgroundTracking(next);
    await AsyncStorage.setItem(BACKGROUND_TRACKING_KEY, String(next));
  }, [backgroundTracking]);

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

  const rowBorder = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Settings"
        onBack={() => router.back()}
        backLabel="Done"
        variant="surface"
      />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Theme Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>THEME</Text>
        <Card flush>
          {THEME_OPTIONS.map((opt, i) => (
            <PressableRow
              key={opt.value}
              onPress={() => handleThemeSelect(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: currentThemeValue === opt.value }}
              style={[styles.optionRow, i > 0 && rowBorder]}
            >
              <View style={styles.optionRowInner}>
                <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
                {currentThemeValue === opt.value && (
                  <Text style={[styles.checkmark, { color: colors.accent }]}>✓</Text>
                )}
              </View>
            </PressableRow>
          ))}
        </Card>

        {/* Night Red Toggle */}
        <Card flush>
          <PressableRow
            onPress={() => setNightRedEnabled(!nightRedEnabled)}
            accessibilityRole="switch"
            accessibilityState={{ checked: nightRedEnabled }}
            style={styles.optionRow}
          >
            <View style={styles.optionRowInner}>
              <View style={styles.optionInfo}>
                <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>Night Red Mode</Text>
                <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>
                  Red-shifted display for dark-adapted eyes
                </Text>
              </View>
              <Switch
                value={nightRedEnabled}
                onValueChange={setNightRedEnabled}
                trackColor={{ true: colors.accentMuted }}
                thumbColor={nightRedEnabled ? colors.accent : undefined}
                importantForAccessibility="no"
              />
            </View>
          </PressableRow>
        </Card>

        {/* High Contrast Toggle */}
        <Card flush>
          <PressableRow
            onPress={() => setHighContrast(!highContrast)}
            accessibilityRole="switch"
            accessibilityState={{ checked: highContrast }}
            style={styles.optionRow}
          >
            <View style={styles.optionRowInner}>
              <View style={styles.optionInfo}>
                <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>High Contrast</Text>
                <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>
                  Thicker borders and solid backgrounds
                </Text>
              </View>
              <Switch
                value={highContrast}
                onValueChange={setHighContrast}
                trackColor={{ true: colors.accentMuted }}
                thumbColor={highContrast ? colors.accent : undefined}
                importantForAccessibility="no"
              />
            </View>
          </PressableRow>
        </Card>

        {/* GPS Tracking Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          GPS TRACKING
        </Text>
        <Card flush>
          <PressableRow
            onPress={handleBackgroundTrackingToggle}
            accessibilityRole="switch"
            accessibilityState={{ checked: backgroundTracking }}
            style={styles.optionRow}
          >
            <View style={styles.optionRowInner}>
              <View style={styles.optionInfo}>
                <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>Background Tracking</Text>
                <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>
                  Keep tracking while the screen is locked. Uses more battery and
                  asks for the &quot;Allow all the time&quot; location permission.
                </Text>
              </View>
              <Switch
                value={backgroundTracking}
                onValueChange={handleBackgroundTrackingToggle}
                trackColor={{ true: colors.accentMuted }}
                thumbColor={backgroundTracking ? colors.accent : undefined}
                importantForAccessibility="no"
              />
            </View>
          </PressableRow>
        </Card>

        {/* Tracking power profile — Auto resolves via battery level when a
            hike-tab tracking session starts; the hike status line discloses
            when the saver cadence is active. */}
        <Card flush style={{ marginTop: spacing.md }}>
          {TRACKING_PROFILE_OPTIONS.map((opt, i) => (
            <PressableRow
              key={opt.value}
              onPress={() => handleTrackingProfileSelect(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: trackingProfile === opt.value }}
              style={[styles.optionRow, i > 0 && rowBorder]}
            >
              <View style={styles.optionRowInner}>
                <View style={styles.optionInfo}>
                  <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
                  <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>{opt.description}</Text>
                </View>
                {trackingProfile === opt.value && (
                  <Text style={[styles.checkmark, { color: colors.accent }]}>&#x2713;</Text>
                )}
              </View>
            </PressableRow>
          ))}
        </Card>

        {/* Alert Threshold Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          OFF-TRAIL ALERT SENSITIVITY
        </Text>
        <Card flush>
          {ALERT_OPTIONS.map((opt, i) => (
            <PressableRow
              key={opt.value}
              onPress={() => handleAlertSelect(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: alertPreset === opt.value }}
              style={[styles.optionRow, i > 0 && rowBorder]}
            >
              <View style={styles.optionRowInner}>
                <View style={styles.optionInfo}>
                  <Text style={[styles.optionLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
                  <Text style={[styles.optionDescription, { color: colors.textSecondary }]}>{opt.description}</Text>
                </View>
                {alertPreset === opt.value && <Text style={[styles.checkmark, { color: colors.accent }]}>&#x2713;</Text>}
              </View>
            </PressableRow>
          ))}
        </Card>

        {/* Data Section */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          DATA
        </Text>
        <Card flush>
          <PressableRow
            onPress={handleResetData}
            haptic="warning"
            accessibilityLabel="Reset app data"
            style={styles.optionRow}
          >
            <View style={styles.optionRowInner}>
              <Text style={[styles.optionLabel, { color: colors.danger }]}>Reset App Data</Text>
            </View>
          </PressableRow>
        </Card>
      </ScrollView>
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  optionRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
  },
  optionRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
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
    ...typography.body,
    fontWeight: '600',
    marginLeft: spacing.md,
  },
});
