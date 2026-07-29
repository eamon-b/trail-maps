/**
 * Plan screen — the planner heritage, reborn as a single read-only guide
 * screen. No persisted plans: it is a LIVE calculator. Pick a section, set your
 * daily hours and pace, and the shared @lib calculators derive day splits,
 * resupply legs, and water carries on the fly. Only your pace + hours are
 * remembered per trail; the section defaults to the full trail on open.
 *
 * Everything downstream derives from the direction-applied guide trail, so a
 * direction flip recomputes the whole plan for free.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../../src/theme';
import { radii, spacing, typography } from '../../../src/tokens';
import { useSettingsStore } from '../../../src/state/settings-store';
import { useGuide } from '../../../src/features/guide/GuideContext';
import {
  computePlan,
  waypointOptions,
  type PlanInputs,
} from '../../../src/features/plan/plan-adapters';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { PlanInputsCard } from '../../../src/features/plan/PlanInputsCard';
import { DaySplitList } from '../../../src/features/plan/DaySplitList';
import { ResupplyCard } from '../../../src/features/plan/ResupplyCard';
import { WaterCarryCard } from '../../../src/features/plan/WaterCarryCard';
import { formatHours } from '../../../src/features/plan/plan-format';

export default function PlanScreen() {
  const { colors } = useTheme();
  const { trail, trailId, direction } = useGuide();
  const units = useSettingsStore((s) => s.units);

  const prefs = usePlanInputsStore(selectPrefs(trailId));
  const setDailyHours = usePlanInputsStore((s) => s.setDailyHours);
  const setPace = usePlanInputsStore((s) => s.setPace);

  const options = useMemo(() => waypointOptions(trail), [trail]);
  const lastIdx = Math.max(0, options.length - 1);

  // Section is local (direction-safe): reset to full trail whenever the trail's
  // direction flips, since the km behind each index changes meaning.
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(lastIdx);
  useEffect(() => {
    setStartIdx(0);
    setEndIdx(Math.max(0, options.length - 1));
  }, [direction, options.length]);

  const startKm = options[startIdx]?.km ?? 0;
  const endKm = options[endIdx]?.km ?? trail.track.totalDistance;
  const inputs: PlanInputs = { startKm, endKm, dailyHours: prefs.dailyHours, pace: prefs.pace };

  const plan = useMemo(
    () => computePlan(trail, { startKm, endKm, dailyHours: prefs.dailyHours, pace: prefs.pace }),
    [trail, startKm, endKm, prefs.dailyHours, prefs.pace],
  );

  const sectionKm = Math.max(0, inputs.endKm - inputs.startKm);
  const totalHours = plan.days.reduce((sum, d) => sum + d.estimatedHours, 0);
  const validSection = inputs.endKm > inputs.startKm && options.length >= 2;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <PlanInputsCard
        options={options}
        startIdx={startIdx}
        endIdx={endIdx}
        dailyHours={prefs.dailyHours}
        pace={prefs.pace}
        units={units}
        onStartIdx={setStartIdx}
        onEndIdx={setEndIdx}
        onDailyHours={(h) => setDailyHours(trailId, h)}
        onPace={(p) => setPace(trailId, p)}
        onResetSection={() => {
          setStartIdx(0);
          setEndIdx(lastIdx);
        }}
      />

      {!validSection ? (
        <View style={[styles.guard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.guardText, { color: colors.textSecondary }]}>
            Choose a start before the end to build a plan.
          </Text>
        </View>
      ) : (
        <>
          <View style={[styles.summary, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
            <SummaryStat label="Days" value={String(plan.days.length)} />
            <SummaryStat label="Distance" value={formatDistance(sectionKm, units)} />
            <SummaryStat label="Est. time" value={formatHours(totalHours)} />
            <SummaryStat label="Target/day" value={formatDistance(plan.targetDailyKm, units)} />
          </View>

          <Section title="Day splits">
            <DaySplitList days={plan.days} units={units} />
          </Section>

          <Section title="Resupply">
            <ResupplyCard
              legs={plan.foodCarries}
              hasData={plan.resupply.hasResupplyData}
              units={units}
            />
          </Section>

          <Section title="Water carries">
            <WaterCarryCard
              carries={plan.topWaterCarries}
              hasData={plan.water.hasWaterData}
              units={units}
            />
          </Section>
        </>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
      {children}
    </View>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.summaryStat}>
      <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.xl },

  guard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  guardText: { ...typography.bodySmall, textAlign: 'center' },

  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  summaryStat: { alignItems: 'center', gap: spacing.xs, flex: 1 },
  summaryValue: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },
  summaryLabel: { ...typography.caption },

  section: { gap: spacing.md },
  sectionTitle: { ...typography.titleLarge },
});
