import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { DayPlanCard, type DayPlanData, type DayResources } from '../DayPlanCard';
import type { ComputedDay } from '../../services/plan-calculator-types';
import type { DayClimate } from '../../services/climate-service';
import { spacing } from '../../tokens/spacing';
import { typography } from '../../tokens/typography';

function dayToCardData(day: ComputedDay): DayPlanData {
  return {
    dayNumber: day.dayNumber,
    date: day.date,
    startName: day.startName,
    endName: day.endName,
    distanceKm: day.distanceKm,
    ascentM: day.ascentM,
    descentM: day.descentM,
    estimatedHours: day.estimatedHours,
    waterSources: day.waterSources,
  };
}

interface PlanDaysTabProps {
  days: ComputedDay[];
  stopsCount: number;
  dayClimate: (DayClimate | null)[];
  dayResources: DayResources[];
  onRemoveDay: (index: number) => void;
  onOpenMenu: (index: number) => void;
  onShowOnMap: (index: number) => void;
  onLongPressDay: (index: number) => void;
  onResourcePress: () => void;
}

/** Days tab of the plan editor (extracted from app/plan/[planId].tsx). */
export function PlanDaysTab({
  days,
  stopsCount,
  dayClimate,
  dayResources,
  onRemoveDay,
  onOpenMenu,
  onShowOnMap,
  onLongPressDay,
  onResourcePress,
}: PlanDaysTabProps) {
  const { colors } = useTheme();

  if (days.length === 0 && stopsCount === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
          No stops planned yet
        </Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Tap &quot;Add Stops&quot; to select overnight stops along the trail.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={days}
      keyExtractor={(item) => `day-${item.dayNumber}`}
      contentContainerStyle={styles.list}
      renderItem={({ item, index }) => (
        <DayPlanCard
          data={dayToCardData(item)}
          onRemove={index < days.length - 1 ? () => onRemoveDay(index) : undefined}
          onOpenMenu={() => onOpenMenu(index)}
          onShowOnMap={() => onShowOnMap(index)}
          onLongPress={index < days.length - 1 ? () => onLongPressDay(index) : undefined}
          climate={dayClimate[index]}
          resources={dayResources[index]}
          onResourcePress={onResourcePress}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    padding: spacing.lg,
    paddingBottom: 100,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    ...typography.body,
    textAlign: 'center',
  },
});
