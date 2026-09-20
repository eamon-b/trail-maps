/**
 * Plan screen — the day planner.
 *
 * The plan is a document now (`@lib/plan-types` `PlanDocument`), one per trail,
 * stored in SQLite and edited only by tapping places on and off the Stops list.
 * Nothing on this screen generates a split by itself: the day cards are
 * `computePlanDays` over the stops the hiker chose, and the hours-and-pace
 * splitter survives solely as the "Suggest stops" button, which fills an EMPTY
 * list once and then gets out of the way (plans/day-planner.md, "Suggest, never
 * generate"). That is the whole point of the rebuild — the old screen recomputed
 * its own boundaries on every input change, so there was nothing a hiker could
 * hold on to.
 *
 * Direction still belongs to the guide. The guide trail is direction-applied,
 * while stops are stored NOBO-absolute (`@lib/plan-direction`), so the screen
 * converts at the edges (`plan-stops.ts`) and keeps the document's `direction`
 * in step with the guide's — flipping direction never moves a stop.
 *
 * The section steppers, pace and daily hours stay. Pace and hours drive the
 * Naismith estimates on the day cards and the "Suggest stops" split; the
 * section scopes the whole screen, including the resupply and water cards,
 * which are unchanged apart from taking the realized km/day of the *planned*
 * split rather than a generated one.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { resupplySummaryText } from '@lib/resupply-display';
import { trailElevationIsUsable } from '@lib/elevation-backfill';
import { getDirectionLabel } from '@lib/plan-direction';
import type { PlanTrail } from '@lib/day-calculator';
import type { PlanDocument, SectionConfig } from '@lib/plan-types';
import {
  computePlanDays,
  setDirection,
  setNights,
  setPlanName,
  setStartDate,
  setStopBooked,
  setStopNote,
  toggleStop,
} from '@lib/plan-editor';
import { useTheme } from '../../../src/theme';
import { radii, spacing, typography } from '../../../src/tokens';
import { useSettingsStore, type Units } from '../../../src/state/settings-store';
import { selectPlan, usePlansStore } from '../../../src/state/plans-store';
import { useGuide } from '../../../src/features/guide/GuideContext';
import {
  computePlanExtras,
  overnightWaypoints,
  PACE_KMH,
  type PlanDay,
  type PlanExtras,
} from '../../../src/features/plan/plan-adapters';
import {
  planDirectionOf,
  stopCandidates,
  stopKeyOf,
  suggestedStops,
  toggleTargetOf,
} from '../../../src/features/plan/plan-stops';
import { sectionOptions } from '../../../src/features/plan/plan-section';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { PlanHeaderCard } from '../../../src/features/plan/PlanHeaderCard';
import { PlanInputsCard } from '../../../src/features/plan/PlanInputsCard';
import { DaySplitList } from '../../../src/features/plan/DaySplitList';
import { StopsSection } from '../../../src/features/plan/StopsSection';
import { ResupplyCard } from '../../../src/features/plan/ResupplyCard';
import { WaterCarryCard } from '../../../src/features/plan/WaterCarryCard';
import { formatFoodWeight } from '../../../src/features/plan/plan-format';

export default function PlanScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { trail, trailId, direction } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const planDirection = planDirectionOf(direction);

  const plan = usePlansStore(selectPlan(trailId));
  const hydratePlan = usePlansStore((s) => s.hydrate);
  const applyEdit = usePlansStore((s) => s.apply);

  useEffect(() => {
    void hydratePlan(trailId);
  }, [hydratePlan, trailId]);

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
  const sectionConfig: SectionConfig = {
    startKm: startOption?.km ?? 0,
    endKm: endOption?.km ?? trail.track.totalDistance,
    startName: startOption?.name ?? `${trail.config.name} Start`,
    endName: endOption?.name ?? `${trail.config.name} End`,
  };
  const baseKmh = PACE_KMH[prefs.pace];

  // The document the screen renders. A trail with no plan yet shows an empty
  // one (the whole section as a single day) rather than a blank screen — the
  // real document is minted by the first edit, so an untouched guide never
  // accumulates a plan to sync.
  //
  // Its direction is forced to the guide's for THIS render. The effect below
  // persists that, but an effect runs after the paint, and rendering one frame
  // of stops mirrored about the wrong end would visibly jump.
  const displayPlan = useMemo<PlanDocument>(() => {
    const base: PlanDocument = plan ?? {
      id: '',
      trailId,
      name: '',
      direction: planDirection,
      startDate: null,
      stops: [],
      updatedAt: '',
      version: 1,
    };
    return base.direction === planDirection ? base : { ...base, direction: planDirection };
  }, [plan, planDirection, trailId]);

  useEffect(() => {
    if (plan && plan.direction !== planDirection) {
      void applyEdit(trailId, (p) => setDirection(p, planDirection));
    }
  }, [applyEdit, plan, planDirection, trailId]);

  const sectionKm = Math.max(0, sectionConfig.endKm - sectionConfig.startKm);
  const validSection = sectionConfig.endKm > sectionConfig.startKm && options.length >= 2;

  // Camp/hut km (the snapper's narrower set — a town stop is a stop, not a
  // campsite), used only to pick the day card's end glyph.
  const campKms = useMemo(
    () => new Set(overnightWaypoints(trail).map((c) => c.km)),
    [trail],
  );

  const days = useMemo<PlanDay[]>(() => {
    if (!validSection) return [];
    const computed = computePlanDays(trail as unknown as PlanTrail, displayPlan, {
      baseKmh,
      section: sectionConfig,
    });
    return computed.map((day, i) => {
      const isLast = i === computed.length - 1;
      const endKind = isLast ? 'finish' : campKms.has(day.endKm) ? 'camp' : 'stop';
      return { ...day, endKind, snappedToCamp: endKind === 'camp' };
    });
    // sectionConfig is rebuilt each render from these four primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    trail,
    displayPlan,
    baseKmh,
    validSection,
    campKms,
    sectionConfig.startKm,
    sectionConfig.endKm,
    sectionConfig.startName,
    sectionConfig.endName,
  ]);

  const effectiveDailyKm = days.length > 0 ? sectionKm / days.length : baseKmh * prefs.dailyHours;

  const extras = useMemo(
    () =>
      computePlanExtras(trail, sectionConfig, {
        dailyHours: prefs.dailyHours,
        baseKmh,
        days,
        resupplyStops: prefs.resupplyStops,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      trail,
      sectionConfig.startKm,
      sectionConfig.endKm,
      sectionConfig.startName,
      sectionConfig.endName,
      prefs.dailyHours,
      baseKmh,
      days,
      prefs.resupplyStops,
    ],
  );

  const [showAllWaypoints, setShowAllWaypoints] = useState(false);
  const candidates = useMemo(
    () => stopCandidates(trail, planDirection, { all: showAllWaypoints }),
    [trail, planDirection, showAllWaypoints],
  );

  // Naismith's climbing term is silently zero for a trail with no profile, so
  // the day splits look the same as a properly-derived plan while being
  // optimistic on anything steep. Say so rather than let the number pass for
  // more than it is. (An imported GPX can be given a profile from the import
  // screen's "Fetch elevation".)
  const distanceOnly = !trailElevationIsUsable(trail);

  const planDefaults = { name: trail.config.name, direction: planDirection };
  const edit = (fn: (p: PlanDocument) => PlanDocument) => {
    void applyEdit(trailId, fn, planDefaults);
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <PlanHeaderCard
        name={displayPlan.name}
        namePlaceholder={trail.config.name}
        startDate={displayPlan.startDate}
        directionLabel={getDirectionLabel(trail.config.direction, planDirection, {
          default: 'Start → End',
          reversed: 'End → Start',
        })}
        onName={(name) => edit((p) => setPlanName(p, name))}
        onStartDate={(iso) => edit((p) => setStartDate(p, iso))}
      />

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
        canSuggestStops={validSection && displayPlan.stops.length === 0}
        onSuggestStops={() => {
          const suggested = suggestedStops(
            trail,
            sectionConfig,
            prefs.dailyHours,
            baseKmh,
            planDirection,
          );
          if (suggested.length === 0) return;
          // One edit, one write: toggling each stop through its own `apply`
          // would be a SQLite round trip (and later a PUT) per day.
          edit((p) =>
            suggested.reduce((acc, candidate) => toggleStop(acc, toggleTargetOf(candidate)), p),
          );
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
            <SummaryStat label="Days" value={String(days.length)} />
            <SummaryStat label="Distance" value={formatDistance(sectionKm, units)} />
            <SummaryStat label="Avg/day" value={formatDistance(effectiveDailyKm, units)} />
          </View>

          <Section
            title="Day splits"
            subtitle={
              distanceOnly
                ? "Distance-only estimate — no elevation data, so climbing time isn't included."
                : undefined
            }
          >
            <DaySplitList days={days} targetHours={prefs.dailyHours} units={units} />
          </Section>

          <Section
            title="Stops"
            subtitle="Tap a place to make it a stop. Tap it again to take it out."
          >
            <StopsSection
              candidates={candidates}
              plan={plan}
              pois={trail.pois}
              units={units}
              showAll={showAllWaypoints}
              onShowAll={setShowAllWaypoints}
              onToggle={(c) => edit((p) => toggleStop(p, toggleTargetOf(c)))}
              onNights={(c, nights) => edit((p) => setNights(p, stopKeyOf(c), nights))}
              onNote={(c, note) => edit((p) => setStopNote(p, stopKeyOf(c), note))}
              onBooked={(c, booked) => edit((p) => setStopBooked(p, stopKeyOf(c), booked))}
            />
          </Section>

          <Section
            title="Resupply"
            subtitle={resupplySubtitle(extras, units, prefs.resupplyStops === undefined)}
            action={
              extras.resupplyGroups.length > 0 ? (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/resupply',
                      params: {
                        trailId,
                        startKm: String(sectionConfig.startKm),
                        endKm: String(sectionConfig.endKm),
                      },
                    })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Choose stops"
                  hitSlop={spacing.sm}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Text style={[styles.chooseStops, { color: colors.accent }]}>Choose stops</Text>
                </Pressable>
              ) : undefined
            }
          >
            <ResupplyCard
              legs={extras.resupplyLegs}
              hasOptions={extras.resupplyGroups.length > 0}
              stopCount={extras.resupplyStops.length}
              units={units}
            />
          </Section>

          <Section title="Water carries">
            <WaterCarryCard
              carries={extras.topWaterCarries}
              hasData={extras.water.hasWaterData}
              units={units}
            />
          </Section>
        </>
      )}
    </ScrollView>
  );
}

/**
 * The Resupply subtitle: the legs' own one-liner, so subtitle and card cannot
 * disagree. Before a plan is made it says so — a hiker should be able to tell
 * the every-option default from a plan that happens to tick everything.
 */
function resupplySubtitle(
  extras: PlanExtras,
  units: Units,
  everyOption: boolean,
): string | undefined {
  // Nothing to summarise on a trail with no resupply at all — the card says so.
  if (extras.resupplyGroups.length === 0) return undefined;
  if (!extras.resupplySummary.hasData) return 'No resupply stops ticked.';
  const text = resupplySummaryText(
    extras.resupplySummary,
    (km) => formatDistance(km, units),
    (kg) => formatFoodWeight(kg, units),
  );
  return everyOption ? `Every option · ${text}` : text;
}

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  /** One line of caveat under the heading, e.g. what the numbers can't account for. */
  subtitle?: string;
  /** Optional control on the heading row, right-aligned (e.g. "Choose stops"). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
        {action}
      </View>
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
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { ...typography.titleLarge },
  chooseStops: { ...typography.bodySmall, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  // Negative top margin pulls the caveat up against its heading, so the section
  // gap still reads as separating the heading block from the content.
  sectionSubtitle: { ...typography.bodySmall, marginTop: -spacing.xs },
});
