import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { typography } from '../tokens/typography';
import { AppText } from './AppText';
import {
  getSunriseSunset,
  isDaylight,
  minutesToNextEvent,
  formatLocalTime,
  formatDuration,
  type SunTimes,
} from '../lib/sunrise-sunset';

interface SunriseCountdownProps {
  /** Current latitude (decimal degrees) */
  latitude: number;
  /** Current longitude (decimal degrees) */
  longitude: number;
  style?: ViewStyle;
}

interface SunDisplay {
  icon: string;
  label: string;
  accessibilityLabel: string;
}

function buildDisplay(sunTimes: SunTimes, now: Date): SunDisplay {
  const day = isDaylight(sunTimes, now);
  const next = minutesToNextEvent(sunTimes, now);

  if (!day) {
    // Before sunrise or after sunset
    if (next.event === 'sunrise' && next.minutesUntil > 0) {
      const duration = formatDuration(next.minutesUntil);
      return {
        icon: '🌅',
        label: `Sunrise in ${duration}`,
        accessibilityLabel: `Sunrise in ${duration} at ${formatLocalTime(sunTimes.sunrise)}`,
      };
    }
    // After sunset — show next-day sunrise time
    return {
      icon: '🌙',
      label: `Sunrise at ${formatLocalTime(sunTimes.sunrise)}`,
      accessibilityLabel: `Sunrise at ${formatLocalTime(sunTimes.sunrise)}`,
    };
  }

  // Daylight — show sunset countdown
  const duration = formatDuration(next.minutesUntil);
  if (next.minutesUntil <= 60) {
    // Urgent: less than 1 hour to sunset
    return {
      icon: '🌆',
      label: `Sunset in ${duration}`,
      accessibilityLabel: `Sunset in ${duration} at ${formatLocalTime(sunTimes.sunset)}`,
    };
  }
  return {
    icon: '☀️',
    label: `Sunset in ${duration}`,
    accessibilityLabel: `Sunset in ${duration} at ${formatLocalTime(sunTimes.sunset)}`,
  };
}

/**
 * Compact inline sunrise/sunset countdown.
 * Updates every minute and shows:
 * - "Sunrise in Xh Ym" (before sunrise)
 * - "Sunset in Xh Ym" (during daylight, with urgent styling when < 1h)
 * - "Sunrise at HH:MM" (after sunset)
 */
export function SunriseCountdown({ latitude, longitude, style }: SunriseCountdownProps) {
  const { colors } = useTheme();
  const [now, setNow] = useState(() => new Date());

  // Update every minute
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const sunTimes = getSunriseSunset(latitude, longitude, now);
  if (!sunTimes) return null; // Polar day/night

  const display = buildDisplay(sunTimes, now);
  const day = isDaylight(sunTimes, now);
  const next = minutesToNextEvent(sunTimes, now);
  const urgent = day && next.minutesUntil <= 60;
  const color = urgent ? colors.alertAmber : colors.textSecondary;

  return (
    <View
      style={[styles.container, style]}
      accessibilityLabel={display.accessibilityLabel}
    >
      <AppText style={styles.icon}>{display.icon}</AppText>
      <AppText style={[styles.text, { color }]}>{display.label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  icon: {
    ...typography.bodySmall,
  },
  // Field-critical countdown — ≥14pt (dataSmall), never caption
  text: {
    ...typography.dataSmall,
  },
});
