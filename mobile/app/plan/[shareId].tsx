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
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { computePlanDays } from '@lib/plan-editor';
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
import { DEFAULT_PREFS } from '../../src/features/plan/plan-inputs-store';
import { PACE_KMH, type PlanDay } from '../../src/features/plan/plan-adapters';
import { DaySplitList } from '../../src/features/plan/DaySplitList';

export const LOAD_FAILED_MESSAGE = "Couldn't open that shared plan. The link may have been revoked.";
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

  // The bundled trail, oriented the way the plan was made: `computePlanDays`
  // converts the stops out of their NOBO-absolute storage, but it cannot
  // reverse a track, so a SOBO plan needs the reversed guide trail.
  const trail = useMemo<TrailJson | null>(() => {
    if (!shared) return null;
    const raw = getTrailJson(shared.trailId);
    if (!raw) return null;
    return resolveGuideTrail(raw, shared.document.direction === 'SOBO' ? 'reversed' : 'default');
  }, [shared]);

  const days = useMemo<PlanDay[]>(() => {
    if (!shared || !trail) return [];
    const computed = computePlanDays(trail as unknown as PlanTrail, shared.document, {
      baseKmh: PACE_KMH[DEFAULT_PREFS.pace],
    });
    return computed.map((day, i) => ({
      ...day,
      endKind: i === computed.length - 1 ? ('finish' as const) : ('stop' as const),
      snappedToCamp: false,
    }));
  }, [shared, trail]);

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

  const onSave = useCallback(() => {
    if (!shared || !trail || saving) return;
    const { document, trailId } = shared;
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
  }, [shared, trail, saving, save]);

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

        <DaySplitList days={days} targetHours={DEFAULT_PREFS.dailyHours} units={units} />

        <Pressable
          onPress={onSave}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save as my plan"
          accessibilityState={{ disabled: saving }}
          style={[
            styles.action,
            { backgroundColor: colors.accent },
            saving && styles.disabled,
          ]}
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
