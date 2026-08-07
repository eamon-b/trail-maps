/**
 * Account section for Settings — view and change the comment display name.
 *
 * The first-post prompt tells the user they can change their name "later in
 * Settings", so this is where that promise is kept (`PATCH /v1/me` via
 * `identity-store.rename`). Identity lives in the OS keystore, so the section
 * hydrates on mount and renders nothing until it knows which state it is in:
 *
 *   registered → current name + an inline editor
 *   anonymous  → one explanatory line (registration happens on first post, not
 *                here — a name with no comment attached is pointless)
 *
 * A rename is the one blocking network call in Settings, so failures show
 * inline and leave the previous name in place.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { isApiConfigured } from '../../api/client';
import { apiErrorMessage } from '../../api/error-message';
import { useIdentityStore } from '../../state/identity-store';
import {
  MAX_DISPLAY_NAME_LENGTH,
  validateDisplayName,
} from '../comments/display-name';

/** Fallback copy when a rename fails for a reason we can't be specific about. */
export const RENAME_FAILED_MESSAGE = "Couldn't save your display name. Please try again.";

export function DisplayNameSection() {
  const { colors } = useTheme();
  const status = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);
  const rename = useIdentityStore((s) => s.rename);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identity lives in secure storage, so it has to be read asynchronously. A
  // failed read just leaves the status 'unknown' (section stays hidden) rather
  // than throwing into an unhandled rejection.
  useEffect(() => {
    void useIdentityStore
      .getState()
      .hydrate()
      .catch(() => undefined);
  }, []);

  const startEditing = useCallback(() => {
    setDraft(session?.displayName ?? '');
    setError(null);
    setEditing(true);
  }, [session]);

  const cancelEditing = useCallback(() => {
    if (busy) return;
    setEditing(false);
    setError(null);
  }, [busy]);

  const save = useCallback(async () => {
    if (busy) return;
    const check = validateDisplayName(draft);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    if (check.value === session?.displayName) {
      setEditing(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rename(check.value);
      setEditing(false);
    } catch (err) {
      // The store only commits on success, so the previous name still stands.
      setError(apiErrorMessage(err, RENAME_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, rename, session]);

  // Still reading the keystore, or a build with no comments server and no
  // identity to show.
  if (status === 'unknown') return null;
  if (status === 'anonymous' && !isApiConfigured()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Account</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        {status === 'anonymous' || !session ? (
          <>
            <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Display name</Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              You’ll choose a display name when you post your first comment.
            </Text>
          </>
        ) : editing ? (
          <>
            <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Display name</Text>
            <TextInput
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                setError(null);
              }}
              placeholder="e.g. Trail Ghost"
              placeholderTextColor={colors.textSecondary}
              autoFocus
              editable={!busy}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              accessibilityLabel="Display name"
            />
            {error ? (
              <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                onPress={cancelEditing}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                hitSlop={spacing.xs}
                style={styles.action}
              >
                <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void save()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Save display name"
                accessibilityState={{ disabled: busy }}
                hitSlop={spacing.xs}
                style={[
                  styles.action,
                  styles.saveAction,
                  { backgroundColor: colors.accent },
                  busy && styles.disabled,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={[styles.actionLink, { color: colors.accentText }]}>Save</Text>
                )}
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Display name</Text>
              <Text style={[styles.rowValue, { color: colors.textPrimary }]} numberOfLines={1}>
                {session.displayName}
              </Text>
            </View>
            <Pressable
              onPress={startEditing}
              accessibilityRole="button"
              accessibilityLabel="Edit display name"
              hitSlop={spacing.sm}
              style={styles.action}
            >
              <Text style={[styles.actionLink, { color: colors.accent }]}>Edit</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  label: { ...typography.titleLarge },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowMain: { flex: 1, gap: spacing.xs },
  rowLabel: { ...typography.caption },
  rowValue: { ...typography.body },
  hint: { ...typography.bodySmall },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    minHeight: touchTarget.min,
    ...typography.body,
  },
  error: { ...typography.bodySmall },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  saveAction: { paddingHorizontal: spacing.lg },
  disabled: { opacity: 0.5 },
  actionLink: { ...typography.titleSmall },
});
