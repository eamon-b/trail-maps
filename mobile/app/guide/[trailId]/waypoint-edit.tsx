/**
 * Add or edit a hiker waypoint (`@lib/user-waypoints`).
 *
 * Opened from a long-press on the map (`?lat=&lon=`), the map's ＋ button (the
 * GPS fix), or a hiker waypoint's own detail screen (`?id=` to edit). The hiker
 * names the place, says what kind it is, adds an optional note, and chooses who
 * sees it: only them (kept on this phone) or everyone (shared through the
 * comments API, for the water source or shop the guide is missing).
 *
 * Saving is offline-first (`sync/waypoint-sync`): the waypoint is on the map at
 * once and a shared one is sent when there is a connection. Sharing needs the
 * account comments use, so a hiker who has never posted is asked for a display
 * name here, as the share-route screen does.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { USER_WAYPOINT_LIMITS, type UserWaypointVisibility } from '@lib/user-waypoints';
import { useTheme } from '../../../src/theme';
import { KeyboardAwareScrollView } from '../../../src/navigation/KeyboardAwareScrollView';
import { glyphSizes, radii, spacing, typography } from '../../../src/tokens';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { useGuidePositionContext } from '../../../src/features/guide/GuidePositionContext';
import { ChoiceChips } from '../../../src/features/community/CommunityUi';
import {
  MAX_DISPLAY_NAME_LENGTH,
  validateDisplayName,
} from '../../../src/features/comments/display-name';
import {
  WAYPOINT_TYPE_CHOICES,
  initialWaypointForm,
  numberParam,
  summarisePosition,
  type WaypointForm,
} from '../../../src/features/waypoints/waypoint-form';
import { useSettingsStore } from '../../../src/state/settings-store';
import { useIdentityStore } from '../../../src/state/identity-store';
import { selectUserWaypoint, useUserWaypointsStore } from '../../../src/state/user-waypoints-store';
import {
  canShareWaypoints,
  deleteUserWaypoint,
  saveUserWaypoint,
} from '../../../src/sync/waypoint-sync';
import { checkUserWaypointInput } from '@lib/user-waypoints';

const VISIBILITY_CHOICES: { value: UserWaypointVisibility; label: string }[] = [
  { value: 'private', label: 'Only me' },
  { value: 'shared', label: 'Everyone' },
];

export default function WaypointEditScreen() {
  const params = useLocalSearchParams<{ trailId: string; id?: string; lat?: string; lon?: string }>();
  const trailId = params.trailId;
  const { colors } = useTheme();
  const router = useRouter();
  const { trail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const { position, start: startGps, status: gpsStatus } = useGuidePositionContext();
  const existing = useUserWaypointsStore(selectUserWaypoint(trailId, params.id));
  const identityStatus = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);

  const shareable = canShareWaypoints(trailId);
  const [form, setForm] = useState<WaypointForm>(() =>
    initialWaypointForm(existing, { lat: numberParam(params.lat), lon: numberParam(params.lon) }),
  );
  const [displayName, setDisplayName] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const savingRef = useRef(false);

  const update = useCallback(<K extends keyof WaypointForm>(key: K, value: WaypointForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const placement = useMemo(
    () => summarisePosition(form.lat, form.lon, trail.track.points, trail.track.breaks, units),
    [form.lat, form.lon, trail.track.points, trail.track.breaks, units],
  );

  const check = checkUserWaypointInput({
    name: form.name,
    type: form.type ?? '',
    lat: form.lat ?? Number.NaN,
    lon: form.lon ?? Number.NaN,
    description: form.description,
  });
  const fieldMessage = (field: 'name' | 'type' | 'position' | 'description') =>
    showErrors && !check.ok && check.field === field ? check.message : null;

  const needsName = form.visibility === 'shared' && identityStatus !== 'registered';
  const nameCheck = needsName ? validateDisplayName(displayName) : null;
  const displayNameError = showErrors && nameCheck && !nameCheck.ok ? nameCheck.message : null;

  const useMyLocation = useCallback(() => {
    if (position) {
      setForm((f) => ({ ...f, lat: position.lat, lon: position.lon }));
    } else {
      void startGps();
    }
  }, [position, startGps]);

  // Plain function: the React Compiler memoizes it from what it reads.
  const onSave = async () => {
    if (savingRef.current) return;
    setShowErrors(true);
    setFailure(null);
    if (!check.ok || !placement.ok) return;
    if (needsName && nameCheck && !nameCheck.ok) return;
    savingRef.current = true;
    setSaving(true);
    try {
      let activeName = session?.displayName ?? null;
      if (needsName && nameCheck?.ok) {
        const registered = await useIdentityStore.getState().register(nameCheck.value);
        activeName = registered.displayName;
      }
      await saveUserWaypoint({
        trailId,
        existing,
        visibility: form.visibility,
        displayName: activeName,
        input: {
          name: form.name,
          type: form.type ?? '',
          lat: form.lat ?? Number.NaN,
          lon: form.lon ?? Number.NaN,
          description: form.description,
        },
      });
      router.back();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The waypoint could not be saved.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onDelete = useCallback(() => {
    if (!existing) return;
    Alert.alert(
      'Delete waypoint?',
      existing.visibility === 'shared'
        ? 'It will be removed from this phone and from every other hiker’s guide.'
        : 'It will be removed from this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteUserWaypoint(existing)
              .then(() => router.dismissTo({ pathname: '/guide/[trailId]', params: { trailId } }))
              .catch((err: unknown) =>
                setFailure(err instanceof Error ? err.message : 'The waypoint could not be deleted.'),
              );
          },
        },
      ],
    );
  }, [existing, router, trailId]);

  if (params.id && !existing) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Edit waypoint' }} />
        <Text style={[styles.body, { color: colors.textSecondary }]}>This waypoint no longer exists.</Text>
      </View>
    );
  }
  if (existing && !existing.mine) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Edit waypoint' }} />
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Only the hiker who added this waypoint can edit it.
        </Text>
      </View>
    );
  }

  const inputStyle = [
    styles.input,
    { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface },
  ];
  const errorText = (message: string | null) =>
    message ? (
      <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
        {message}
      </Text>
    ) : null;

  return (
    <KeyboardAwareScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: existing ? 'Edit waypoint' : 'New waypoint' }} />

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.positionRow}>
          <MaterialCommunityIcons
            name="map-marker-outline"
            size={glyphSizes.lg}
            color={placement.ok ? colors.accent : colors.textSecondary}
          />
          <Text style={[styles.body, styles.flex, { color: colors.textPrimary }]}>
            {placement.text}
          </Text>
        </View>
        {form.lat !== null && form.lon !== null && (
          <Text style={[styles.caption, { color: colors.textSecondary }]}>
            {`${form.lat.toFixed(5)}, ${form.lon.toFixed(5)}`}
          </Text>
        )}
        <Pressable
          onPress={useMyLocation}
          accessibilityRole="button"
          accessibilityLabel="Use my location"
          style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={glyphSizes.md} color={colors.accent} />
          <Text style={[styles.inlineButtonText, { color: colors.accent }]}>
            {position ? 'Use my location' : gpsStatus === 'acquiring' ? 'Finding you…' : 'Use my location'}
          </Text>
        </Pressable>
        {showErrors && !placement.ok ? errorText(placement.text) : null}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Name</Text>
        <TextInput
          style={inputStyle}
          value={form.name}
          onChangeText={(v) => update('name', v)}
          maxLength={USER_WAYPOINT_LIMITS.nameMaxLength}
          placeholder="e.g. Spring below the saddle"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Name"
        />
        {errorText(fieldMessage('name'))}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>What is it?</Text>
        <ChoiceChips
          choices={WAYPOINT_TYPE_CHOICES}
          selected={form.type}
          onSelect={(v) => update('type', v as WaypointForm['type'])}
          accessibilityLabel="Waypoint type"
        />
        {errorText(fieldMessage('type'))}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Note (optional)</Text>
        <TextInput
          style={[inputStyle, styles.multiline]}
          value={form.description}
          onChangeText={(v) => update('description', v)}
          maxLength={USER_WAYPOINT_LIMITS.descriptionMaxLength}
          multiline
          textAlignVertical="top"
          placeholder="What is here, how reliable it is, how to find it"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Note"
        />
        {errorText(fieldMessage('description'))}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Who can see it</Text>
        {shareable ? (
          <ChoiceChips
            choices={VISIBILITY_CHOICES}
            selected={form.visibility}
            onSelect={(v) => update('visibility', v as UserWaypointVisibility)}
            accessibilityLabel="Who can see it"
          />
        ) : null}
        <Text style={[styles.caption, { color: colors.textSecondary }]}>
          {!shareable
            ? 'Kept on this phone. Waypoints can be shared on the built-in trails only.'
            : form.visibility === 'shared'
              ? 'Shared with every Tracknotes hiker on this trail, under your display name. Anyone can report a shared waypoint, and reported ones are reviewed.'
              : 'Kept on this phone only. Nobody else sees it.'}
        </Text>
        {existing?.visibility === 'shared' && form.visibility === 'private' ? (
          <Text style={[styles.caption, { color: colors.textSecondary }]}>
            Saving removes it from other hikers’ guides.
          </Text>
        ) : null}
      </View>

      {needsName && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Your display name</Text>
          <TextInput
            style={inputStyle}
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            placeholder="Shown as who shared the waypoint"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Your display name"
            autoCorrect={false}
          />
          {errorText(displayNameError)}
        </View>
      )}

      {errorText(failure)}

      <Pressable
        onPress={() => void onSave()}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel="Save waypoint"
        accessibilityState={{ disabled: saving }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: saving ? colors.accentMuted : colors.accent },
          pressed && styles.pressed,
        ]}
      >
        {saving ? (
          <ActivityIndicator color={colors.accentText} />
        ) : (
          <Text style={[styles.buttonText, { color: colors.accentText }]}>Save waypoint</Text>
        )}
      </Pressable>

      {existing ? (
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={[styles.secondaryText, { color: colors.danger }]}>Delete waypoint</Text>
        </Pressable>
      ) : null}

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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  flex: { flex: 1 },
  body: { ...typography.bodySmall },
  caption: { ...typography.caption },
  field: { gap: spacing.sm },
  label: { ...typography.caption },
  input: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  multiline: { minHeight: 100 },
  error: { ...typography.caption },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  positionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inlineButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start' },
  inlineButtonText: { ...typography.titleSmall },
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
