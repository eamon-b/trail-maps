/**
 * Share an imported guide to the community (`plans/community-routes.md`).
 *
 * Reached from an imported guide's header (share icon) or its long-press menu
 * on My Guides, with `?trailId=u_…`. The hiker names and describes the route,
 * picks its country and region, optionally credits a source, and ticks the CC0
 * confirmation. The shared automatic checks (`@lib/community-checks`) run on
 * the stored trail as they type, so a route that will be refused says so
 * before anything is sent; the worker runs the same checks again and its
 * answer (a 422 with checks, a 409 duplicate, a 429 over the daily limit) is
 * shown here too.
 *
 * What is sent is the stored `ProcessedTrail` — the phone keeps no raw GPX.
 * On success the new route is added to the cached list and the guide opens
 * under its community id, downloading the server's copy from `trailUrl` like
 * any other community route: the phone's pre-submit trail is not the server's
 * rebuilt one (its config, climb and fields differ), so it is never filed
 * under the server's md5.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { COMMUNITY_LIMITS, type CommunityCheck } from '@lib/community-types';
import { runCommunityChecks } from '@lib/community-checks';
import { COUNTRIES, findCountry } from '@lib/trail-regions';
import { useTheme } from '../src/theme';
import { KeyboardAwareScrollView } from '../src/navigation/KeyboardAwareScrollView';
import { glyphSizes, radii, spacing, typography } from '../src/tokens';
import { loadTrail, type TrailJson } from '../src/services/trail-loader';
import { getBaseUrl } from '../src/api/client';
import { submitCommunityRoute } from '../src/api/community';
import { useIdentityStore } from '../src/state/identity-store';
import { upsertCommunitySummary } from '../src/services/community-routes';
import { validateDisplayName, MAX_DISPLAY_NAME_LENGTH } from '../src/features/comments/display-name';
import {
  RIGHTS_TEXT,
  buildSubmitRequest,
  initialShareForm,
  shareFailure,
  validateShareForm,
  type ShareForm,
} from '../src/features/community/share-form';
import { ChecksList, ChoiceChips } from '../src/features/community/CommunityUi';

/** Re-run the checks this long after the last keystroke, not on every one. */
const CHECK_DEBOUNCE_MS = 400;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const COUNTRY_CHOICES = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));

export default function ShareRouteScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { trailId } = useLocalSearchParams<{ trailId?: string }>();

  // Only an import can be shared: anything else reads as "nothing to share".
  const shareableId = trailId && trailId.startsWith('u_') ? trailId : null;
  const [loaded, setLoaded] = useState<{ id: string; trail: TrailJson | null } | null>(null);
  // undefined = still loading; null = nothing to share.
  const trail: TrailJson | null | undefined = !shareableId
    ? null
    : loaded?.id === shareableId
      ? loaded.trail
      : undefined;
  const [form, setForm] = useState<ShareForm>(initialShareForm(''));
  const [displayName, setDisplayName] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; checks?: CommunityCheck[] } | null>(
    null,
  );

  const identityStatus = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);
  useEffect(() => {
    void useIdentityStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!shareableId) return;
    let cancelled = false;
    loadTrail(shareableId)
      .then((result) => {
        if (cancelled) return;
        setLoaded({ id: shareableId, trail: result });
        if (result) setForm(initialShareForm(result.config.name));
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: shareableId, trail: null });
      });
    return () => {
      cancelled = true;
    };
  }, [shareableId]);

  const update = useCallback(<K extends keyof ShareForm>(key: K, value: ShareForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const debouncedName = useDebounced(form.name, CHECK_DEBOUNCE_MS);
  const debouncedDescription = useDebounced(form.description, CHECK_DEBOUNCE_MS);
  const checks = useMemo(() => {
    if (!trail) return null;
    return runCommunityChecks(trail, { name: debouncedName, description: debouncedDescription });
  }, [trail, debouncedName, debouncedDescription]);

  const errors = validateShareForm(form);
  const needsName = identityStatus !== 'registered';
  const nameCheck = needsName ? validateDisplayName(displayName) : null;
  const displayNameError = nameCheck && !nameCheck.ok ? nameCheck.message : null;
  const country = findCountry(form.country);

  const onSubmit = useCallback(async () => {
    setShowErrors(true);
    setFailure(null);
    if (!trail || Object.keys(validateShareForm(form)).length > 0 || displayNameError) return;
    const local = runCommunityChecks(trail, { name: form.name, description: form.description });
    if (!local.ok) {
      setFailure({ message: 'Fix the problems the checks found first.', checks: local.checks });
      return;
    }
    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      setFailure({ message: 'Sharing is not available in this build.' });
      return;
    }
    if (JSON.stringify(trail).length > COMMUNITY_LIMITS.trailJsonMaxBytes) {
      setFailure({ message: 'This route is too large to share.' });
      return;
    }
    setSubmitting(true);
    try {
      let active = session;
      if (!active) {
        const check = validateDisplayName(displayName);
        if (!check.ok) return;
        active = await useIdentityStore.getState().register(check.value);
      }
      const detail = await submitCommunityRoute(
        { baseUrl, token: active.token },
        buildSubmitRequest(form, trail),
      );
      upsertCommunitySummary(detail);
      router.replace({ pathname: '/guide/[trailId]', params: { trailId: detail.id } });
    } catch (err) {
      setFailure(shareFailure(err));
    } finally {
      setSubmitting(false);
    }
  }, [trail, form, displayName, displayNameError, session, router]);

  if (trail === undefined) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  if (trail === null) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Nothing to share</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Only a guide you imported can be shared to the community.
        </Text>
      </View>
    );
  }

  const fieldError = (msg: string | undefined | null) =>
    showErrors && msg ? (
      <Text style={[styles.error, { color: colors.danger }]}>{msg}</Text>
    ) : null;
  const inputStyle = [
    styles.input,
    { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface },
  ];

  return (
    <KeyboardAwareScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Shared routes are public and listed as Unverified until the Tracknotes team checks them.
      </Text>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Route name</Text>
        <TextInput
          style={inputStyle}
          value={form.name}
          onChangeText={(v) => update('name', v)}
          maxLength={COMMUNITY_LIMITS.nameMax}
          accessibilityLabel="Route name"
          placeholderTextColor={colors.textSecondary}
        />
        {fieldError(errors.name)}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Description</Text>
        <TextInput
          style={[inputStyle, styles.multiline]}
          value={form.description}
          onChangeText={(v) => update('description', v)}
          maxLength={COMMUNITY_LIMITS.descriptionMax}
          multiline
          textAlignVertical="top"
          placeholder="Where it goes, what it is like, when to walk it"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Description"
        />
        {fieldError(errors.description)}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Credit or source (optional)</Text>
        <TextInput
          style={inputStyle}
          value={form.credit}
          onChangeText={(v) => update('credit', v)}
          maxLength={COMMUNITY_LIMITS.creditMax}
          placeholder="e.g. Recorded by me, 2026"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Credit or source"
        />
        {fieldError(errors.credit)}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Country</Text>
        <ChoiceChips
          choices={COUNTRY_CHOICES}
          selected={form.country}
          onSelect={(code) => setForm((f) => ({ ...f, country: code, state: null }))}
          accessibilityLabel="Country"
        />
        {fieldError(errors.country)}
      </View>

      {country && country.states.length > 0 && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Region</Text>
          <ChoiceChips
            choices={country.states.map((s) => ({ value: s.code, label: s.name }))}
            selected={form.state}
            onSelect={(code) => update('state', code)}
            accessibilityLabel="Region"
          />
          {fieldError(errors.state)}
        </View>
      )}

      {needsName && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Your display name</Text>
          <TextInput
            style={inputStyle}
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            placeholder="Shown as who shared the route"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Your display name"
            autoCorrect={false}
          />
          {fieldError(displayNameError)}
        </View>
      )}

      <Pressable
        onPress={() => update('rightsConfirmed', !form.rightsConfirmed)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: form.rightsConfirmed }}
        accessibilityLabel={RIGHTS_TEXT}
        style={styles.checkboxRow}
      >
        <MaterialCommunityIcons
          name={form.rightsConfirmed ? 'checkbox-marked' : 'checkbox-blank-outline'}
          size={glyphSizes.lg}
          color={form.rightsConfirmed ? colors.accent : colors.textSecondary}
        />
        <Text style={[styles.checkboxText, { color: colors.textPrimary }]}>{RIGHTS_TEXT}</Text>
      </Pressable>
      {fieldError(errors.rights)}

      {checks && (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Automatic checks</Text>
          <ChecksList checks={checks.checks} />
        </View>
      )}

      {failure && (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.danger }]}>
          <Text style={[styles.cardTitle, { color: colors.danger }]}>{failure.message}</Text>
          {failure.checks && <ChecksList checks={failure.checks} />}
        </View>
      )}

      <Pressable
        onPress={() => void onSubmit()}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel="Share route"
        accessibilityState={{ disabled: submitting }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: submitting ? colors.accentMuted : colors.accent },
          pressed && styles.pressed,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color={colors.accentText} />
        ) : (
          <Text style={[styles.buttonText, { color: colors.accentText }]}>Share route</Text>
        )}
      </Pressable>

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
      >
        <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>Cancel</Text>
      </Pressable>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { ...typography.displaySmall, textAlign: 'center' },
  body: { ...typography.bodySmall },
  field: { gap: spacing.sm },
  label: { ...typography.caption },
  input: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  multiline: { minHeight: 120 },
  error: { ...typography.caption },
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  checkboxText: { ...typography.bodySmall, flex: 1 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { ...typography.titleSmall },
  button: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
  },
  buttonText: { ...typography.titleSmall },
  secondary: { alignItems: 'center', paddingVertical: spacing.sm },
  secondaryText: { ...typography.bodySmall },
  pressed: { opacity: 0.6 },
});
