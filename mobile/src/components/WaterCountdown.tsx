import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { typography } from '../tokens/typography';

interface WaterCountdownProps {
  /** Distance to next water source in km, or null if unknown */
  nextWaterKm: number | null;
  style?: ViewStyle;
}

/**
 * Compact inline "Next water: X.X km" indicator with color coding:
 * - Green: < 5 km
 * - Amber: 5–15 km
 * - Red: > 15 km
 */
export function WaterCountdown({ nextWaterKm, style }: WaterCountdownProps) {
  const { colors } = useTheme();

  if (nextWaterKm == null) {
    return null;
  }

  const color =
    nextWaterKm < 5 ? '#4CAF50' :
    nextWaterKm <= 15 ? (colors.alertAmber ?? '#FF9800') :
    (colors.alertRed ?? '#F44336');

  return (
    <View style={[styles.container, style]} accessibilityLabel={`Next water source in ${nextWaterKm.toFixed(1)} kilometers`}>
      <Text style={[styles.icon]}>💧</Text>
      <Text style={[styles.text, { color }]}>
        Next water: {nextWaterKm.toFixed(1)} km
      </Text>
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
    fontSize: 12,
  },
  text: {
    ...typography.caption,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
