import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import type { ResupplyAnalysis, ResupplyGap } from '@lib/resupply-calculator';
import { foodCarryForGap, correlateResupplyWithDays, DEFAULT_GRAMS_PER_DAY } from '@lib/resupply-calculator';
import type { ComputedDay } from '../services/plan-calculator-types';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface ResupplyListProps {
  analysis: ResupplyAnalysis;
  /** When provided, shows arrival day and date next to resupply points */
  days?: ComputedDay[];
}

/**
 * Displays resupply points along a trail with distances, estimated days,
 * and food carry weight calculations. Includes a configurable grams/day input.
 */
export function ResupplyList({ analysis, days }: ResupplyListProps) {
  const { colors, highContrast } = useTheme();
  const [gramsPerDay, setGramsPerDay] = useState(DEFAULT_GRAMS_PER_DAY.toString());
  const [showFoodCalc, setShowFoodCalc] = useState(false);

  const dayCorrelation = useMemo(() => {
    if (!days || days.length === 0) return null;
    return correlateResupplyWithDays(analysis.points, days);
  }, [analysis.points, days]);

  const parsedGrams = useMemo(() => {
    const n = parseInt(gramsPerDay, 10);
    return isNaN(n) || n <= 0 ? DEFAULT_GRAMS_PER_DAY : n;
  }, [gramsPerDay]);

  if (!analysis.hasResupplyData) {
    return (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Resupply Points</Text>
        <Text style={[styles.noData, { color: colors.textSecondary }]}>
          No town or food resupply data for this trail.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Resupply Points</Text>

      {/* Summary stats */}
      <View style={styles.statsRow}>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          {analysis.points.length} point{analysis.points.length !== 1 ? 's' : ''}
        </Text>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          Longest: {analysis.longestGapKm.toFixed(0)} km ({analysis.longestGapDays} day{analysis.longestGapDays !== 1 ? 's' : ''})
        </Text>
      </View>

      {/* Food calculator toggle */}
      <Pressable
        onPress={() => setShowFoodCalc(!showFoodCalc)}
        style={[styles.calcToggle, { borderColor: colors.border }]}
        accessibilityRole="button"
        accessibilityLabel={showFoodCalc ? 'Hide food calculator' : 'Show food calculator'}
      >
        <Text style={[styles.calcToggleText, { color: colors.accent }]}>
          {showFoodCalc ? 'Hide' : 'Show'} food weight calculator
        </Text>
      </Pressable>

      {showFoodCalc && (
        <View style={styles.calcRow}>
          <Text style={[styles.calcLabel, { color: colors.textSecondary }]}>Grams/day:</Text>
          <TextInput
            style={[
              styles.calcInput,
              {
                color: colors.textPrimary,
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
            value={gramsPerDay}
            onChangeText={setGramsPerDay}
            keyboardType="number-pad"
            selectTextOnFocus
            accessibilityLabel="Grams of food per day"
          />
        </View>
      )}

      {/* Resupply points with arrival days */}
      {dayCorrelation && dayCorrelation.length > 0 && (
        <View style={[styles.arrivalSection, { borderBottomColor: colors.border }]}>
          {dayCorrelation.map((info, i) => (
            <View key={i} style={styles.arrivalRow}>
              <Text style={[styles.arrivalName, { color: colors.textPrimary }]}>
                {info.point.name}
              </Text>
              <Text style={[styles.arrivalDay, { color: colors.textSecondary }]}>
                Day {info.arrivalDay}{info.arrivalDate ? ` (${info.arrivalDate})` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Gap list */}
      {analysis.gaps.map((gap, i) => (
        <GapRow key={i} gap={gap} showFoodCalc={showFoodCalc} gramsPerDay={parsedGrams} />
      ))}
    </View>
  );
}

function GapRow({ gap, showFoodCalc, gramsPerDay }: { gap: ResupplyGap; showFoodCalc: boolean; gramsPerDay: number }) {
  const { colors } = useTheme();
  const food = useMemo(() => showFoodCalc ? foodCarryForGap(gap, gramsPerDay) : null, [gap, showFoodCalc, gramsPerDay]);

  return (
    <View
      style={[
        styles.gapRow,
        { borderBottomColor: colors.border },
        gap.isLong && { borderLeftColor: colors.alertAmber, borderLeftWidth: 3 },
      ]}
    >
      <View style={styles.gapHeader}>
        <Text style={[styles.gapDistance, { color: gap.isLong ? colors.alertAmber : colors.textPrimary }]}>
          {gap.distanceKm.toFixed(0)} km
        </Text>
        <Text style={[styles.gapDays, { color: colors.textSecondary }]}>
          ~{gap.estimatedDays} day{gap.estimatedDays !== 1 ? 's' : ''}
        </Text>
        {gap.isLong && (
          <Text style={[styles.longLabel, { color: colors.alertAmber }]}>LONG</Text>
        )}
      </View>
      <Text style={[styles.gapNames, { color: colors.textSecondary }]} numberOfLines={1}>
        {gap.fromName} → {gap.toName}
      </Text>
      {food && (
        <Text style={[styles.foodWeight, { color: colors.textSecondary }]}>
          Food carry: {food.weightKg} kg ({food.weightGrams}g for {food.days} days)
        </Text>
      )}
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
    marginBottom: spacing.sm,
  },
  noData: {
    ...typography.body,
    fontStyle: 'italic',
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  stat: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  calcToggle: {
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  calcToggleText: {
    ...typography.caption,
    fontWeight: '600',
  },
  calcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  calcLabel: {
    ...typography.caption,
  },
  calcInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 80,
    minHeight: touchTarget.min,
    textAlign: 'center',
  },
  gapRow: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  gapDistance: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  gapDays: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  longLabel: {
    ...typography.caption,
    fontWeight: '700',
  },
  gapNames: {
    ...typography.caption,
    marginTop: 2,
  },
  foodWeight: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  arrivalSection: {
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  arrivalName: {
    ...typography.caption,
    fontWeight: '600',
    flex: 1,
  },
  arrivalDay: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
});
