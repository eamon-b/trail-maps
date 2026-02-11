import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { ClimateData } from '../services/climate-service';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface ClimateOverviewProps {
  climate: ClimateData;
  /** Months covered by the plan (1-indexed) for highlighting */
  planMonths?: number[];
  style?: ViewStyle;
}

/**
 * Full climate overview for a trail plan. Shows monthly temperature and
 * precipitation data with tabs for multiple climate locations.
 */
export function ClimateOverview({ climate, planMonths, style }: ClimateOverviewProps) {
  const { colors, highContrast } = useTheme();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const planMonthSet = useMemo(() => new Set(planMonths ?? []), [planMonths]);

  const location = climate.locations[selectedIdx];
  if (!location) {
    return (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth }, style]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Climate Data</Text>
        <Text style={[styles.noData, { color: colors.textSecondary }]}>No climate data available.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth }, style]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Climate Data</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        {climate.dataYears.start}–{climate.dataYears.end} averages
      </Text>

      {/* Location tabs */}
      {climate.locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
          {climate.locations.map((loc, i) => (
            <Pressable
              key={loc.name}
              onPress={() => setSelectedIdx(i)}
              style={[
                styles.tab,
                {
                  backgroundColor: i === selectedIdx ? colors.accentSubtle : 'transparent',
                  borderColor: i === selectedIdx ? colors.accent : colors.border,
                },
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: i === selectedIdx }}
            >
              <Text style={[styles.tabText, { color: i === selectedIdx ? colors.accent : colors.textSecondary }]}>
                {loc.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Monthly table */}
      <View style={styles.table}>
        {/* Header row */}
        <View style={styles.tableRow}>
          <Text style={[styles.headerCell, styles.monthCell, { color: colors.textSecondary }]}>Month</Text>
          <Text style={[styles.headerCell, styles.tempCell, { color: colors.textSecondary }]}>Min</Text>
          <Text style={[styles.headerCell, styles.tempCell, { color: colors.textSecondary }]}>Max</Text>
          <Text style={[styles.headerCell, styles.rainCell, { color: colors.textSecondary }]}>Rain</Text>
          <Text style={[styles.headerCell, styles.daysCell, { color: colors.textSecondary }]}>Days</Text>
        </View>

        {location.monthly.map(m => {
          const isHighlighted = planMonthSet.has(m.month);
          return (
            <View
              key={m.month}
              style={[
                styles.tableRow,
                isHighlighted && { backgroundColor: colors.accentSubtle },
              ]}
            >
              <Text style={[styles.cell, styles.monthCell, { color: colors.textPrimary, fontWeight: isHighlighted ? '700' : '400' }]}>
                {MONTH_NAMES[m.month - 1]}
              </Text>
              <Text style={[styles.cell, styles.tempCell, { color: colors.textPrimary }]}>
                {m.avgTempMin}°
              </Text>
              <Text style={[styles.cell, styles.tempCell, { color: colors.textPrimary }]}>
                {m.avgTempMax}°
              </Text>
              <Text style={[styles.cell, styles.rainCell, { color: colors.textPrimary }]}>
                {m.avgPrecipitation}mm
              </Text>
              <Text style={[styles.cell, styles.daysCell, { color: colors.textPrimary }]}>
                {m.avgRainyDays}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  title: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.caption,
    marginBottom: spacing.md,
  },
  noData: {
    ...typography.body,
    fontStyle: 'italic',
  },
  tabs: {
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginRight: spacing.xs,
    minHeight: touchTarget.min / 2,
    justifyContent: 'center',
  },
  tabText: {
    ...typography.caption,
    fontWeight: '600',
  },
  table: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerCell: {
    ...typography.caption,
    fontWeight: '700',
  },
  cell: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  monthCell: {
    flex: 2,
  },
  tempCell: {
    flex: 1.5,
    textAlign: 'right',
  },
  rainCell: {
    flex: 2,
    textAlign: 'right',
  },
  daysCell: {
    flex: 1.5,
    textAlign: 'right',
  },
});
