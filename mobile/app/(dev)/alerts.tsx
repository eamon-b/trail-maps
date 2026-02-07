import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { AlertBanner, LocationStatusBar, type AlertLevel, type LocationState } from '../../src/components';
import { spacing, touchTarget, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const LOCATION_STATES: LocationState[] = ['onTrail', 'noGps', 'drifting', 'warning', 'offTrail'];
const ALERT_LEVELS: AlertLevel[] = ['info', 'warning', 'error'];

export default function AlertsScreen() {
  const { colors } = useTheme();
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerLevel, setBannerLevel] = useState<AlertLevel>('info');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <AlertBanner
        visible={bannerVisible}
        level={bannerLevel}
        message={`This is a ${bannerLevel} alert banner`}
        onHidden={() => setBannerVisible(false)}
      />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
          Location Status Bar
        </Text>
        {LOCATION_STATES.map((state) => (
          <LocationStatusBar
            key={state}
            state={state}
            detail={state === 'offTrail' ? '150m from trail' : state === 'warning' ? '80m from trail' : undefined}
            style={styles.statusBar}
          />
        ))}

        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
          Alert Banners
        </Text>
        <View style={styles.buttonRow}>
          {ALERT_LEVELS.map((level) => (
            <Pressable
              key={level}
              onPress={() => { setBannerLevel(level); setBannerVisible(true); }}
              style={[styles.button, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={`Show ${level} banner`}
            >
              <Text style={[styles.buttonText, { color: colors.textInverse }]}>
                {level}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
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
  statusBar: {
    marginBottom: spacing.sm,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  button: {
    flex: 1,
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    ...typography.body,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
});
