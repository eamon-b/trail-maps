/**
 * About a community route: its status (Verified / Unverified, or "No longer
 * shared" and what that means), description, credit and licence, a Report
 * form for anyone but its owner, Delete for the hiker who shared it, and
 * "Remove from this phone" for a downloaded copy. Reached from the guide
 * header, the banner above a community guide and a long-press on its card.
 *
 * The detail is fetched with the device token when there is one, which is how
 * the server says `isOwner`; a 404 marks the copy on this phone taken down.
 * Offline, the cached list row is shown and the actions that need the server
 * wait. Delete and Remove both clear everything local about the route
 * (`services/local-trail-data`).
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CommunityRouteDetail } from '@lib/community-types';
import { formatDistance } from '@lib/format-distance';
import { stateName, countryName } from '@lib/trail-regions';
import { useTheme } from '../../../src/theme';
import { KeyboardAwareScrollView } from '../../../src/navigation/KeyboardAwareScrollView';
import { radii, spacing, typography } from '../../../src/tokens';
import { ApiError, getBaseUrl } from '../../../src/api/client';
import { apiErrorMessage } from '../../../src/api/error-message';
import {
  deleteCommunityRoute,
  getCommunityRoute,
  reportCommunityRoute,
} from '../../../src/api/community';
import { useIdentityStore } from '../../../src/state/identity-store';
import { useSettingsStore } from '../../../src/state/settings-store';
import { useTrailDataStore } from '../../../src/state/trail-data-store';
import {
  forgetCommunityRoute,
  getCommunityRouteInfo,
  markCommunityRouteTakenDown,
  removeCommunityRouteFromDevice,
  upsertCommunitySummary,
} from '../../../src/services/community-routes';
import {
  ChoiceChips,
  CommunityStatusPill,
  communityStatusExplanation,
} from '../../../src/features/community/CommunityUi';
import {
  MAX_REPORT_NOTE_LENGTH,
  REPORT_REASON_CHOICES,
  validateReport,
} from '../../../src/features/community/community-route';
import {
  MAX_DISPLAY_NAME_LENGTH,
  validateDisplayName,
} from '../../../src/features/comments/display-name';

export default function CommunityRouteScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  // Re-read when the cached list or a download changes (a 404 flags it below).
  useTrailDataStore((s) => s.revision);
  const cached = getCommunityRouteInfo(trailId);

  const session = useIdentityStore((s) => s.session);
  const identityStatus = useIdentityStore((s) => s.status);
  const [detail, setDetail] = useState<CommunityRouteDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !!getBaseUrl());

  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reportState, setReportState] = useState<
    { status: 'idle' } | { status: 'sending' } | { status: 'sent' } | { status: 'error'; message: string }
  >({ status: 'idle' });

  useEffect(() => {
    void useIdentityStore.getState().hydrate();
  }, []);

  useEffect(() => {
    const baseUrl = getBaseUrl();
    if (!baseUrl) return;
    let cancelled = false;
    getCommunityRoute({ baseUrl, token: session?.token }, trailId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoadError(null);
        // Keep the cached row's name and status current.
        upsertCommunitySummary(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const gone = err instanceof ApiError && err.status === 404;
        if (gone) markCommunityRouteTakenDown(trailId);
        setLoadError(
          gone
            ? 'This route is no longer shared. The copy on this phone keeps working until you remove it.'
            : apiErrorMessage(err, 'Couldn’t load this route’s details.'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trailId, session?.token]);

  const onReport = useCallback(async () => {
    const baseUrl = getBaseUrl();
    const checked = validateReport(reason, note);
    if (!checked.ok) {
      setReportState({ status: 'error', message: checked.message });
      return;
    }
    if (!baseUrl) return;
    setReportState({ status: 'sending' });
    try {
      let active = session;
      if (!active) {
        const name = validateDisplayName(displayName);
        if (!name.ok) {
          setReportState({ status: 'error', message: name.message });
          return;
        }
        active = await useIdentityStore.getState().register(name.value);
      }
      await reportCommunityRoute({ baseUrl, token: active.token }, trailId, {
        reason: checked.reason,
        note: checked.note,
      });
      setReportState({ status: 'sent' });
    } catch (err) {
      setReportState({
        status: 'error',
        message: apiErrorMessage(err, 'Couldn’t send your report. Please try again.'),
      });
    }
  }, [reason, note, displayName, session, trailId]);

  const onDelete = useCallback(() => {
    const baseUrl = getBaseUrl();
    if (!baseUrl || !session) return;
    Alert.alert(
      'Delete shared route',
      'Remove this route from the community list for everyone? The guide you imported stays on this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteCommunityRoute({ baseUrl, token: session.token }, trailId);
                // The route's file, plan, favourites, pin and the rest go too.
                await forgetCommunityRoute(trailId);
                router.dismissTo('/');
              } catch (err) {
                Alert.alert(
                  'Couldn’t delete the route',
                  apiErrorMessage(err, 'Please try again.'),
                );
              }
            })();
          },
        },
      ],
    );
  }, [session, trailId, router]);

  const onRemoveFromPhone = useCallback(() => {
    Alert.alert(
      'Remove from this phone',
      'Remove this route from this phone? Its plan, favourites and routes on this phone go with it. This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeCommunityRouteFromDevice(trailId);
                router.dismissTo('/');
              } catch (err) {
                Alert.alert(
                  'Couldn’t remove the route',
                  err instanceof Error ? err.message : 'Please try again.',
                );
              }
            })();
          },
        },
      ],
    );
  }, [trailId, router]);

  const route = detail ?? cached;
  if (!route) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        {loading ? (
          <ActivityIndicator color={colors.accent} size="large" />
        ) : (
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            {loadError ?? 'This route is not on this phone.'}
          </Text>
        )}
      </View>
    );
  }

  const region = [countryName(route.country), stateName(route.country, route.state)]
    .filter(Boolean)
    .join(' · ');
  const apiConfigured = !!getBaseUrl();
  const takenDown = !detail && cached?.takenDown === true;

  return (
    <KeyboardAwareScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.section}>
        <CommunityStatusPill status={route.status} takenDown={takenDown} />
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          {communityStatusExplanation(route.status, takenDown)} Check conditions and access before
          relying on it.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{route.name}</Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          {[region, formatDistance(route.lengthKm, units)].filter(Boolean).join(' · ')}
        </Text>
        {route.submittedBy ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            Shared by {route.submittedBy}
          </Text>
        ) : null}
      </View>

      {loading && !detail ? <ActivityIndicator color={colors.accent} /> : null}
      {loadError ? (
        <Text style={[styles.body, { color: colors.textSecondary }]}>{loadError}</Text>
      ) : null}

      {detail ? (
        <View style={styles.section}>
          <Text style={[styles.body, { color: colors.textPrimary }]}>{detail.description}</Text>
          {detail.credit ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              Credit: {detail.credit}
            </Text>
          ) : null}
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            Released under CC0 (public domain).
          </Text>
        </View>
      ) : null}

      {/* Only once the detail says who is asking: an owner must not be offered
          a report form on their own route while it loads. */}
      {apiConfigured && detail && !detail.isOwner ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Report route</Text>
          {reportState.status === 'sent' ? (
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              Thanks — the Tracknotes team will look at it.
            </Text>
          ) : (
            <>
              <ChoiceChips
                choices={REPORT_REASON_CHOICES}
                selected={reason}
                onSelect={setReason}
                accessibilityLabel="Report reason"
              />
              <TextInput
                style={[
                  styles.input,
                  { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background },
                ]}
                value={note}
                onChangeText={setNote}
                maxLength={MAX_REPORT_NOTE_LENGTH}
                placeholder="What is wrong? (optional)"
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel="Report note"
                multiline
              />
              {identityStatus !== 'registered' ? (
                <TextInput
                  style={[
                    styles.input,
                    { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                  value={displayName}
                  onChangeText={setDisplayName}
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  placeholder="Your display name"
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel="Your display name"
                  autoCorrect={false}
                />
              ) : null}
              {reportState.status === 'error' ? (
                <Text style={[styles.meta, { color: colors.danger }]}>{reportState.message}</Text>
              ) : null}
              <Pressable
                onPress={() => void onReport()}
                disabled={reportState.status === 'sending'}
                accessibilityRole="button"
                accessibilityLabel="Send report"
                style={({ pressed }) => [
                  styles.secondaryButton,
                  { borderColor: colors.accent },
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
                  {reportState.status === 'sending' ? 'Sending…' : 'Send report'}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      {detail?.isOwner ? (
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete shared route"
          style={({ pressed }) => [
            styles.secondaryButton,
            { borderColor: colors.danger },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.danger }]}>
            Delete shared route
          </Text>
        </Pressable>
      ) : null}

      {cached?.downloaded ? (
        <Pressable
          onPress={onRemoveFromPhone}
          accessibilityRole="button"
          accessibilityLabel="Remove from this phone"
          style={({ pressed }) => [
            styles.secondaryButton,
            { borderColor: colors.border },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>
            Remove from this phone
          </Text>
        </Pressable>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  section: { gap: spacing.sm },
  title: { ...typography.displaySmall },
  body: { ...typography.body },
  meta: { ...typography.bodySmall },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: { ...typography.titleSmall },
  input: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  secondaryButtonText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
