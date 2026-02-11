import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface ClimateCardProps {
  tempMin: number;
  tempMax: number;
  precipitation: number;
  rainyDays: number;
  style?: ViewStyle;
}

/**
 * Compact per-day climate summary card showing temperature range and precipitation.
 */
export function ClimateCard({ tempMin, tempMax, precipitation, rainyDays, style }: ClimateCardProps) {
  const { colors, highContrast } = useTheme();

  // Temperature bar color: blue (cold) → green (mild) → red (hot)
  const avgTemp = (tempMin + tempMax) / 2;
  const tempColor = avgTemp < 5 ? '#2196F3' : avgTemp < 20 ? '#4CAF50' : '#FF5722';

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: highContrast ? colors.background : colors.surface,
          borderColor: colors.border,
          borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth,
        },
        style,
      ]}
      accessibilityLabel={`Temperature ${tempMin} to ${tempMax} degrees, ${precipitation} millimeters precipitation, ${rainyDays} rainy days`}
    >
      <View style={styles.row}>
        <View style={styles.tempSection}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Temperature</Text>
          <View style={styles.tempRow}>
            <View style={[styles.tempBar, { backgroundColor: tempColor }]} />
            <Text style={[styles.tempText, { color: colors.textPrimary }]}>
              {tempMin}–{tempMax}°C
            </Text>
          </View>
        </View>
        <View style={styles.rainSection}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Precipitation</Text>
          <Text style={[styles.rainText, { color: colors.textPrimary }]}>
            {precipitation}mm · {rainyDays} day{rainyDays !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.md,
    padding: spacing.md,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  tempSection: {
    flex: 1,
  },
  rainSection: {
    flex: 1,
  },
  label: {
    ...typography.caption,
    marginBottom: spacing.xs,
  },
  tempRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tempBar: {
    width: 4,
    height: 16,
    borderRadius: 2,
  },
  tempText: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  rainText: {
    ...typography.body,
    fontVariant: ['tabular-nums'],
  },
});
