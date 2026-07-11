import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { PlanSummaryCard } from '../PlanSummaryCard';
import { WaterCarryList } from '../WaterCarryList';
import { ResupplyList } from '../ResupplyList';
import type { Plan } from '../../services/plan-service';
import type { ComputedDay, SectionConfig } from '../../services/plan-calculator-types';
import type { WaterCarryAnalysis } from '@lib/water-carry-calculator';
import type { ResupplyAnalysis } from '@lib/resupply-calculator';
import { spacing, radii, touchTarget } from '../../tokens/spacing';
import { typography } from '../../tokens/typography';

interface PlanOverviewTabProps {
  plan: Plan | null;
  days: ComputedDay[];
  section: SectionConfig | null;
  waterAnalysis: WaterCarryAnalysis | null;
  resupplyAnalysis: ResupplyAnalysis | null;
  onSetSection: () => void;
  onExport: () => void;
  onOpenVersions: () => void;
}

/** Overview tab of the plan editor (extracted from app/plan/[planId].tsx). */
export function PlanOverviewTab({
  plan,
  days,
  section,
  waterAnalysis,
  resupplyAnalysis,
  onSetSection,
  onExport,
  onOpenVersions,
}: PlanOverviewTabProps) {
  const { colors } = useTheme();

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <PlanSummaryCard
        planName={plan?.name ?? 'Plan'}
        direction={plan?.direction ?? 'NOBO'}
        totalDays={days.length}
        totalKm={days.reduce((sum, d) => sum + d.distanceKm, 0)}
        totalAscent={days.reduce((sum, d) => sum + d.ascentM, 0)}
        totalDescent={days.reduce((sum, d) => sum + d.descentM, 0)}
        startDate={days[0]?.date}
        endDate={days[days.length - 1]?.date}
        section={section ? `km ${section.startKm.toFixed(0)}–${section.endKm.toFixed(0)}` : undefined}
      />

      {/* Quick action buttons */}
      <View style={styles.quickActions}>
        <Pressable
          onPress={onSetSection}
          style={[styles.quickAction, { borderColor: colors.border }]}
          accessibilityRole="button"
        >
          <Text style={[styles.quickActionText, { color: colors.accent }]}>
            {section ? 'Change Section' : 'Set Section'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onExport}
          style={[styles.quickAction, { borderColor: colors.border }]}
          accessibilityRole="button"
        >
          <Text style={[styles.quickActionText, { color: colors.accent }]}>Export</Text>
        </Pressable>
        <Pressable
          onPress={onOpenVersions}
          style={[styles.quickAction, { borderColor: colors.border }]}
          accessibilityRole="button"
        >
          <Text style={[styles.quickActionText, { color: colors.accent }]}>Versions</Text>
        </Pressable>
      </View>

      {/* Resupply and water summaries */}
      {waterAnalysis && <WaterCarryList analysis={waterAnalysis} />}
      {resupplyAnalysis && <ResupplyList analysis={resupplyAnalysis} days={days} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: spacing.lg,
    paddingBottom: 100,
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  quickAction: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  quickActionText: {
    ...typography.caption,
    fontWeight: '600',
  },
});
