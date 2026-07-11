import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { typography } from '../tokens/typography';
import { AppText } from './AppText';
import { formatEtaMinutes } from '../services/distance-calculator';

interface WaterCountdownProps {
  /** Distance to next water source in km, or null if unknown */
  nextWaterKm: number | null;
  /** Naismith walking time to the water source in minutes, if known */
  etaMinutes?: number | null;
  style?: ViewStyle;
}

/**
 * Compact inline "Next water: X.X km" indicator with color coding:
 * - waterOk: < 5 km
 * - waterLow: 5–15 km
 * - waterCritical: > 15 km
 *
 * All three thresholds resolve through the theme's semantic water ramp so
 * Night Red mode stays red-shifted.
 */
export function WaterCountdown({ nextWaterKm, etaMinutes, style }: WaterCountdownProps) {
  const { colors } = useTheme();

  if (nextWaterKm == null) {
    return null;
  }

  const color =
    nextWaterKm < 5 ? colors.waterOk :
    nextWaterKm <= 15 ? colors.waterLow :
    colors.waterCritical;

  const etaText = etaMinutes != null ? ` · ${formatEtaMinutes(etaMinutes)}` : '';

  return (
    <View
      style={[styles.container, style]}
      accessibilityLabel={`Next water source in ${nextWaterKm.toFixed(1)} kilometers${etaMinutes != null ? `, about ${formatEtaMinutes(etaMinutes).replace('~', '')}` : ''}`}
    >
      <AppText style={styles.icon}>💧</AppText>
      <AppText style={[styles.text, { color }]}>
        Next water: {nextWaterKm.toFixed(1)} km{etaText}
      </AppText>
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
  // Field-critical number — ≥14pt (dataSmall), never caption
  text: {
    ...typography.dataSmall,
  },
});
