import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface PlanSummaryCardProps {
  planName: string;
  direction: string;
  totalDays: number;
  totalKm: number;
  totalAscent: number;
  totalDescent: number;
  startDate?: string;
  endDate?: string;
  /** Section description, e.g. "km 50–200" */
  section?: string;
  style?: ViewStyle;
}

/**
 * Summary card showing plan overview: name, direction badge,
 * total days/km/elevation, and optional date range.
 */
export function PlanSummaryCard({
  planName,
  direction,
  totalDays,
  totalKm,
  totalAscent,
  totalDescent,
  startDate,
  endDate,
  section,
  style,
}: PlanSummaryCardProps) {
  const { colors, highContrast } = useTheme();

  const dateRange =
    startDate && endDate ? `${formatDate(startDate)} — ${formatDate(endDate)}` : null;

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
      accessibilityLabel={`${planName}, ${direction}, ${totalDays} days, ${Math.round(totalKm)} km`}
    >
      <View style={styles.headerRow}>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {planName}
        </Text>
        <View style={[styles.badge, { backgroundColor: colors.accentSubtle }]}>
          <Text style={[styles.badgeText, { color: colors.accent }]}>{direction}</Text>
        </View>
      </View>

      {section && (
        <Text style={[styles.sectionBadge, { color: colors.textSecondary }]}>
          Section: {section}
        </Text>
      )}

      <Text style={[styles.stats, { color: colors.textPrimary }]}>
        {totalDays} day{totalDays !== 1 ? 's' : ''}  ·  {Math.round(totalKm)} km  ·  +{Math.round(totalAscent)}m / -{Math.round(totalDescent)}m
      </Text>

      {dateRange && (
        <Text style={[styles.dates, { color: colors.textSecondary }]}>
          {dateRange}
        </Text>
      )}
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  name: {
    ...typography.titleLarge,
    flex: 1,
    marginRight: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  badgeText: {
    ...typography.caption,
    fontWeight: '700',
  },
  sectionBadge: {
    ...typography.caption,
    marginBottom: spacing.xs,
  },
  stats: {
    ...typography.body,
    fontVariant: ['tabular-nums'],
  },
  dates: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
});
