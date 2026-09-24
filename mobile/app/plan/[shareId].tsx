/**
 * A plan someone sent you: `tracknotes://plan/<shareId>`.
 *
 * The share link is read-only by design (plans/day-planner.md) — two hikers
 * walking together each keep their own plan, and merging concurrent edits is
 * explicitly out of scope — so this screen shows the days and offers one
 * action: take a COPY. The copy is a new document with a new id under this
 * device's account, which is what keeps "save" from meaning "join their plan".
 *
 * Deep linking needs no manifest work: `app.json` already declares the
 * `tracknotes` scheme (the dev client uses it), and Expo Router maps the path
 * onto this file. There are no associated domains, so a site URL does NOT open
 * the app; the website's "Open in Tracknotes" button is what produces this URL.
 *
 * The trail is the one thing that cannot be shared: a plan names a trail id,
 * and a phone that does not have that guide bundled has nothing to compute days
 * against. That case says so plainly rather than rendering an empty list.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { computePlanDays, splitUnplannedTail } from '@lib/plan-editor';
import { finalDayMaxHours } from '@lib/plan-suggest';
import type { PlanTrail } from '@lib/day-calculator';
import type { PlanDocument } from '@lib/plan-types';
import { useTheme } from '../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../src/tokens';
import { getBaseUrl } from '../../src/api/client';
import { apiErrorMessage } from '../../src/api/error-message';
import { fetchSharedPlan } from '../../src/api/plans';
import { uuidv4 } from '../../src/api/uuid';
import { getTrailIndexEntry, getTrailJson, type TrailJson } from '../../src/services/trail-loader';
import { resolveGuideTrail } from '../../src/features/guide/guide-trail';
import { useSettingsStore } from '../../src/state/settings-store';
import { usePlansStore } from '../../src/state/plans-store';
import { selectPrefs, usePlanInputsStore } from '../../src/features/plan/plan-inputs-store';
import { PACE_KMH, type PlanDay } from '../../src/features/plan/plan-adapters';
import { DaySplitList } from '../../src/features/plan/DaySplitList';

export const LOAD_FAILED_MESSAGE =
  "Couldn't open that shared plan. The link may have been revoked.";
export const SAVE_FAILED_MESSAGE = "Couldn't save the plan. Please try again.";
export const UNKNOWN_TRAIL_MESSAGE = 'This plan is for a trail this app does not have.';
export const UNCONFIGURED_MESSAGE =
  'This build has no server configured, so shared plans cannot be opened.';

interface Shared {
  document: PlanDocument;
  trailId: string;
  ownerDisplayName: string;
}

export default function SharedPlanScreen() {
  const { shareId } = useLocalSearchParams<{ shareId: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const applyEdit = usePlansStore((s) => s.apply);
  const hydratePlan = usePlansStore((s) => s.hydrate);

  const [shared, setShared] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read once per render rather than inside the effect: an unconfigured build
  // is a render-time fact ("this app cannot open shared plans"), not an error
  // that happens, so it belongs in the output and not in state.
  const baseUrl = getBaseUrl();

  useEffect(() => {
    if (!shareId || !baseUrl) return;
    let cancelled = false;
    fetchSharedPlan({ baseUrl }, shareId)
      .then((res) => {
        if (!cancelled) setShared(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorMessage(err, LOAD_FAILED_MESSAGE));
      });
    return () => {
      cancelled = true;
    };
  }, [shareId, baseUrl]);

  // Nothing has opened this trail's guide on a cold start from a deep link, so
  // the plan cache is empty — and an empty cache is indistinguishable from
  // "this hiker has no plan", which is exactly the question Save has to answer.
  // Read SQLite as soon as the shared plan names its trail.
  const sharedTrailId = shared?.trailId;
  useEffect(() => {
    if (sharedTrailId) void hydratePlan(sharedTrailId);
  }, [hydratePlan, sharedTrailId]);

  // The bundled trail, oriented the way the plan was made: `computePlanDays`
  // converts the stops out of their NOBO-absolute storage, but it cannot
  // reverse a track, so a SOBO plan needs the reversed guide trail.
  const trail = useMemo<TrailJson | null>(() => {
    if (!shared) return null;
    const raw = getTrailJson(shared.trailId);
    if (!raw) return null;
    return resolveGuideTrail(raw, shared.document.direction === 'SOBO' ? 'reversed' : 'default');
  }, [shared]);

  // Estimated at the reader's own pace and hours for this trail (defaults
  // until they set some): the estimates are for whoever is reading the plan.
  const prefs = usePlanInputsStore(selectPrefs(sharedTrailId ?? ''));

  // Like the Plan screen, the stretch after the last stop is "not planned
  // yet" unless it fits in a day — a plan shared a few days in is not one
  // enormous final day.
  const { days, unplanned } = useMemo<{ days: PlanDay[]; unplanned: PlanDay | null }>(() => {
    if (!shared || !trail) return { days: [], unplanned: null };
    const computed = computePlanDays(trail as unknown as PlanTrail, shared.document, {
      baseKmh: PACE_KMH[prefs.pace],
    });
    const split = splitUnplannedTail(computed, finalDayMaxHours(prefs.dailyHours));
    const total = trail.track.totalDistance;
    const toPlanDay = (day: (typeof computed)[number]): PlanDay => ({
      ...day,
      endKind: day.endKm >= total - 0.01 ? 'finish' : 'stop',
      snappedToCamp: false,
    });
    return {
      days: split.days.map(toPlanDay),
      unplanned: split.unplanned ? toPlanDay(split.unplanned) : null,
    };
  }, [shared, trail, prefs.pace, prefs.dailyHours]);

  const save = useCallback(
    async (doc: PlanDocument, trailId: string) => {
      setSaving(true);
      try {
        // A NEW id: this is a copy under this account, not a second device on
        // someone else's document. `apply` persists it and the store's sync
        // hook queues the write (or keeps it local, for an imported trail).
        const copy: PlanDocument = {
          ...doc,
          id: uuidv4(),
          trailId,
          updatedAt: new Date().toISOString(),
        };
        const stored = await applyEdit(trailId, () => copy, { name: doc.name });
        if (!stored) {
          setError(SAVE_FAILED_MESSAGE);
          return;
        }
        router.replace({ pathname: '/guide/[trailId]/plan', params: { trailId } });
      } finally {
        setSaving(false);
      }
    },
    [applyEdit, router],
  );

  const onSave = useCallback(async () => {
    if (!shared || !trail || saving) return;
    const { document, trailId } = shared;
    // The mount hydrate may not have landed yet (or may have failed), and
    // deciding from an un-read cache is how a plan gets replaced — here AND on
    // the server — without the hiker ever being asked. A key present in
    // `byTrail` is the "this has been read" mark; undefined against a present
    // key is a genuine "no plan".
    if (!(trailId in usePlansStore.getState().byTrail)) {
      await hydratePlan(trailId);
    }
    const existing = usePlansStore.getState().byTrail[trailId];
    if (!existing) {
      void save(document, trailId);
      return;
    }
    // One plan per trail is the whole model, so saving a shared one REPLACES
    // what is there. Say that before it happens rather than after.
    Alert.alert(
      'Replace your plan?',
      `You already have a plan for ${getTrailIndexEntry(trailId)?.name ?? 'this trail'}. Saving this one replaces it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => void save(document, trailId) },
      ],
    );
  }, [shared, trail, saving, save, hydratePlan]);

  const body = () => {
    if (!baseUrl) {
      return (
        <Text style={[styles.message, { color: colors.textSecondary }]}>
          {UNCONFIGURED_MESSAGE}
        </Text>
      );
    }
    if (error) {
      return (
        <Text style={[styles.message, { color: colors.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      );
    }
    if (!shared) {
      return <ActivityIndicator color={colors.accent} />;
    }
    if (!trail) {
      return (
        <Text style={[styles.message, { color: colors.textSecondary }]}>
          {UNKNOWN_TRAIL_MESSAGE}
        </Text>
      );
    }
    return (
      <>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.planName, { color: colors.textPrimary }]}>
            {shared.document.name || getTrailIndexEntry(shared.trailId)?.name || 'Shared plan'}
          </Text>
          <Text style={[styles.byline, { color: colors.textSecondary }]}>
            Shared by {shared.ownerDisplayName}
          </Text>
          <Text style={[styles.byline, { color: colors.textSecondary }]}>
            {days.length} {days.length === 1 ? 'day' : 'days'}
            {shared.document.startDate ? ` from ${shared.document.startDate}` : ''}
          </Text>
        </View>

        <DaySplitList
          days={days}
          unplanned={unplanned}
          targetHours={prefs.dailyHours}
          units={units}
        />

        <Pressable
          onPress={() => void onSave()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save as my plan"
          accessibilityState={{ disabled: saving }}
          style={[styles.action, { backgroundColor: colors.accent }, saving && styles.disabled]}
        >
          {saving ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={[styles.actionLabel, { color: colors.accentText }]}>Save as my plan</Text>
          )}
        </Pressable>
        <Text style={[styles.footnote, { color: colors.textSecondary }]}>
          Saving makes your own copy. Their plan is not changed by anything you do here.
        </Text>
      </>
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <Stack.Screen options={{ title: 'Shared plan' }} />
      {body()}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: spacing.lg, gap: spacing.lg },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  planName: { ...typography.titleLarge },
  byline: { ...typography.bodySmall },
  message: { ...typography.body, textAlign: 'center' },
  footnote: { ...typography.caption, textAlign: 'center' },
  action: {
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  actionLabel: { ...typography.titleSmall },
  disabled: { opacity: 0.5 },
});
