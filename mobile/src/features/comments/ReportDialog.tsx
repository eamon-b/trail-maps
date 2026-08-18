/**
 * Report-a-comment dialog: pick one of the four wire reasons, optionally add a
 * short detail, send.
 *
 * Reporting is offline-first (`submitReport` enqueues and drains), so the only
 * hard network dependency is registering the device when the reporter has never
 * posted — reports are authenticated. That mirrors the composer's first-post
 * prompt: submitting while unregistered swaps the card to a display-name step,
 * and `onSubmit` receives the typed name so the caller can register-then-report.
 * Like the composer, a failed submit keeps the dialog open with an inline
 * message rather than swallowing the rejection.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ReportReason } from '@lib/comments-api-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { apiErrorMessage } from '../../api/error-message';
import { MAX_DISPLAY_NAME_LENGTH, validateDisplayName } from './display-name';
import {
  MAX_REPORT_DETAIL_LENGTH,
  REPORT_REASONS,
  reportReasonLabel,
  validateReport,
} from './report-comment';

/** Fallback copy when the failure isn't something we can be specific about. */
export const REPORT_FAILED_MESSAGE = "Couldn't send your report. Please try again.";

export interface ReportSubmitArgs {
  reason: ReportReason;
  detail: string | null;
  /** Set only on the first report from an unregistered device. */
  displayName?: string;
}

export function ReportDialog({
  commentId,
  registered,
  onCancel,
  onSubmit,
}: {
  commentId: string;
  registered: boolean;
  onCancel: () => void;
  onSubmit: (args: ReportSubmitArgs) => Promise<void>;
}) {
  const { colors } = useTheme();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Never rejects: a failed submit becomes inline error state with the chosen
  // reason (and typed name) intact, so retrying is one tap.
  const finish = useCallback(
    async (displayName?: string) => {
      const check = validateReport({ commentId, reason, detail });
      if (!check.ok) {
        setError(check.message);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await onSubmit({ reason: check.value.reason, detail: check.value.detail, displayName });
      } catch (err) {
        setError(apiErrorMessage(err, REPORT_FAILED_MESSAGE));
      } finally {
        setBusy(false);
      }
    },
    [commentId, reason, detail, onSubmit],
  );

  const handleReport = useCallback(() => {
    if (busy) return;
    if (reason === null) {
      setError('Choose a reason.');
      return;
    }
    if (!registered) {
      setError(null);
      setNeedsName(true);
      return;
    }
    void finish();
  }, [busy, reason, registered, finish]);

  const savePromptedName = useCallback(() => {
    if (busy) return;
    const check = validateDisplayName(nameDraft);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    void finish(check.value);
  }, [busy, nameDraft, finish]);

  const errorText = error ? (
    <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
      {error}
    </Text>
  ) : null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onCancel();
      }}
    >
      <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
        <View style={[styles.card, { backgroundColor: colors.surfaceElevated }]}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>Report this comment</Text>

          {needsName ? (
            <>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                Choose a display name to report. It’s shown next to any comments you post.
              </Text>
              <TextInput
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
                placeholder="e.g. Trail Ghost"
                placeholderTextColor={colors.textSecondary}
                value={nameDraft}
                onChangeText={(next) => {
                  setNameDraft(next);
                  setError(null);
                }}
                autoFocus
                editable={!busy}
                maxLength={MAX_DISPLAY_NAME_LENGTH}
              />
            </>
          ) : (
            <>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                Reports go to the moderators. The author isn’t told who reported them.
              </Text>
              {REPORT_REASONS.map((option) => {
                const active = reason === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => {
                      setReason(option);
                      setError(null);
                    }}
                    disabled={busy}
                    accessibilityRole="radio"
                    accessibilityLabel={`Reason: ${reportReasonLabel(option)}`}
                    accessibilityState={{ selected: active, checked: active }}
                    style={[
                      styles.reason,
                      { borderColor: active ? colors.accent : colors.border },
                      active && { backgroundColor: colors.surface },
                    ]}
                  >
                    <Text
                      style={[
                        styles.reasonText,
                        { color: active ? colors.textPrimary : colors.textSecondary },
                      ]}
                    >
                      {reportReasonLabel(option)}
                    </Text>
                  </Pressable>
                );
              })}
              <TextInput
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
                placeholder="Anything else we should know? (optional)"
                placeholderTextColor={colors.textSecondary}
                value={detail}
                onChangeText={(next) => {
                  setDetail(next);
                  setError(null);
                }}
                multiline
                editable={!busy}
                maxLength={MAX_REPORT_DETAIL_LENGTH}
              />
            </>
          )}

          {errorText}

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Cancel report"
              style={styles.button}
            >
              <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={needsName ? savePromptedName : handleReport}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={
                needsName ? 'Save display name and report' : 'Send report'
              }
              style={[styles.button, styles.send, { backgroundColor: colors.accent }]}
            >
              {busy ? (
                <ActivityIndicator color={colors.accentText} />
              ) : (
                <Text style={[styles.sendText, { color: colors.accentText }]}>
                  {error ? 'Try again' : needsName ? 'Save & report' : 'Report'}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm },
  title: { ...typography.titleLarge },
  hint: { ...typography.bodySmall },
  reason: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  reasonText: { ...typography.body },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    padding: spacing.md,
    minHeight: 64,
    ...typography.body,
    textAlignVertical: 'top',
  },
  error: { ...typography.bodySmall },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  button: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.sm },
  send: { minWidth: 44, alignItems: 'center' },
  sendText: { ...typography.titleSmall },
  actionLink: { ...typography.titleSmall },
});
