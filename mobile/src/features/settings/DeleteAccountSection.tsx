/**
 * Account deletion for Settings — the exit door for the comment identity.
 *
 * A Tracknotes identity is created silently on first post (no signup screen), so
 * the only place a user can get rid of it is here. `DELETE /v1/me` soft-deletes
 * everything they posted, drops their photos and kills the token; the local half
 * (own comments + the outbox) is purged by `identity-store.deleteAccount`.
 *
 * Only shown to a `registered` device: an anonymous install has nothing on the
 * server, and offering "delete account" to someone with no account is noise.
 * Deletion needs the network — a failure keeps the account and says so inline
 * rather than pretending it worked, because the copy promises the comments are
 * gone everywhere.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { isApiConfigured } from '../../api/client';
import { apiErrorMessage } from '../../api/error-message';
import { useIdentityStore } from '../../state/identity-store';

/** Fallback copy when a deletion fails for a reason we can't be specific about. */
export const DELETE_FAILED_MESSAGE = "Couldn't delete your account. Please try again.";

export function DeleteAccountSection() {
  const { colors } = useTheme();
  const status = useIdentityStore((s) => s.status);
  const deleteAccount = useIdentityStore((s) => s.deleteAccount);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same async keystore read as DisplayNameSection — both are cheap and
  // idempotent, and whichever mounts first wins.
  useEffect(() => {
    void useIdentityStore
      .getState()
      .hydrate()
      .catch(() => undefined);
  }, []);

  const openConfirm = useCallback(() => {
    setError(null);
    setConfirming(true);
  }, []);

  const cancelConfirm = useCallback(() => {
    if (busy) return;
    setConfirming(false);
  }, [busy]);

  const confirmDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      // Status flips to 'anonymous', so the section unmounts itself; closing the
      // modal first keeps it from being torn down mid-animation.
      setConfirming(false);
    } catch (err) {
      // The store commits nothing on failure, so the account still stands.
      setError(apiErrorMessage(err, DELETE_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }, [busy, deleteAccount]);

  // Still reading the keystore, no identity to delete, or a build with no
  // comments server to delete it from.
  if (status !== 'registered') return null;
  if (!isApiConfigured()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Delete account</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Deleting your account removes the comments and photos you’ve posted, everywhere —
          including from other hikers’ apps. This can’t be undone.
        </Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Your favourites, saved routes and downloaded maps stay on this device.
        </Text>

        {/* While the confirmation is open the same message is repeated inside the
            modal, which is what the user is actually looking at. */}
        {error && !confirming ? (
          <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={openConfirm}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          hitSlop={spacing.xs}
          style={[styles.action, styles.dangerAction, { borderColor: colors.danger }]}
        >
          <Text style={[styles.actionLink, { color: colors.danger }]}>Delete account</Text>
        </Pressable>
      </View>

      <Modal
        visible={confirming}
        transparent
        animationType="fade"
        onRequestClose={cancelConfirm}
      >
        <View style={[styles.modalBackdrop, { backgroundColor: colors.scrim }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.surfaceElevated }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Delete account?</Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              Your comments and photos will be removed for everyone. This can’t be undone.
            </Text>
            {error ? (
              <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable
                onPress={cancelConfirm}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel account deletion"
                hitSlop={spacing.xs}
                style={styles.action}
              >
                <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void confirmDelete()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Delete account permanently"
                accessibilityState={{ disabled: busy }}
                hitSlop={spacing.xs}
                style={[
                  styles.action,
                  styles.confirmAction,
                  { backgroundColor: colors.danger },
                  busy && styles.disabled,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.dangerText} />
                ) : (
                  <Text style={[styles.actionLink, { color: colors.dangerText }]}>
                    Delete permanently
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  hint: { ...typography.bodySmall },
  error: { ...typography.bodySmall },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  dangerAction: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xs,
  },
  confirmAction: { paddingHorizontal: spacing.lg },
  disabled: { opacity: 0.5 },
  actionLink: { ...typography.titleSmall },

  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  modalCard: { width: '100%', borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md },
  modalTitle: { ...typography.titleLarge },
  modalHint: { ...typography.bodySmall },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
