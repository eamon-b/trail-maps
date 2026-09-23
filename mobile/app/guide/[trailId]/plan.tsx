/**
 * Plan screen — the day planner.
 *
 * The plan is a document now (`@lib/plan-types` `PlanDocument`), one per trail,
 * stored in SQLite and edited only by tapping places on and off the Stops list.
 * Nothing on this screen generates a split by itself: the day cards are
 * `computePlanDays` over the stops the hiker chose. That is the whole point of
 * the rebuild — the old screen recomputed its own boundaries on every input
 * change, so there was nothing a hiker could hold on to.
 *
 * Most planning happens a few days at a time from wherever the hiker is, so
 * (issue 81):
 * - the "Next days" card suggests ranked alternative plans for the next few
 *   nights from the GPS km (else the last stop), by hours and pace or by
 *   distance/climb/hours ranges (`@lib/day-suggest`). Nothing is applied until
 *   the hiker picks one, and applying replaces only the stops in its window;
 * - the stretch after the last stop is "not planned yet" rather than one huge
 *   final day (`splitUnplannedTail`);
 * - with a GPS fix the screen scrolls to a "You are here" divider in the
 *   Stops list.
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { resupplySummaryText } from '@lib/resupply-display';
import { trailElevationIsUsable } from '@lib/elevation-backfill';
import { getDirectionLabel, KM_EPSILON } from '@lib/plan-direction';
import type { PlanTrail } from '@lib/day-calculator';
import { isSearchable, type SuggestDaysResult, type SuggestedPlan } from '@lib/day-suggest';
import type { PlanDocument, SectionConfig } from '@lib/plan-types';
import {
  computePlanDays,
  setDirection,
  setNights,
  setPlanName,
  setStartDate,
  setStopBooked,
  setStopNote,
  splitUnplannedTail,
  toggleStop,
} from '@lib/plan-editor';
import { useTheme } from '../../../src/theme';
import { radii, spacing, typography } from '../../../src/tokens';
import { useSettingsStore, type Units } from '../../../src/state/settings-store';
import { selectPlan, selectPlanError, usePlansStore } from '../../../src/state/plans-store';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { useGuidePositionContext } from '../../../src/features/guide/GuidePositionContext';
import {
  computePlanExtras,
  overnightWaypoints,
  PACE_KMH,
  planFloorHours,
  type PlanDay,
  type PlanExtras,
} from '../../../src/features/plan/plan-adapters';
import {
  planDirectionOf,
  stopCandidates,
  stopKeyOf,
  toggleTargetOf,
} from '../../../src/features/plan/plan-stops';
import {
  applySuggestion,
  defaultSuggestPrefs,
  suggestNextDays,
  suggestionCriteria,
  suggestionStart,
  type SearchCandidate,
} from '../../../src/features/plan/plan-suggest';
import { NextDaysCard } from '../../../src/features/plan/NextDaysCard';
import { sectionOptions } from '../../../src/features/plan/plan-section';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { usePlanSyncError } from '../../../src/features/plan/use-plan-sync-error';
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
  const setSuggestPrefs = usePlanInputsStore((s) => s.setSuggestPrefs);
  const position = useGuidePositionContext();
  // Only an on-trail fix is a place to plan from; off-trail km is the nearest
  // point of a trail the hiker is not on.
  const currentKm = position.status === 'fix' ? position.currentKm : null;

  // The two ways a plan can be out of step with itself, in the order that
  // matters: an edit this screen refused, then a write the server did.
  const editError = usePlansStore(selectPlanError(trailId));
  const syncError = usePlanSyncError(plan?.id);
  const notice = planNotice(editError, syncError);

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

  const validSection = sectionConfig.endKm > sectionConfig.startKm && options.length >= 2;

  // Camp/hut km (the snapper's narrower set — a town stop is a stop, not a
  // campsite), used only to pick the day card's end glyph.
  const campKms = useMemo(() => new Set(overnightWaypoints(trail).map((c) => c.km)), [trail]);

  const days = useMemo<PlanDay[]>(() => {
    if (!validSection) return [];
    const computed = computePlanDays(trail as unknown as PlanTrail, displayPlan, {
      baseKmh,
      section: sectionConfig,
    });
    return computed.map((day) => {
      const isFinish = day.endKm >= sectionConfig.endKm - KM_EPSILON;
      const endKind = isFinish ? 'finish' : campKms.has(day.endKm) ? 'camp' : 'stop';
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

  // The last stop onwards is a day only once it fits in one — the hiker's own
  // hours plus the same final-day allowance the splitter always granted.
  const { days: plannedDays, unplanned } = useMemo(
    () => splitUnplannedTail(days, prefs.dailyHours + planFloorHours(prefs.dailyHours)),
    [days, prefs.dailyHours],
  ) as { days: PlanDay[]; unplanned: PlanDay | null };
  const plannedKm = plannedDays.reduce((sum, day) => sum + (day.endKm - day.startKm), 0);
  const effectiveDailyKm = plannedDays.length > 0 ? plannedKm / plannedDays.length : 0;

  // The resupply selection is the document's (the web writes the same field);
  // the device-local one is only what a build before that left behind.
  const resupplyStops = displayPlan.resupplyStops ?? prefs.resupplyStops;

  const extras = useMemo(
    () =>
      computePlanExtras(trail, sectionConfig, {
        dailyHours: prefs.dailyHours,
        baseKmh,
        days: plannedDays,
        resupplyStops,
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
      plannedDays,
      resupplyStops,
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

  // --- Next days -----------------------------------------------------------
  const suggestPrefs = prefs.suggest ?? defaultSuggestPrefs(prefs.dailyHours, baseKmh);
  const [preferLastStop, setPreferLastStop] = useState(false);
  const start = suggestionStart(
    displayPlan,
    sectionConfig,
    trail.track.totalDistance,
    currentKm,
    preferLastStop,
  );
  const criteria = suggestionCriteria(suggestPrefs, prefs.dailyHours);
  // A result belongs to the inputs it was searched with; any change hides it
  // rather than showing plans that no longer answer the question on screen.
  const searchKey = JSON.stringify([
    suggestPrefs,
    criteria,
    start.km,
    baseKmh,
    sectionConfig.startKm,
    sectionConfig.endKm,
    planDirection,
  ]);
  const [search, setSearch] = useState<{
    key: string;
    result: SuggestDaysResult<SearchCandidate>;
  } | null>(null);
  const suggestion = search?.key === searchKey ? search.result : undefined;
  const runSuggest = () => {
    if (!criteria || !isSearchable(criteria)) return;
    setSearch({
      key: searchKey,
      result: suggestNextDays(trail, {
        start,
        section: sectionConfig,
        prefs: suggestPrefs,
        criteria,
        baseKmh,
        direction: planDirection,
      }),
    });
  };
  const applyChosen = (chosen: SuggestedPlan<SearchCandidate>) => {
    const startKm = start.km;
    const total = trail.track.totalDistance;
    edit((p) => applySuggestion(p, startKm, chosen, total));
    setSearch(null);
  };

  // --- Scroll to "You are here" ----------------------------------------------
  // Once per visit, on the first layout of the divider with an on-trail fix:
  // a plan is read from where you are, not from the trail start.
  // The content lives in its own View (not `contentContainerStyle`) so the
  // divider can be measured against something with a ref.
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const scrolledToHere = useRef(false);
  const onHereLayout = useCallback((marker: View) => {
    const inner = contentRef.current;
    if (scrolledToHere.current || !inner) return;
    marker.measureLayout(
      inner,
      (_x, y) => {
        scrolledToHere.current = true;
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true });
      },
      () => {},
    );
  }, []);

  return (
    <ScrollView ref={scrollRef} style={[styles.root, { backgroundColor: colors.background }]}>
      <View ref={contentRef} style={styles.content}>
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

        {notice !== null && (
          <Text style={[styles.notice, { color: colors.danger }]} accessibilityRole="alert">
            {notice}
          </Text>
        )}

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
          <View
            style={[styles.guard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.guardText, { color: colors.textSecondary }]}>
              Choose a start before the end to build a plan.
            </Text>
          </View>
        ) : (
          <>
            <View
              style={[
                styles.summary,
                { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              ]}
            >
              <SummaryStat label="Days" value={String(plannedDays.length)} />
              <SummaryStat label="Planned" value={formatDistance(plannedKm, units)} />
              <SummaryStat label="Avg/day" value={formatDistance(effectiveDailyKm, units)} />
              <SummaryStat
                label="Not planned"
                value={formatDistance(unplanned ? unplanned.endKm - unplanned.startKm : 0, units)}
              />
            </View>

            <NextDaysCard
              prefs={suggestPrefs}
              onPrefs={(next) => setSuggestPrefs(trailId, next)}
              start={start}
              hasFix={currentKm !== null}
              onUseLocation={position.isTracking ? undefined : () => void position.start()}
              preferLastStop={preferLastStop}
              onPreferLastStop={setPreferLastStop}
              dailyHours={prefs.dailyHours}
              units={units}
              result={suggestion}
              blocked={
                criteria === null
                  ? 'Switch on at least one range to suggest plans.'
                  : !isSearchable(criteria)
                    ? 'Give at least one range a maximum.'
                    : null
              }
              onSuggest={runSuggest}
              onApply={applyChosen}
            />

            <Section
              title="Day splits"
              subtitle={
                distanceOnly
                  ? "Distance-only estimate — no elevation data, so climbing time isn't included."
                  : undefined
              }
            >
              <DaySplitList
                days={plannedDays}
                unplanned={unplanned}
                targetHours={prefs.dailyHours}
                units={units}
              />
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
                currentKm={currentKm}
                onHereLayout={onHereLayout}
              />
            </Section>

            <Section
              title="Resupply"
              subtitle={resupplySubtitle(extras, units, resupplyStops === undefined)}
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
      </View>
    </ScrollView>
  );
}

/**
 * The one line under the header card when something did not land.
 *
 * A refused edit comes first: it is the tap the hiker just made, and it did not
 * change the plan at all. A failed write did — locally — so it is reported as
 * what it is, a copy the server has not got.
 */
function planNotice(editError: string | null, syncError: string | null): string | null {
  if (editError) return `Not saved: ${editError}`;
  if (syncError) return `Not synced: ${syncError}`;
  return null;
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

  // Pulled up against the card it belongs to, the way a section's caveat is.
  notice: { ...typography.bodySmall, marginTop: -spacing.md },

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
