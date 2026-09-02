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

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { trailElevationIsUsable } from '@lib/elevation-backfill';
import { useTheme } from '../../../src/theme';
import { radii, spacing, typography } from '../../../src/tokens';
import { useSettingsStore } from '../../../src/state/settings-store';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { computePlan, type PlanInputs } from '../../../src/features/plan/plan-adapters';
import { sectionOptions } from '../../../src/features/plan/plan-section';
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

  // Waypoints bracketed by synthetic termini so the default section is the whole
  // track (0 → totalDistance) and both trail ends are reachable — see
  // plan-section.ts. The list is rebuilt per direction (the guide trail is
  // direction-applied), so a flip re-brackets correctly.
  const options = useMemo(() => sectionOptions(trail), [trail]);
  const lastIdx = Math.max(0, options.length - 1);

  // Section is local (direction-safe): the picked indices only mean anything
  // against the option list they were picked from, so they are stamped with it
  // and fall back to the full trail *during render* when it changes — a
  // direction flip changes the km behind every index, and an effect-driven
  // reset would show one render of the old indices against the new options.
  const optionsKey = `${direction}:${options.length}`;
  const [section, setSection] = useState({ key: optionsKey, startIdx: 0, endIdx: lastIdx });
  const active =
    section.key === optionsKey ? section : { key: optionsKey, startIdx: 0, endIdx: lastIdx };
  const { startIdx, endIdx } = active;
  const setStartIdx = (idx: number) => setSection({ ...active, startIdx: idx });
  const setEndIdx = (idx: number) => setSection({ ...active, endIdx: idx });
  const resetSection = () => setSection({ key: optionsKey, startIdx: 0, endIdx: lastIdx });

  const startOption = options[startIdx];
  const endOption = options[endIdx];
  const startKm = startOption?.km ?? 0;
  const endKm = endOption?.km ?? trail.track.totalDistance;
  // Prefer the picked option's name so duplicate-km waypoints resolve to the
  // exact one the stepper is showing (computePlan falls back to nameAtKm).
  const startName = startOption?.name;
  const endName = endOption?.name;
  const inputs: PlanInputs = {
    startKm,
    endKm,
    dailyHours: prefs.dailyHours,
    pace: prefs.pace,
    startName,
    endName,
  };

  const plan = useMemo(
    () =>
      computePlan(trail, {
        startKm,
        endKm,
        dailyHours: prefs.dailyHours,
        pace: prefs.pace,
        startName,
        endName,
      }),
    [trail, startKm, endKm, startName, endName, prefs.dailyHours, prefs.pace],
  );

  // Naismith's climbing term is silently zero for a trail with no profile, so
  // the day splits look the same as a properly-derived plan while being
  // optimistic on anything steep. Say so rather than let the number pass for
  // more than it is. (An imported GPX can be given a profile from the import
  // screen's "Fetch elevation".)
  const distanceOnly = !trailElevationIsUsable(trail);

  const sectionKm = Math.max(0, inputs.endKm - inputs.startKm);
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
        onResetSection={resetSection}
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
            <SummaryStat label="Target/day" value={formatHours(plan.targetHours)} />
            <SummaryStat label="Avg/day" value={formatDistance(plan.effectiveDailyKm, units)} />
          </View>

          <Section
            title="Day splits"
            subtitle={
              distanceOnly
                ? "Distance-only estimate — no elevation data, so climbing time isn't included."
                : undefined
            }
          >
            <DaySplitList days={plan.days} targetHours={plan.targetHours} units={units} />
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

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  /** One line of caveat under the heading, e.g. what the numbers can't account for. */
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
      {subtitle !== undefined && (
        <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
      )}
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
  // Negative top margin pulls the caveat up against its heading, so the section
  // gap still reads as separating the heading block from the content.
  sectionSubtitle: { ...typography.bodySmall, marginTop: -spacing.xs },
});
